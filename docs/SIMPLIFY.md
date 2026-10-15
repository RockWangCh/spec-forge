# SIMPLIFY — spec-forge 梳理与精简计划

> 记录 2026-10-12 经 `/grilling` 逐轮对齐后的共享理解与精简方案，作为执行依据与留痕。
> 状态：计划已确认（P1 缩 / P2 不动 / P3 留）。Phase 0–3 全部完成。244 测试全绿（原 244；删 5 个孤儿生命周期测试、新增 5 个 bug/commit 测试，净平）。

## 一、共享理解（背景与结论）

**项目**：spec-forge —— 跨 IDE 的多阶段编码流水线编排 Skill（`navinfo/spec-forge`）。核心不生成业务代码，只做三件事：调度（`scheduler.cjs` 纯函数决策）、持久化（`state.json` + `cli.cjs update` 写口）、分发（主代理经 Task 工具调专项 agent）。流水线：`spec-check → task-decompose → baseline-regression → implementation(扁平 job DAG) → verification(testing→review→regression→fix 循环) → evidence-verify`。

**两个大判断的结论**：

1. **架构是否合理**：核心合理、外围背死重。`scheduler.cjs`（决策）+ `state.cjs`/`store.cjs`（状态）+ `cli.cjs update`（唯一写口）的分离是承重墙，244 个测试守住了「PASSED 不降级 / 原子写 / stale 检测 / 环检测」等不变量。但外围有约 200 行死代码、死配置、死字段、10 处文档漂移、若干真 bug（含一个高置信活锁）。
2. **随 LLM 演化是否必要**：核心必要、外围正被平台吃掉。**耐久的部分**是确定性状态机、任意处 resume、审计留痕、强制不变量、content-manifest 门、独立验证者——一个更聪明的单 agent 补不了「可复现/可恢复/可审计」，Claude Code 原生 Task/hooks 也只给子代理、不给这些。**被吃掉的部分**是并发分发、progress 状态栏、auto-commit、精细的逐门验证仪式。

**实战证据**（`rdpcli-pi` 2026-10-10 那条 run，10 job / 4 层 DAG）：
- ✅ 并行 DAG 真实省钱（J0×3、J1×3+J2-1 两波并行，编码段 41 分钟 vs 串行累加）。
- ✅ `verification.testing` 抓到实现 agent 漏掉的真 bug（SessionCore 手动断开被误判为自发掉线）。
- ℹ️ run 于 52 分钟时被**手动停**（非系统性失败），停时 testing FAILED、fix IN_PROGRESS。
- ⚠️ 野账：state 里 artifacts 大量重复（`{path}` 对象与裸字符串两种形状拼接未去重）；JobEntry `layer`/`files`/`produces` 全空（task-decomposer 的 `files`/`produces` 进 state 时被丢）；绝对路径在项目改名后过期（`test-pi`→`rdpcli-pi`）。

## 二、已确认的决策

| 决策 | 结论 | 依据 |
|------|------|------|
| auto-commit | **缩** | 保留 opt-in 能力；补真实 commit 路径测试；收敛 message 生成；不新增功能 |
| verification 四子阶段 | **本轮不动** | 有完整测试覆盖；已证明 testing 门抓真 bug；粗化是行为变更、风险大。记为下一轮候选 |
| progress.cjs | **留** | 只改文档口径（明确 optional、与核心解耦）；不删 |

## 三、执行清单

> 每项完成后勾选。文件坐标以执行时的源码为准（本表为 2026-10-12 快照）。

### Phase 0 — 追平文档（无风险，先做）

