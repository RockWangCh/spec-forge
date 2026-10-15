# spec-forge 流水线改造 — 设计文档

> 本文档记录经 `/grill-me` 逐轮对齐后的设计决策，作为实现依据与后续回溯。
> 状态：已实现。当前代码 schema_version=8、verification 用 rounds[]（见下「与当前实现的差异」）；本文档为决策日志，历史条目原样保留。
> 共三轮对齐：Q1–Q16（基线/回归门）、Q17–Q26（实施节点验证轮次，已被 supersede）、2026-08-21（job-DAG 重构）。
>
> **与当前实现的差异**（代码为准，历史条目保留）：
> - schema_version 已 7 → **8**（§四/§六 的 v7 为历史值）。
> - verification 节点为 `rounds: [{ testing, review, regression, fix }]`，非 §二/§四.2 的 `stages{}`。
> - 并发上限已于 2026-09-17 以「在飞计数」重新引入（§五「删除」被该轮取代，见文末）。

## 一、目标流程

```
spec-check (spec-checker)
  → task-decompose (task-decomposer)
  → baseline-regression (regression-runner)     [全量 test+build，FAIL → 终止任务]
  → implementation                                [实施节点：扁平 job DAG]
        └─ jobs[].coding（depends_on 并行，并发上限默认 5）→ implementation PASS
  → verification                                  [全局复合：testing → review → regression → (fix ↺，≤2 轮)]
  → evidence-verify (evidence-verifier)
```

- `implementation` 是**一等复合全局阶段**，介于 `baseline-regression` 与 `verification` 之间，
  持有扁平 `jobs[]`（acyclic `depends_on`）；不派发 agent，自身 `status` 由所有 job 的 coding
  PASSED/WARN 聚合。
- `verification` 取代旧 `regression` 为全局复合阶段：全部 job coding PASS 后对整份变更集跑一次
  `testing → review → regression`，失败进入 `fix` 循环（≤2 轮），fix WARN 软通过。

## 二、状态模型

### 全局阶段顺序

```
spec-check → task-decompose → baseline-regression → implementation → verification → evidence-verify
```

- **叶子阶段**（spec-check / task-decompose / baseline-regression / evidence-verify）：派发单个 agent。
- **复合阶段**：
  - `implementation`：持有扁平 `jobs[]`，不派发 agent，status 由所有 job coding PASSED/WARN 聚合。
  - `verification`：`testing → review → regression` 子阶段 + `fix` 循环（≤2 轮），取代旧 `regression` 项目级循环。

### implementation 节点结构

```json
"implementation": {
  "status": "PENDING",
  "started_at": null,
  "completed_at": null,
  "jobs": [
    { "id": "J0-1", "depends_on": [], "...": "...", "coding": StageEntry, "status": "PENDING" }
  ]
}
```

- **job** 只拥有 `coding` stage（agent `implementer`），按 acyclic `depends_on` 排序；调度器并行分发
  所有依赖就绪的 job（并发上限默认 5，`SPEC_FORGE_MAX_CONCURRENCY` 覆盖，0=不限）。
- 一个 implementation 读作：`jobs[].coding（depends_on 并行）→ implementation.status 聚合`。

### verification 节点结构

```json
"verification": {
  "status": "PENDING",
  "started_at": null,
  "completed_at": null,
  "attempt_count": 0,
  "max_retries": 2,
  "stages": {
    "testing": StageEntry,
    "review": StageEntry,
    "regression": StageEntry,
    "fix": StageEntry
  }
}
```

- **verification** 在全部 job coding PASS 后对整份变更集跑一次；子阶段 `testing → review → regression`。
- 循环语义：
  - `testing` FAIL → `fix`（跳过 review+regression）；
  - `review` FAIL/BLOCK → `fix`（跳过 regression）；
  - `regression` FAIL → `fix`；
  - `fix` PASS → reset → 回 `testing`；`fix` WARN → 软通过（verification WARN）；上限 2 轮 fix。

### verification 循环状态机（`_evaluateVerification`，原 `_evaluateRegression`）

