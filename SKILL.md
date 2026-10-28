---
name: spec-forge
description: Use this skill whenever the user asks to implement a feature, fix a bug, refactor code, change an API, or make any code change that should go through a multi-step pipeline instead of being implemented ad hoc. Acts as a thin orchestrator that calls the deterministic scheduler to decide each next action, dispatches the corresponding agent via the Task tool, then calls the CLI to persist the outcome, looping until the pipeline is done or fails. Works identically in ANY IDE (Claude Code, TRAE, Cursor, etc.) — no hooks required.
---

# spec-forge

## Role

You are a **thin orchestrator**. You do not make pipeline decisions or write `state.json` directly — always call the CLI.

- All decisions come from `scripts/scheduler.cjs`
- Outcome 状态变更经 `scripts/cli.cjs update` 持久化（`scheduler.cjs` 亦就地标记 IN_PROGRESS/stale 并写回 state）
- You explicitly call CLI scripts (no hooks). A pipeline started in one IDE can be resumed in any other via `cli.cjs resume --ts=<TS>`.

Pipeline (job-dag-pipeline): `spec-check -> task-decompose -> baseline-regression -> implementation (flat job DAG: jobs coding parallel via depends_on) -> verification (testing -> review -> regression -> fix loop) -> evidence-verify`

- `spec-check` / `task-decompose` / `baseline-regression` / `evidence-verify` are agent-dispatched global stages. `implementation` and `verification` are composite stages (no direct dispatch): `implementation` holds the flat job DAG, `verification` runs the post-implementation loop.
- `baseline-regression` runs the full build+test BEFORE any code is written; if it does not pass, the pipeline terminates (the project was already broken).
- **Flat job DAG (ALL languages)**: `implementation` holds a flat `jobs[]` list; each job performs ONLY `coding`, ordered by an acyclic `depends_on` graph. The scheduler dispatches dependency-ready jobs in parallel, up to a concurrency cap (default 5; `SPEC_FORGE_MAX_CONCURRENCY` overrides, 0 = unlimited). No waves, no rounds, no per-wave testing/review/fix, no cross-wave serialization gate.
- Each job performs **ONLY** `coding` (agent `implementer`). Verification is NOT per-wave: a single global `verification` composite stage runs over the whole change set after all jobs' coding PASS.
- `verification` sub-stages are `testing -> review -> regression` plus a `fix` loop-back: testing=test-generator (global `test-manifest.json`), review=code-reviewer (global `review-report.md`), regression=regression-runner (full build+test), fix=fixer.
- `verification` loop: each round `{testing, review, regression, fix}` (current = `rounds[last]`). testing FAIL -> mark review+regression SKIPPED -> fix; review FAIL -> mark regression SKIPPED -> fix; regression FAIL -> fix; regression PASSED/WARN -> mark fix SKIPPED (no fix dispatch); fix PASS/FAILED -> archive round -> next round's testing; fix WARN -> soft pass (verification WARN). Uniform cap `max_retries` fix rounds (any sub-stage failure counts; exhausted -> mark fix SKIPPED, verification FAILED).

## Workflow

> `${SKILL_DIR}` denotes the absolute path to this skill's directory (the directory containing this `SKILL.md`). Resolve it once from the skill's base directory and substitute it verbatim in every command below — do not use a relative path.

### Step 0: Initialize

**默认：全新 pipeline，从头开始。** 不要分析或续跑旧的未完成 ts。

```bash
node ${SKILL_DIR}/scripts/cli.cjs init
```

`init --ts=<TS>` 可显式指定 TS 新建 pipeline（该 TS 已存在时报错，需改用 `resume`）。

**仅当用户明确要求「继续上次 / 续跑」时**，才恢复已有 pipeline：

```bash
node ${SKILL_DIR}/scripts/cli.cjs resume --ts=<TS>    # resume (state.json must exist)
```

**自动提交（opt-in）**：若用户以 `/spec-forge --auto-commit` 调用（或要求「跑完自动 commit」），把旗标透传给 `init`：

```bash
node ${SKILL_DIR}/scripts/cli.cjs init --auto-commit
# resume + auto-commit:
node ${SKILL_DIR}/scripts/cli.cjs resume --ts=<TS> --auto-commit
```