- [x] `CODE_WIKI.md` §4：`schema_version` **7→8**（代码 `state.cjs:201` = 8）。
- [x] `DESIGN.md`：`schema_version` 7→8；`verification` 节点形状 `stages{}`→**`rounds[]`**（§二/§四）。
- [x] `DESIGN.md` §五：并发上限「已删除」与 2026-09-17「重新引入」自相矛盾 → 在 §五标注「已被 2026-09-17 在飞计数方案取代」，不删历史。
- [x] `CODE_WIKI.md` §9：测试清单 `regression.test.cjs`→`verification.test.cjs`；补 `commit.test.cjs`/`progress.test.cjs`/`session.test.cjs`。
- [x] `CODE_WIKI.md` §1 + `SKILL.md` Role：撤销「cli.cjs 是唯一状态入口」绝对表述 → 「scheduler `main()` 亦就地标记 IN_PROGRESS/stale 并写回 state，`cli.cjs update` 是持久化 outcome 的主入口」。
- [x] `CODE_WIKI.md`：`STALE_MS`→`DEFAULT_STALE_MS`；§2 文件职责表删 store.cjs 的「active 指针」（已移除）。
- [x] `SKILL.md` handoff 命名：baseline-regression 的 handoff 按 **stage 名**（`handoff-baseline-regression.json`），非 agent 名（`handoff-regression-runner.json`）——修正「Global: handoff-<agent-name>.json」的表述。
- [x] `CODE_WIKI.md` §10：`DEFAULT_RETRY_POLICY` 的 `job_max_retries` 是死配置 → 标注仅 `global_max_retries` 生效。
- [x] `SKILL.md` progress 段 + 相关：明确 progress.cjs 为 optional、与核心解耦（配合 P3）。
- [x] `docs/state.json`：v6 `wave-pipeline` 样例已过期 → 标注为历史样例或重生成 v8 样例。

### Phase 1 — 删死代码 / 死配置 / 死字段（低风险，测试兜底）

> 均已在 config.cjs 之外复核为零引用（2026-10-12）。

- [x] **project-detection 子系统**（`config.cjs` ~368-559）：`detectProjectType` / `getTestCommands` / `getBuildCommands` / `findMatchingRule` + `DEFAULT_PROJECT_DETECTION_RULES`；顺带 `isWindows` / `truncateCommand` 若仅被它用。保留 `getPlatformShellNote`（`scheduler.cjs:691,720` 在用）。
- [x] **`GLOBAL_STAGE_REQUIREMENTS` 死字段**（`config.cjs` ~122-157）：`required_artifacts` / `content_checks` / `requires_all_jobs_passed` 声明但从不读 → 删（spec.md 已由 spec-check 前置产出，job-manifest 由 task-decomposer 自身产出并被 init 读走，这些「required」是冗余空承诺）。只保留 `upstream_stages`（`scheduler.cjs:556-573` 在读）。
- [x] **`job_max_retries` 死配置**（`config.cjs:167`）：删，retry 口径统一到 `global_max_retries`。
- [x] **真·零引用导出**：`generateSessionId`（`store.cjs:61`）、`getStateSnapshot`（`state.cjs:942`）、`normalizeArtifactPath/Paths`（`state.cjs:902-931`）→ 直接删。
- [x] **孤儿清理功能（生产从不调用，但被测试/re-export 引用）**：`markTsArchived`（`store.cjs:95`）、`cleanupOrphanedTS`（`store.cjs:103`）→ 删代码 + 删 `state.cjs` re-export + 删 `__tests__/ts-lifecycle.test.cjs` 对应测试。若倾向保留，则补 `cli.cjs cleanup` 命令接线——默认删。
- [x] **撤回（原「JobEntry 死字段」）**：复核发现 `layer` / `files` / `produces` 被 `initJobsFromManifest` 拷贝、且被 `scheduler.cjs`（job_details + prompt）与 `cli.cjs`（report）读取——**非死字段**，子代理误判，已纠正，不删。
- [x] **`loadConfig().version = '6.0.0'`**（`config.cjs:311`）：删除或与 beacon.yaml 对齐（版本唯一来源是发布 tag）。

### Phase 2 — 修真 bug（中风险，每个带测试）