1. `stages.verification` PENDING → dispatch `test-generator`（testing）。
2. testing PASS → `review`（code-reviewer）；FAIL → `fix`。
3. review PASS/WARN → `regression`（regression-runner，全量回归）；FAIL/BLOCK → `fix`。
4. regression PASS → 节点 PASSED，写结论文件 `regression-conclusion.md`。
5. regression FAIL → 若 `attempt_count < max_retries` 进 `fix`；否则节点 FAILED → `fail`。
6. `fix` PENDING → dispatch `fixer`（读失败清单定位）。
   - fixer 判**非代码失败** → WARN + 理由 → 节点 WARN，写结论文件，放行。
   - fix PASS → reset → 回 `testing`（reverify）；fix FAIL → 回退重试。

## 三、调度器变更（`scheduler.cjs`）

1. **实施节点挂载**：`decideNext` 遍历到 `implementation` 时调用 `_evaluateImplementation`
   （收集依赖就绪的 PENDING job，batch dispatch coding，受并发上限约束）；遍历到 `verification`
   时调用 `_evaluateVerification`（原 `_evaluateRegression` 改名，卸下项目级循环为子阶段）。
2. **环检测**：task-decomposer 产物 `jobs[]` 的 `depends_on` 必须 acyclic；调度器对环状 manifest 拒绝并 `fail`。
3. **字段迁移**：`state.stages.implementation.waves` 改为 `state.stages.implementation.jobs`；
   旧 `regression` 全局阶段改为 `verification` 复合阶段。
4. 保留 `baseline-regression` 不变（pre-coding leaf）。

## 四、状态库变更（`state.cjs`）

1. `defaultState()`：`schema_version = 7`；`pipeline_mode = 'job-dag-pipeline'`；`stages` 中
   `regression` 改为 `verification`（`defaultVerificationStage()`）；`implementation` 持有 `jobs[]`。
2. 新增 `defaultVerificationStage()`（返回 `{ ...StageEntry, max_retries, stages: { testing, review, regression, fix } }`）；
   删除 `defaultWave()` / `defaultWaveRound()` 等 wave/round 工厂。
3. `getJobs` / `recomputeImplementationStatus` / `recomputeVerificationStatus` / `setVerificationStage` /
   `recordVerificationRun` / `completeVerificationRun` / `resetVerificationForReverify` 等从
   `implementation.jobs` 与 `verification.stages` 读取；删除 `getWave` / `getWaveIndexForJob` /
   `recomputeWaveStatus` / `waveCodingAllPassed` 等 wave 相关访问器。
4. `allMandatoryStagesPassed` / `allMandatoryStagesPassedOrWarned` 删除对 `allWavesPassed`
   的单独检查（`implementation.status` 已涵盖 jobs）；只遍历 `GLOBAL_STAGE_ORDER`。
5. `getStateSnapshot` 的 `waves` 字段改为 `jobs`（从 `implementation.jobs` 读取）。

## 五、配置变更（`config.cjs`）

- `GLOBAL_STAGE_ORDER`：`regression` → `verification`（介于 `implementation` 与 `evidence-verify`）。
- `GLOBAL_STAGE_REQUIREMENTS`：新增 `verification`，`upstream_stages: ['implementation']`。
- 删除 `WAVE_STAGE_ORDER`；新增 `VERIFICATION_STAGE_ORDER = ['testing', 'review', 'regression', 'fix']`。
- 删除 `DEFAULT_PARALLELISM_POLICY` / `getParallelismPolicy`（并发上限移除，所有依赖就绪 job 一次并行 dispatch）。

## 六、零兼容（v6 → v7）

- `schema_version = 7`；`load()` **不写**版本 gate / 字段迁移 / 备份。
- 旧 v6（及更早）state.json 不迁移：`implementation.waves` / `stages.regression` 被新代码忽略，
  表现为「需重新 `init`」。旧 TS 目录应归档重跑，不支持跨版本续跑。

## 七、文件改动清单