Capture `ts` from JSON output. **把它原样传给后续每一个 `scheduler` / `update` / `report` / `commit` 调用（`--ts=<TS>`）** —— 脚本不再读全局 `.active` 指针，TS 完全由主 agent 显式传递（description 里的 `TS=…` 可作 update 的兜底；commit 未传 `--ts` 时回退到 session marker）。Proceed to Step 1.

### Step 1: Scheduler loop

Repeat until scheduler returns `done` or `fail`:

```bash
node ${SKILL_DIR}/scripts/scheduler.cjs --ts=<TS>   # outputs JSON instruction to stdout
```

Act on `instruction.action`:

#### `dispatch` / `retry`

Dispatch the agent via `Task` tool:
- `description`: **copy verbatim** from `instruction.description` (contains `TS=... GLOBAL=...` / `TS=... JOB=... STAGE=coding` / `TS=... GLOBAL=verification STAGE=...` tags — CLI parses them; never rewrite)
- `query`: Use this template (**do NOT read agent .md files yourself** — let the agent read them):

```
You are dispatched as the `{instruction.agent}` role in the spec-forge pipeline.

FIRST, Read your role definition file `${SKILL_DIR}/agents/{instruction.agent}.md` (everything after the YAML frontmatter) and follow it as your operating contract.

THEN execute this task:
--- env ---
SKILL_DIR: {skill directory absolute path}
PROJECT_DIR: {project root absolute path}
TS: {instruction.ts}
--- end env ---
--- prompt_hint ---
{instruction.prompt_hint}
--- end prompt_hint ---
--- job details ---         (only for job-scope dispatch; omit for global/verification)
{instruction.job_details as JSON}
--- end job details ---
--- user request ---
{user's original request}
--- end user request ---
```

`SKILL_DIR` and `PROJECT_DIR` are absolute paths injected by the orchestrator — use them verbatim to resolve `rules/security.md`, `rules/testing.md`, and project files. Do NOT re-discover these paths.

For `retry`, prefix the query with:
```
RETRY attempt {instruction.attempt}. Previous run reason: {instruction.reason}.
Please address the failure and produce a clean result.
```

After Task returns, **immediately** call `cli.cjs update` (Step 2) before looping.

#### `dispatch` / `retry` (streaming)

The scheduler marks the dispatched stage (job coding or verification testing/review/regression/fix) as `IN_PROGRESS` before returning, so it is safe to call the scheduler again while a Task is still in flight.

**Dispatch the agent via `Task`**, then:
1. When a Task returns, call `cli.cjs update` for it immediately, then re-call the scheduler.
2. The scheduler may return:
   - `dispatch` / `dispatch_batch` / `retry` — new actions ready to run. Issue them as new `Task`s (in the same message or the next).
   - `wait` — no new dispatch possible (in-flight Tasks block progress). Wait for one to return.
   - `done` / `fail` — only when all stages are terminal.

The scheduler collects **all** currently-parallelizable actions in a single call — all dependency-ready coding dispatches — and returns them together as one `dispatch_batch`. Issue all Tasks in one message.

This enables **job-DAG parallelism**: dependency-ready jobs code concurrently, up to a concurrency cap (default 5; `SPEC_FORGE_MAX_CONCURRENCY` overrides, 0 = unlimited).

**Example (J1, J2 ready; J3 depends on J1)**:
```
scheduler → dispatch_batch [J1 coding, J2 coding] (both marked IN_PROGRESS)
  [J1 coding Task and J2 coding Task run concurrently]
J1 coding returns → update → re-call scheduler → dispatch J3 coding (J1 dep now PASSED)
J2 coding returns → update → re-call scheduler → wait (J3 still in flight)
```

#### `dispatch_batch` (parallel, streaming)

`instruction.dispatches[]` is an array of `dispatch`/`retry` instructions, one per dependency-ready job-coding dispatch. The scheduler marks every dispatched stage as `IN_PROGRESS` before returning, so it is safe to call the scheduler again while Tasks are still in flight.

**Dispatch ALL in parallel** — issue multiple `Task` calls in a **single message** (one per dispatch, each with its own verbatim `description`).