- [x] **BUG-1（活锁，高置信）**：`scheduler.cjs` ~493-496 —— stale job 且 `attempt_count >= max_retries` 只设 `job.status = FAILED`、不动 `coding.status`，随后 recompute 又把 job 状态从 `coding.status`(IN_PROGRESS) 算回 IN_PROGRESS → 永远 `wait`、永不 `fail`。修：同步置 `coding.status = FAILED`（或统一走 `transition`）。补测试：stale + 耗尽 → 终局 `fail` 而非 `wait`。
- [x] **BUG-2（off-by-one）**：`scheduler.cjs` ~127-158 —— 注释称 attempt_count 1-based（首派=1），但 `_buildGlobalDispatch` 首派不置位（真实 run 里 PASSED 阶段的 `attempt_count` 全程 0），guard 用 `<= global_max_retries` → 最多 1+3=4 次而非文档的 3 次。修：首派置 1（或 guard 改 `<`）。补测试断言终局前的总 attempt 数。
- [x] **BUG-3**：`scheduler.cjs` ~392-396 —— verification 子阶段 stale retry 无 attempt 上限，只有 fix 轮次约束；stale 的 testing/review/regression 会无限重派。修：加计数或复用轮次上限。
- [x] **artifacts 去重/归一化**：handoff ingest 时把 `{path}` 对象与裸字符串两种形状归一为 `{path}` 并去重（真实 run 的 `state.json` 每个文件列了两遍）。定位 `subagent-handler.cjs` 的 artifact 收口。
- [x] **BUG-4**：`cli.cjs` ~336-342 —— `scope === 'regression'` / `wave` 死分支（decode 只产出 `global|job|verification|unknown`），导致 verification update 的 summary `stage/sub_stage` 恒为 null。删死分支。
- [x] **BUG-5**：`scheduler.cjs` ~131-146、156-170 —— retry 直接设 `status`/`started_at`、绕过 `transition`，导致上次 FAILED 的 `marker_outcome` 与 `artifacts` 残留到下次 update。修：retry 路径也走 `transition`（或显式清理 markers/artifacts）。

### Phase 3 — auto-commit 收缩（P1）

- [x] 保留 `--auto-commit` opt-in 与完成时自动触发语义（不动行为）。
- [x] 补 `performCommit` 真实提交路径测试（`commit.test.cjs` 目前只覆盖 no-op / 非 git 仓库 / already-committed / message 生成）。
- [x] 收敛 commit message 生成（subject/body 组装收敛到单一函数，删重复逻辑）。

## 四、已知限制 / 观察（本轮不动，记档）

- **绝对路径不随项目改名迁移**：`state.json` 的 `artifacts`/路径为绝对路径，项目目录改名后全部过期（`rdpcli-pi` 这条 run 里指向旧 `test-pi`）→ `resume` 跨改名不可靠。属已知限制，待后续设计「相对项目根」或「resume 时重定位」。
- **verification 四子阶段精细仪式**（testing/review/regression/fix + 轮次归档 + SKIPPED 传播）：本轮不动；作为下一轮「粗化为 verify→fix→reverify」的候选，届时需改行为 + 测试。
- **`docs/state.json` 为 v6 样例**：已改名 `docs/state.v6-historical.json` 标注。

## 五、执行顺序与护栏

1. **Phase 0 → 1 → 2 → 3**，每阶段独立可提交。
2. 每项删除/修复**先看引用再动手**，删导出需同步删 `state.exports.test.cjs` 的完整性断言。
3. Phase 2 的每个 bug **先写复现测试（red）再修（green）**，遵循 `rules/testing.md`。
4. 全程 `node --test '__tests__/*.cjs'` 保持 244+（新增）全绿。
5. 不碰不变量（PASSED 不降级 / 原子写 / stale 30min / 环检测 / manifest gate）。

## 六、第二轮补充（2026-10-12，review 遗留项）

**已清（本次提交）**：
- 文档漂移：`depends_on` 由「必填」改为「可选，缺省空数组」（`CODE_WIKI.md` JobEntry 形状补齐 `layer`/`description`/`produces`）。
- 死守卫：`cli.cjs` 删除 `ts_lifecycle !== 'archived'`（`archived` 无生产者，守卫恒真）。
- 测试补缺：`__tests__/subagent-handler.test.cjs` 新增——`reconcileHandoffFiles` 兜底关闭 + artifacts 归一化、`validateHandoffArtifacts` 缺文件→FAILED / 双形状→PASS。

**第三轮 grilling（2026-10-12）已定**：
- `_checkStaleRuns` 死分支 → **删**（Path 1 `runs[]` 扫 IN_PROGRESS 已移除，只留 started_at 单一路径）。
- `archived` 生命周期 → **彻底删**（`resolveArchiveDir`/`resolveSnapshotDir` + `ARCHIVE_DIR`/`SNAPSHOTS_DIR` 常量 + 导出完整性断言全删；`ts_lifecycle` 文档改两态 active→completed）。
- `verification` 四子阶段 → **保留现状**（独立验证者已证明抓真 bug，是抗 LLM 演化的 moat；记为「模型再进化时第一个回看点」）。
- resume 跨项目改名 → **记档不修**（artifact 绝对路径只喂 report/verify/evidence，不影响正确性；改名后 resume 是窄场景低 ROI）。