| 文件 | 动作 |
|------|------|
| `scripts/state.cjs` | 改（implementation.jobs、verification 复合阶段、schema v7） |
| `scripts/scheduler.cjs` | 改（job-DAG 挂载、环检测、verification 循环） |
| `scripts/config.cjs` | 改（GLOBAL_STAGE_ORDER/requirements：regression → verification、VERIFICATION_STAGE_ORDER） |
| `scripts/cli.cjs` | 改（report/snapshot 字段迁移：waves → jobs） |
| `scripts/subagent-handler.cjs` | 改（verification 子阶段定位、test-manifest.json / review-report.md 全局 gate） |
| `CODE_WIKI.md` / `SKILL.md` | 改（流程文档同步） |
| `__tests__/*` | 改 + 新增（job-DAG 环检测、verification 循环、零兼容） |
| `docs/state.json` | 重跑 `/data/src/tile-server` 生成 v7 样例 |

## 八、测试

- 现有测试回归更新，新增：job-DAG 环检测、implementation.jobs 结构、verification 循环（fix→reset→testing）、
  零兼容（v6 文件行为）。

## 九、决策记录

> Q1–Q16 为基线/回归门的历史决策（回归部分现已并入 `verification` 复合阶段）；Q17–Q26 为 v6 历史决策，
> 已被 2026-08-21 重构 supersede。

### Q1–Q16（基线/回归门）

| # | 决策 |
|---|------|
| Q1 | 编译型 gate 曾推广到所有语言（逐批串行）；2026-08-21 取消，改为扁平 job DAG（depends_on 并行，无跨批串行 gate） |
| Q2 | 新增全局阶段 `regression` + 新 agent `regression-runner`（2026-08-21 起 `regression` 降为 `verification` 子阶段） |
| Q3 | 全量 test+build；项目级 mini 验证管线 fix→testing→review→回归 |
| Q4 | 结论文件 `specs/{TS}/regression-conclusion.md`，regression-runner 写 |
| Q5 | evidence-verifier 读结论文件，不重复跑全量测试 |
| Q6 | 回归循环状态结构（stages + attempt_count，后并入 `verification` 复合阶段） |
| Q7 | testing(test-generator 针对修复) vs regression(regression-runner 全量) |
| Q8 | 非本次变更失败不修，给理由（后被基线方案重构） |
| Q9 | 循环上限复用 global_max_retries=2（≤3 轮） |
| Q10 | regression-runner 做归因 |
| Q11 | 代码编写前跑基线全量回归，不通过则终止 |
| Q12 | 非本次变更失败 → WARN + 理由记结论文件 |
| Q13 | 独立全局阶段 `baseline-regression`，task-decompose 后、implementation 前 |
| Q14 | 基线失败 → fail + `baseline-regression-report.md` |
| Q15 | 归因简化：基线干净 + 事后失败 = 本次变更 |
| Q16 | fix 循环内 fixer 可判"非代码失败"给理由 + WARN 提前退出 |

### Q17–Q26（实施节点验证轮次，已被 2026-08-21 重构 supersede）

> 该轮确立的逐批验证（轮次）模型已被 2026-08-21 job-DAG 重构取代；此处仅保留历史结论摘要，不再逐条维护。

### 2026-08-21（job-DAG 重构，schema v7）

- **移除 per-wave testing/review/fix**：逐批重复验证却很少真正抓到问题；改为全部 job coding PASS 后一次性全局验证。
- **implementation 改为扁平 job DAG**：`implementation.jobs[]`，每个 job 只跑 `coding`（agent `implementer`），
  按 acyclic `depends_on` 排序，调度器并行分发所有依赖就绪的 job（无并发上限）；不再有分批/轮次/跨批串行 gate。
- **合并事后验证为单一 `verification` 复合循环**：`testing → review → regression` + `fix` 循环（≤2 轮），WARN 软通过语义保留。
- **schema 升 v7（原 v6）**：`pipeline_mode: 'job-dag-pipeline'`；`implementation.waves[]` → `implementation.jobs[]`，
  删除 `rounds[]`；`stages.regression`（复合）→ `stages.verification`（复合，含 `stages.{testing,review,regression,fix}` + `max_retries`）。
- **不向后兼容**：旧 v6 及更早 state.json 不迁移，旧 TS 目录归档重跑。

### 2026-08-24（进度条，Claude Code statusline）