**Streaming updates** — do NOT wait for all Tasks to return. As soon as **any** Task returns:
1. Call `cli.cjs update` for that result immediately (serial — `state.json` is shared).
2. Re-call the scheduler. It may return:
   - `dispatch` / `dispatch_batch` — a downstream job whose deps are now PASSED. Issue it as a new `Task` immediately.
   - `wait` — no new dispatch possible (other Tasks still in flight). Continue waiting.
   - `done` / `fail` — only when all jobs are terminal.
3. Continue until every Task from the original batch AND any streaming-spawned Tasks have been updated or terminally failed, and the scheduler returns `wait`/`done`/`fail`.

This enables **pipeline parallelism**: a fast job can unblock its downstream job while slow jobs are still coding.

#### `wait`

The scheduler has no new dispatch to issue. This is **expected** in streaming mode when a Task is still in flight — wait for the in-flight Task to return, then `update` and re-call the scheduler. Only report a stall to the user if `wait` persists AND no Tasks are in flight.

#### `done` / `fail`

Exit loop -> Step 3.

#### Output-truncation recovery (after every Task returns)

After a Task returns, before calling `update`, detect truncation if **any** of:
1. Response contains `输出过长` / `请输入` / `「继续」`
2. No `HANDOFF_BEGIN...HANDOFF_END` block when one was expected
3. Handoff file missing, invalid JSON, or missing `decision` field
4. `cli.cjs update` returns non-zero or unexpected `marker_outcome`

**Recovery** (do not loop on same dispatch):
1. Log truncation to `pipeline.log`
2. Re-dispatch with compressed prompt prefix:
   ```
   RETRY (output-truncation recovery). Your previous response was truncated.
   STRICT OUTPUT BUDGET:
   - ALL source code via Write/Edit tool only. NEVER paste code in text.
   - No file echoes, no git diff transcript. Only one-line summaries.
   - Emit HANDOFF_BEGIN { ... } HANDOFF_END as the last block.
   Resume from where you left off.
   ```
3. If compressed retry also truncates -> dispatch `task-decomposer` with auto-split request
4. **Hard cap**: 2 compressed retries + 1 auto-split per job (or per verification-stage dispatch)

**In `dispatch_batch`**: handle each Task independently. Successful Tasks proceed to `update` normally (streaming — no need to wait for siblings); truncated Tasks recover in isolation. After each `update`, re-call the scheduler to check for newly-unblocked dispatches.

**Do NOT** ask user to type "继续". Pipeline self-recovers.

### Step 2: State update (CRITICAL)

After **every** Task returns, call `cli.cjs update`:

```bash
node ${SKILL_DIR}/scripts/cli.cjs update \
  --ts=<TS> \
  --agent=<instruction.agent> \
  --description="<instruction.description>" \
  --output-file=specs/{TS}/handoff-<scope>.json
```

`--ts` 可选但建议显式传：缺省时从 `--description` 的 `TS=…` 提取，两者同时给出会交叉校验（不一致直接报错）。

(Or pipe via stdin / `--output="<text>"`. On Windows PowerShell, prefer `--output-file=<tempfile>` for multi-line text.)

The agent must write the handoff JSON file whose name encodes its scope:
- **Global**: `specs/{TS}/handoff-<agent-name>.json` (e.g. `handoff-spec-checker.json`, `handoff-task-decomposer.json`, `handoff-evidence-verifier.json`；baseline-regression 例外——按 stage 名 `handoff-baseline-regression.json`)
- **Job** (coding only): `specs/{TS}/handoff-<jobId>-coding.json`
- **Verification** (global): `specs/{TS}/handoff-verification-<stage>.json` (e.g. `handoff-verification-testing.json`, `handoff-verification-review.json`, `handoff-verification-fix.json`)
- **Content manifests** (required gate, not just pass/fail): job `coding` writes `specs/{TS}/coding-manifest-<jobId>.json` (changed_files + symbols); verification `testing` writes `specs/{TS}/test-manifest.json` (test_files + acceptance_criteria AC→test trace + summary). `cli.cjs update` validates each manifest (exists + parseable + key identity fields) and FAILs the stage if missing.

```json
{ "decision": "PASS|FAIL|APPROVE|WARN|BLOCK|...",
  "artifacts": [{"path": "/abs"}],
  "markers": {"<name>": "<value>"},
  "summary": "..." }
```
Agent should also emit `HANDOFF_BEGIN...HANDOFF_END` block in response text (fallback if file missing).

Verify exit code = 0 and `marker_outcome` = `PASSED` before looping back to scheduler. (For verification `review`, APPROVE/WARN map to PASSED and BLOCK maps to FAILED; for verification `fix`, PASS maps to PASSED and FAIL maps to FAILED.)

### Step 3: Report

```bash
node ${SKILL_DIR}/scripts/cli.cjs report --ts=<TS>
```

Summarize to user: pipeline status (COMPLETE/FAILED/IN_PROGRESS), per-stage status, per-job coding status, verification status (testing/review/regression/fix), job outcomes, completion gate, artifacts produced.

### Step 4: Auto-commit (automatic on completion — manual retry only)

If the loop ended with `fail`, skip this step entirely.

When the pipeline completes (the `update` that flipped the last stage to PASSED/WARN), the CLI **automatically commits** — if `--auto-commit` was set at `init`/`resume`, the final `update` response includes a `commit` field:

```json
{ "ok": true, "ts": "...", ..., "commit": { "ok": true, "committed": true, "hash": "..." } }
```

The auto-commit message falls back to `spec.md`'s `### Title` (deterministic). You do **not** need to run `commit` yourself when it succeeded.

Only retry manually if the automatic commit was `skipped` or `error` (e.g. `nothing-to-commit` is fine — no source changes; `error` means git failed):

```bash
node ${SKILL_DIR}/scripts/cli.cjs commit --check --ts=<TS>   # → { "enabled": bool, "completed": bool }
```

If `enabled` is `false`, skip. If `enabled` is `true`:

1. Read the requirement from `specs/{TS}/spec.md` (`### Title` + `### User Story`) and the diff in the target repo (`git diff --stat` and `git diff`, truncated if large).
2. Compose a conventional-commit message — subject `feat:`/`fix:`/`refactor:`/`docs:` + one-line summary; body ties the change to the diff.
3. Commit deterministically (the CLI stages only pipeline-changed source files, excludes `specs/`, appends the `Generated-by: spec-forge` trailer, never pushes):

```bash
node ${SKILL_DIR}/scripts/cli.cjs commit --message="<message>" --ts=<TS>
```

   If message generation fails or produces nothing, call without `--message` — the CLI falls back to a deterministic message from `spec.md`'s `### Title`.

4. This commit is **best-effort**: it never flips a PASSED pipeline to FAILED, and a manual retry after a successful auto-commit is a no-op (`already-committed`). Report the result to the user (`committed: <hash>` or `commit skipped: <reason>`).

## Scheduler Contract

| action | scope | key fields | meaning |
|--------|-------|------------|---------|
| `dispatch` | global | `stage`, `agent`, `description`, `prompt_hint` | Dispatch global-stage agent |
| `dispatch` | job | `job_id`, `stage` (=coding), `agent` (=implementer), `description`, `job_details`, `prompt_hint` | Dispatch one job's `coding` stage |
| `dispatch_batch` | job | `dispatches[]`, `count`, `summary` | Parallel dispatch of `coding` for dependency-ready jobs, up to the concurrency cap (default 5) |
| `dispatch` | verification | `sub_stage` (testing/review/regression/fix), `agent`, `description`, `prompt_hint` | Dispatch one verification sub-stage (covers the whole change set) |
| `retry` | global/job/verification | same + `attempt`, `reason` | Re-dispatch failed/stale stage |
| `wait` | — | `reason` | Waiting on in-progress work (e.g. a dependency job not yet PASSED, or a stage IN_PROGRESS) |
| `done` | — | `summary` | All global stages PASSED/WARN (all jobs + verification PASSED/WARN) |
| `fail` | — | `reason`, `stage?`, `job_id?` | Terminal failure |

**Description format** (copy verbatim into Task `description`):
- Global: `TS={ts} GLOBAL={stage-name}`
- Job: `TS={ts} JOB={job-id} STAGE=coding` (no `WAVE=`)
- Verification: `TS={ts} GLOBAL=verification STAGE={testing|review|regression|fix}`

## Job-DAG Pipeline Flow

**Decoupled coding/verification**: job coding runs during `implementation`; the single global `verification` loop runs once after ALL jobs' coding PASS. Coding and verification never overlap.