> 经 `/grill-me` 对齐。`scripts/progress.cjs` 读 session 级 marker `<projectRoot>/specs/session-active/<CLAUDE_CODE_SESSION_ID> → specs/{TS}/state.json`，
> 渲染「流程灯」（**无百分比**），通过 Claude Code statusline 每 5s 实时重绘。

| Q | 决策 |
|---|------|
| Q1 | **共享内核 + 多前端**：只写一个 `progress.cjs` 计算内核，默认挂 statusline；TUI（`watch`）/ 对话内输出只是换配置，不动内核 |
| Q2 | **流程灯，不要百分比**：6 阶段横条（`✓spec-check → ▸implementation → ·verification → …`），当前阶段高亮、已完成打勾；job / verification 细节放第二行。阶段/子阶段用 config **全称**，不做简写 |
| Q3 | **融入 spec-forge**：`scripts/progress.cjs` 与 `cli.cjs`/`scheduler.cjs` 同源，非独立通用工具 |
| Q4 | **session marker 自动跟随 + `--project-root` 覆盖**：默认从 session cwd / `PROJECT_DIR` 解析**本 session** 的活跃 TS（`specs/session-active/<SID>`，`init` 写入）；未显式给 `--project-root` 时**向上搜索**最近含该 marker 的目录（子目录启动也能命中），配置无需写死项目根。多 session 各写各的 marker，互不干扰 |
| Q5 | **implementation 细节进第二行**：主行只放 `▸implementation`，细节行 `jobs: J0-1✓ J1-2▸ …`（逐 job 打灯，超宽截断） |
| Q6 | **verification 细节进第二行**：`verification rN: testing✓ → review▸ → regression· → fix·`（rN 表轮次，fix 回退体现在轮次递增） |
| Q7 | **文档交付**：SKILL.md 给 statusline JSON 片段（含 `refreshInterval: 5`）；不做 `cli.cjs statusline-install` 子命令 |
| Q8 | **布局/刷新落点**：`refreshInterval: 5`（事件驱动在 in-flight Task 期间不触发，无定时器则进度条卡住）；状态标记 `PASSED/WARN→✓ IN_PROGRESS→▸ PENDING→· FAILED→✗ SKIPPED→⊘ BLOCKED→⚠`（未知兜底 `·`）；无 pipeline → `sf idle`；终局全绿 / `[fail]` |

**实现落点（状态栏能力核实所得，非用户决策）**：