### Coding (flat job DAG, parallel via `depends_on`)

- `implementation` holds a flat `jobs[]` list; each job performs **ONLY** `coding` (agent `implementer`).
- A job's `coding` starts when all its `depends_on` deps have coding PASSED.
- The `depends_on` graph must be acyclic; the scheduler rejects cyclic manifests (new cycle detection).
- Dependency-ready jobs are dispatched in a `dispatch_batch`, bounded by the concurrency cap (default 5; `SPEC_FORGE_MAX_CONCURRENCY` overrides, 0 = unlimited).
- Each job's `coding` also writes `specs/{TS}/coding-manifest-<jobId>.json` describing what it implemented (changed files + symbols; required gate).

### Verification (global, single pass after all coding)

After `implementation` completes (all jobs' coding PASSED/WARN), the `verification` composite stage runs once over the whole change set:

1. **`testing`**: test-generator writes `handoff-verification-testing.json` and the global `test-manifest.json` (AC→test trace; required gate).
   - PASS -> `review`; FAIL -> `fix` (review + regression skipped).
2. **`review`**: code-reviewer writes `handoff-verification-review.json` and the global `review-report.md`.
   - APPROVE/WARN -> `regression`; FAIL/BLOCK -> `fix` (regression skipped).
3. **`regression`**: regression-runner runs the full build+test. PASS -> write `regression-conclusion.md` -> verification PASSED -> proceed to evidence-verify. When the project documents a stress test (a stress command, semantically detectable), the runner deploys the new binary, captures `specs/{TS}/perf-final.json`, and runs `cli.cjs perf-compare` against the baseline — a perf regression (throughput ↓ >10% / p99 ↑ >20% / errorPct ↑) returns WARN, which maps `verification` to WARN (soft pass, no fix loop).
   - FAIL -> `fix`.
4. **`fix`**: fixer writes `handoff-verification-fix.json`. If it judges the failure is non-code (flaky/environment), it returns WARN -> `verification` becomes WARN (soft pass). Otherwise it fixes and returns PASS.
   - PASS -> reset -> back to `testing` (full re-verification).
   - WARN -> soft pass (verification WARN) -> proceed to evidence-verify.
   - FAIL -> retry (if budget remains) or verification FAILED -> pipeline halts with `fail`.

Cap: 2 fix rounds.

### baseline-regression (pre-coding)

After `task-decompose`, `baseline-regression` dispatches `regression-runner` to run the full build+test on the unmodified code. FAIL -> terminate the pipeline (write `baseline-regression-report.md`); PASS -> proceed to `implementation`. When the project documents a stress test (a stress command, semantically detectable), the runner also deploys the freshly-built unmodified binary and captures a performance baseline snapshot (`specs/{TS}/perf-baseline.json`) — deploy failure is a hard FAIL; perf measurement failure is best-effort (skipped).

## Other CLI commands

```bash
node ${SKILL_DIR}/scripts/cli.cjs report [--ts=<TS>] [--latest] [--json]   # jobs array included in --json; --latest = newest TS dir by mtime (crash recovery)
node ${SKILL_DIR}/scripts/cli.cjs verify <path1> <path2> ... | --handoff=<path>
node ${SKILL_DIR}/scripts/cli.cjs perf-compare --baseline=<path> --final=<path> [--thresholds=<json>]
node ${SKILL_DIR}/scripts/cli.cjs commit [--message=<text>] [--check] [--ts=<TS>]   # auto-commit (triggered automatically on completion; this is a manual retry, best-effort)
```

## Progress bar (optional, Claude Code statusline)

`scripts/progress.cjs` renders a **flow-light** progress bar (no percentages) straight from
`<projectRoot>/specs/session-active/<CLAUDE_CODE_SESSION_ID> → specs/{TS}/state.json` — the
session-scoped marker `cli.cjs init` writes for **this** session only, so a fresh session (or a
non-Claude Code process) shows nothing rather than a stale run's progress:

```
sf ✓spec-check 3m12s → ✓task-decompose 1m04s → ✓baseline-regression 2m50s
✓implementation 5m30s → ▸verification 2m10s → ·evidence-verify
jobs: ✓J0-1 3m12s ✓J1-2 2m05s ·J2-3 …
verification r2: ✓testing 1m04s → ▸review 1m06s → ·regression → ·fix
```

- Marks: `PASSED/WARN→✓` `IN_PROGRESS→▸` `PENDING→·` `FAILED→✗` `SKIPPED→⊘` `BLOCKED→⚠` (unknown→`·`; ANSI colors, `--no-color` to disable).
- **Durations** (gray): main-stage durations after each stage name; job coding durations in `jobs:`; verification sub-stage durations in `verification rN:`. Terminal = `completed_at − started_at`; active stage/sub-stage = live elapsed (ticks each 5s refresh). Format `3m12s` / `45s` / `32m`. Missing `started_at` (PENDING, or legacy state) shows nothing.
- **Width-aware wrapping**: the strip wraps token-aware (between ` → `, never mid-stage) to `COLUMNS` (fallback 80). Claude Code's statusline does **not** auto-wrap — an over-wide single line gets truncated (from the right, by same-row notifications) or wraps awkwardly, and it does not re-run on terminal resize. Explicit `\n` rows (one per stdout line) are the supported multi-line mechanism.
- **Persistent detail rows**: `jobs:` shows once implementation holds jobs; `verification rN:` shows once verification starts. Both **stay visible** after their stage finishes — they do not disappear when the active stage moves on. This session not enabled (no marker) → no output, statusline hidden; enabled but unreadable state → `sf …`.
- Never exits non-zero. A session that has **not** enabled spec-forge (no `CLAUDE_CODE_SESSION_ID`, or no `specs/session-active/<session-id>` marker) prints nothing so the statusline stays hidden — a statusline blanks entirely on non-zero exit.

**Enable (one-time, per user or per project):** add to `~/.claude/settings.json` or `.claude/settings.json` in the project root, with `${SKILL_DIR}` replaced by the skill's absolute path:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /abs/path/to/spec-forge/scripts/progress.cjs",
    "refreshInterval": 5,
    "padding": 0
  }
}
```

Notes:

- **No TS / state.json in the config.** `progress.cjs` reads the session-scoped marker `<projectRoot>/specs/session-active/<CLAUDE_CODE_SESSION_ID>` (written by `cli.cjs init` on every new/resumed pipeline), so a new pipeline needs zero reconfiguration.
- **Auto-follow:** without `--project-root`, the script walks up from the session cwd to the nearest `specs/session-active/<CLAUDE_CODE_SESSION_ID>` marker, so launching Claude Code from anywhere inside the project (root or a subdirectory) works with one project-agnostic config. Pass `--project-root=<path>` only when launching Claude Code outside the project tree (e.g. from the skill directory itself).
- `refreshInterval: 5` (seconds) is required for "real-time": event-driven refresh does not fire while the session is idle waiting on an in-flight Task, so without a timer the bar goes stale during coding.
- The statusline only works in Claude Code and is gated by **workspace trust** (untrusted folder → blank bar) and disabled by `disableAllHooks: true`. It is an optional enhancement; the skill itself stays IDE-agnostic.
- Same kernel, other front-ends: have Claude print `node ${SKILL_DIR}/scripts/progress.cjs --no-color` after `cli.cjs update` (in-chat — the command inherits the session id, so it renders), or for a standalone TUI set a session id explicitly: `CLAUDE_CODE_SESSION_ID=<id> watch -n 2 node ${SKILL_DIR}/scripts/progress.cjs` (only renders if `<id>` matches a session that ran `init`).

## Rules

- **Never mutate `state.json` directly** — always via `cli.cjs update`.
- **Never decide the next step yourself** — always call the scheduler.
- **Never rewrite `description`** — copy verbatim; CLI parses `GLOBAL=` / `JOB=` / `STAGE=` tags.
- **Never skip `cli.cjs update`** after a Task returns, even if agent claims success.
- **Parallel dispatch ONLY via `dispatch_batch`** — issue all listed Tasks in one message. (Only job `coding` is batched; verification stages are always single-dispatch.)
- **`cli.cjs update` is always serial** — even after `dispatch_batch`, update one-at-a-time.
- **Verification stages cover the whole change set** — do not split a verification `testing`/`review`/`fix` dispatch into per-job dispatches.