- **永不非零退出、永远有 stdout**：statusline 非零退出或零输出 → 整条空白（无 fallback）；任何读失败退化成兜底行 `sf …`。
- 读文件**无副作用**：不走 `store.load`（它在 corrupt 时写 `.corrupt.*` 备份），直接 `JSON.parse` + try/catch。
- `DEFERRED_RELEASE` 是 **AC 状态**（`test-manifest.json` / evidence-verify 语境），**不在 stage 状态枚举里**，进度条不会出现 → 不设专门标记。
- 终局 `FAILED` 阶段保留细节行（`currentStageName` 优先级 IN_PROGRESS → FAILED/BLOCKED → PENDING）：`implementation` 挂了要能看出哪个 job 挂了，而不是跳到下一个 PENDING 阶段。
- **向上搜索（2026-08-24 跟进，响应「配置不含 TS、最好自动配置」；2026-08-27 更正为 session marker）**：配置只指向脚本绝对路径，**不含 TS、不含 state.json、不含项目根**；`progress.cjs` 未显式给 `--project-root` 时从 cwd/PROJECT_DIR 向上找最近的 `specs/session-active/<CLAUDE_CODE_SESSION_ID>`（子目录启动也能命中；原 `.active` 全局指针已移除，改为每 session 一文件）。`--project-root` 仅用于在项目树外（如 skill 目录）启动 claude 的兜底。`cli.cjs init` 每次写本 session marker → 新 pipeline 零重配。
- **stage 耗时（2026-08-24 跟进）**：主行每个有可测时间的 stage 后追加**灰色紧凑耗时**（`✓spec-check 3m12s`）。终态 = `completed_at − started_at`；IN_PROGRESS = `now − started_at`（随 `refreshInterval` 实时走秒）；缺 `started_at`（PENDING / 旧数据 / 时间戳倒挂）不显示。格式 `45s / 3m12s / 1m04s / 32m`。数据来源：调度器派发时 `transition`/直接赋值打 `started_at`（scheduler.cjs:149-155, 405-406, 514-515），终态回填 `completed_at`。
- **宽度自适应折行（2026-08-24 跟进，响应「状态栏不自动 wrap？」）**：状态栏**不自动换行**——超宽单行只会被截断（右侧系统通知从右往左吃）或"wrap awkwardly"，且终端缩放不会重跑脚本（resize 不在触发列表）。因此主行按 `COLUMNS`（v2.1.153+ 注入；缺省 80）做 **token 感知折行**：在 ` → ` 之间断、不拆单个 stage，每行显式 `\n`（statusline 多行 = stdout 每行一个 row，是受支持的机制）。细节行宽度跟随 `min(maxDetailLen, COLUMNS)`。
- **细节行常驻 + 细节耗时（2026-08-24 跟进，响应「jobs/verification 不要消失」）**：`jobs:` / `verification rN:` 不再只跟随当前活跃阶段，而是**常驻**——implementation 一旦持有 jobs 就显示、verification 一旦开始（status 非 PENDING 或任一子阶段非 PENDING）就显示，活跃阶段后移（如 verification 完成、evidence-verify 运行时）也不消失。细节行同样带灰色耗时：每个 job 的 `coding` 耗时（`✓J0-1 3m12s`）、verification 每个子阶段耗时（`✓testing 1m04s`），复用 `stageDurationMs`。**符号统一在前**（`✓spec-check`、`✓J0-1`、`✓testing`，mark 一律前置），与主行风格一致。
- **verification.status 随子阶段适配（2026-08-24 跟进，响应「testing IN_PROGRESS 但 status 仍 PENDING」）**：不变式——任一子阶段（testing/review/regression/fix）非 PENDING，verification.status 就不得是 PENDING，需适配为 IN_PROGRESS/PASSED/FAILED/WARN。两处修复：①`_buildVerificationDispatch` 派发子阶段后立即 `recomputeVerificationStatus`（此前故意不调用，导致派发 testing 后 status 停在 PENDING）；②`recomputeVerificationStatus` 终态判定之后、全 PENDING 判定之前，增补"任一子阶段非 PENDING → IN_PROGRESS"（覆盖 testing PASSED + review PENDING 这类中途状态）。顺带修复终局 fix 显式 SKIPPED：regression PASSED/WARN → `fix SKIPPED 'regression passed'/'regression warn'`；重试耗尽 → `fix SKIPPED 'retries exhausted'`。
- 状态栏门控：workspace trust 未接受则空白；`disableAllHooks` 同时禁用自定义状态栏。属 Claude Code 专属**可选增强**，skill 本体保持 IDE 无关。

### 2026-09-17（重新引入 coding 并发上限）

> 经 `/grill-me` 对齐。响应「实施阶段并发过大 → 大模型服务返回链接错误」。此前 2026-08-21 删除的
> `max_concurrency` 是**批大小上限**（`slice(0, cap)`），在流式补位协议下从未真正约束并发。本次以
> **在飞计数**重新实现：`_collectReadyCodingJobs` 数非 stale 的 IN_PROGRESS job 数 `inFlight`，每次
> 最多派 `cap − inFlight` 个，派满返回 `wait`。

| Q | 决策 |
|---|------|
| Q1 | 只限 implementation 的 job coding（唯一无界并行分发点） |
| Q2 | 语义 = 总在飞数 ≤ 5（非批大小）；流式补位协议保持不变 |
| Q3 | `config.cjs` 常量 + `SPEC_FORGE_MAX_CONCURRENCY` 环境变量覆盖（运行时配置，不入 state.json） |
| Q4 | 本轮只做限流，不碰连接错误 retry/backoff（Task 工具层在本仓库之外） |
| Q5 | 症状以 API 端点过载为主，在飞上限 5 即可 |
| Q6 | 字段 `parallelism.max_concurrent_coding_jobs`（默认 5），区别于已删的批上限 |
| Q7 | `N≥1` 封顶；`0` = 无上限（逃生口）；负数/非数字 → 默认 5 |

