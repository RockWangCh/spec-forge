# spec-forge Code Wiki

> AI 维护参考。本文档只提供"地图"与"契约"，具体函数签名请直接读源码。

---

## 1. 项目定位

**spec-forge** 是跨 IDE 的多阶段编码流水线编排 Skill。它本身不生成业务代码，只做三件事：

1. **调度**: `scheduler.cjs` 决定下一步动作（纯函数 + 持久化状态）
2. **持久化**: `cli.cjs update` 写 `state.json`（outcome 持久化主入口；`scheduler.cjs main()` 亦就地标记 IN_PROGRESS/stale 并写回）
3. **分发**: 主代理通过 Task 工具调用专项 Agent 执行实际工作

循环直到 `done` 或 `fail`。

## 2. 架构地图

```
Coordinator (主代理)
  ├── 读 SKILL.md (操作契约)
  ├── scheduler.cjs  ──→ 读 state.json, 输出 JSON 指令
  ├── Task(agent)     ──→ Agent 读 agents/{name}.md 执行
  └── cli.cjs update  ──→ 读 handoff, 写 state.json
```

### 模块依赖

```
# 叶子模块（无内部依赖）
config.cjs, store.cjs, dispatch-scope.cjs, logger.cjs, markers.cjs, perf.cjs

# 依赖链
stage-entry.cjs  → config.cjs
diff.cjs         → logger.cjs
state.cjs        → config.cjs, stage-entry.cjs, store.cjs
scheduler.cjs    → state.cjs, config.cjs, stage-entry.cjs, dispatch-scope.cjs
subagent-handler.cjs → state.cjs, config.cjs, logger.cjs, markers.cjs, diff.cjs
cli.cjs          → state.cjs, config.cjs, subagent-handler.cjs, logger.cjs,
                   dispatch-scope.cjs, perf.cjs
```

### 文件职责

| 文件 | 职责 |
|------|------|
| `SKILL.md` | 主代理操作契约（循环流程、指令处理规则） |
| `scripts/scheduler.cjs` | 决策引擎，`decideNext(state, config)` 返回指令 |
| `scripts/state.cjs` | 状态模型 + 门面：default 工厂 / 访问器 / 派生 recompute / 谓词（re-export store） |
| `scripts/store.cjs` | 持久化 seam：state.json 读写 + TS 生命周期 + 路径 |
| `scripts/stage-entry.cjs` | StageEntry 状态机：`transition` / `recompute` / `isStaleRun` |
| `scripts/dispatch-scope.cjs` | description 协议：`encode` / `decode` |
| `scripts/cli.cjs` | 统一 CLI: `init` / `update` / `report` / `verify` / `perf-compare` |
| `scripts/subagent-handler.cjs` | Agent 完成事件处理（状态变更核心） |
| `scripts/config.cjs` | 配置唯一源：阶段枚举 + agent 映射 + 阈值 + 项目类型探测 |
| `scripts/logger.cjs` | 结构化日志 |
| `scripts/markers.cjs` | HANDOFF JSON 解析 |
| `scripts/diff.cjs` | 文件变更检测（git / snapshot） |
| `scripts/perf.cjs` | 压测对比（确定性） |
| `agents/*.md` | Agent 角色定义（Agent 自己读，主代理不读） |
| `rules/*.md` | 审查规则（security / testing） |

## 3. 流水线模型

```
spec-check → task-decompose → baseline-regression → implementation → verification → evidence-verify
                                                      │                │
                                                      │                └── testing → review → regression → (fix ↺，≤2 轮)
                                                      │
                                                      └── job DAG: J1, J2 coding 并行（depends_on，并发上限默认 5）
                                                            └── J3 coding（等 J1 coding PASS）
```

- **6 个全局阶段**: `spec-check` / `task-decompose` / `baseline-regression` / `implementation` / `verification` / `evidence-verify` 串行
- **baseline-regression**: task-decompose 后、写代码前，跑全量 build+test；不通过则终止任务（项目本就损坏）
- **implementation（复合阶段）**: 持有扁平 job DAG（`implementation.jobs[]`），不派发 agent；每个 job 只跑 `coding`（agent `implementer`），按 acyclic `depends_on` 排序，调度器并行分发依赖就绪的 job，受并发上限约束（默认 5，`SPEC_FORGE_MAX_CONCURRENCY` 覆盖，0=不限）。`status` 由所有 job coding 的 PASSED/WARN 聚合
- **Job coding 阶段**: 每个 job 独立跑 `coding`，依赖就绪即并行分发；无 wave、无 round、无 per-wave 验证、无跨 wave 串行 gate
- **verification（复合全局阶段）**: 全部 job coding PASS 后对整份变更集跑一次 `testing → review → regression`，失败进入 `fix` 循环（≤2 轮）
- **verification 子阶段**: testing = test-generator（全局 `test-manifest.json`）；review = code-reviewer（全局 `review-report.md`）；regression = regression-runner（全量 build+test）；fix = fixer
- **verification 循环**: 每轮 `{testing, review, regression, fix}`，当前轮 = `rounds[last]`。testing FAIL → review/regression 置 `SKIPPED` → fix；review FAIL → regression 置 `SKIPPED` → fix；regression FAIL → fix；regression PASSED/WARN → fix 置 `SKIPPED`（不派 fix）；fix PASS/FAILED → 归档本轮 → 下一轮 testing；fix WARN → 软通过（verification WARN）。统一上限 `max_retries` 轮 fix（任一子阶段 FAIL 都计轮，耗尽终局 fix 置 `SKIPPED`、verification FAILED）
- **并行**: implementation 内所有依赖就绪的 job coding 并行 dispatch，受并发上限约束（默认 5，在飞数封顶，派满返回 `wait`）；verification 只在全部 coding PASS 后跑一次

## 4. State Schema

`specs/{TS}/state.json` 的核心结构（`defaultState()` in state.cjs）：

```javascript
{
  schema_version: 8,
  ts, session_id, turn_count,
  ts_lifecycle: 'active' | 'completed',
  ts_created_at, ts_completed_at,
  pipeline_mode: 'job-dag-pipeline',
  stages: {
    'spec-check':          StageEntry,
    'task-decompose':      StageEntry,
    'baseline-regression': StageEntry,
    'implementation':      ImplementationStage,  // 复合：持有扁平 jobs DAG
    'verification':        VerificationStage,   // 复合：testing/review/regression/fix 子循环
    'evidence-verify':     StageEntry
  },
  completion_blocked, completion_block_reason
}
```

- `StageEntry`: `{ status, started_at, completed_at, attempt_count, markers, artifacts, runs }`
- `JobEntry`: `{ id, layer, description, files, produces, depends_on, agent_type, attempt_count, max_retries, coding: StageEntry, status }`（`depends_on` 可选，缺省空数组；有值时必须 acyclic）
- `ImplementationStage`: `{ status, started_at, completed_at, jobs: [JobEntry] }`（不派发 agent，status 由 jobs coding 聚合）
- `VerificationStage`: `{ ...StageEntry, max_retries, rounds: [{ testing, review, regression, fix: StageEntry }] }`（当前轮 = `rounds[last]`；每轮独立，已归档轮保留 skip/失败痕迹）
- Jobs 直接存放在 `implementation.jobs[]` 中（完整 job 对象，非元数据引用）；调度器拒绝环状 `depends_on`

### 状态枚举

```
STAGE_STATUS: PENDING | IN_PROGRESS | PASSED | WARN | FAILED | BLOCKED | SKIPPED
JOB_STATUS:   PENDING | IN_PROGRESS | PASSED | WARN | FAILED | BLOCKED
```

- `WARN`: 软通过，不阻塞下游，evidence-verifier 复核
- `BLOCKED`: review 发现上游失败，等上游重跑，不消耗 retry 配额

## 5. 关键契约

### 5.1 HANDOFF 协议

Agent 完成时必须同时输出：
1. **磁盘文件**: `specs/{TS}/handoff-{agent}.json`（全局）或 `handoff-{jobId}-coding.json`（job）
2. **响应文本**: 末尾的 `HANDOFF_BEGIN { ... } HANDOFF_END` 块

```json
{ "stage": "...", "decision": "PASS|FAIL|...", "artifacts": [{"path": "/abs"}],
  "markers": {"<name>": "PASS|..."}, "summary": "..." }
```

`subagent-handler.cjs` 优先读磁盘文件，缺失时回退文本块。

### 5.2 Description 路由标签

调度器输出的 `description` 字段携带路由标签，`cli.cjs update` 据此定位目标：

- 全局: `TS={ts} GLOBAL={stage-name}`
- Job: `TS={ts} JOB={job-id} STAGE=coding`（无 `WAVE=`）
- verification: `TS={ts} GLOBAL=verification STAGE={testing|review|regression|fix}`

**主代理必须原样复制**，不得改写。

### 5.3 Agent I/O

| Agent | 输入 | 输出产物 |
|-------|------|----------|
| spec-checker | 用户请求 | `spec.md`, `spec-check-report.json` |
| task-decomposer | `spec.md` | `job-manifest.json` |
| implementer | `spec.md` + `job-manifest.json` | 源码文件 + `coding-manifest-{JOB}.json`（内容说明，required gate） |
| test-generator | 源码 + spec | 测试文件 + `test-manifest.json`（全局 AC→test 追踪，required gate） + `handoff-verification-testing.json` |
| code-reviewer | 全部产物 | `review-report.md`（全局） + `handoff-verification-review.json` |
| regression-runner | 全部产物 | `baseline-regression-report.md` / `regression-conclusion.md` + `handoff-baseline-regression.json` / `handoff-verification-regression.json`；若有可语义识别的性能压测配置（压测命令），另产出 `perf-baseline.json` / `perf-final.json` |
| evidence-verifier | 全部产物 | `verification-report.md` + `handoff-evidence-verifier.json` |

Agent 之间不直接通信，全通过 `specs/{TS}/` 下的文件传递。

## 6. 不变量（修改时必须保持）

| 不变量 | 实现位置 |
|--------|----------|
| PASSED 不降级 | `setGlobalStage` / `setJobCodingStage` / `recompute*Status` 中的 guard |
| state.json 原子写 | `save()` tmp + rename |
| session marker 写 | `writeSessionActiveTS()`（每 session 一文件，天然并发安全） |
| TS 格式校验 | `TS_LIKE_RE` 在 `load` 校验 TS 格式 |
| 损坏 state.json 备份 | `load()` 复制为 `*.corrupt.<ts>.<timestamp>` 后返回 defaultState |
| 并行分发流式更新 | 所有 dispatch（单个/批量/verification stage）在返回前标记目标 stage 为 IN_PROGRESS；主代理发起 Task 后立即重调 scheduler，不等完成。implementation 内多个 job coding 并行 |
| 30 分钟 stale 检测 | `DEFAULT_STALE_MS = 30*60*1000`，IN_PROGRESS 超时标记 FAILED |
| review 上游回流 | `applyUpstreamReflow` + BLOCKED 状态（不消耗 retry） |
| TS 完成维护 | `markTsCompleted()` 由 `cli.cjs update` 在所有必需阶段 PASSED/WARN 时调用 |
| content-manifest gate | `coding` / verification `testing` PASS 时，`subagent-handler.cjs` 校验 `coding-manifest-{JOB}.json` / `test-manifest.json` 存在 + 可解析 + 关键字段（ts/agent/stage + job_id），缺失/非法 → FAILED。语义一致性交 review/evidence-verifier |

## 7. 调度器决策

`decideNext(state, config, projectRoot)` 返回指令，`action` 取值：

| action | 含义 |
|--------|------|
| `dispatch` | 分发单个 Agent |
| `dispatch_batch` | 并行分发多个 job coding 阶段 |
| `retry` | 重试失败/卡死阶段 |
| `wait` | 等待进行中工作 |
| `done` | 全部完成 |
| `fail` | 终局失败 |

主循环：按 `GLOBAL_STAGE_ORDER` 遍历，`implementation` 阶段跑 job-DAG 评估门（`_evaluateImplementation`），`verification` 阶段跑复合验证循环门（`_evaluateVerification`）；其余叶子阶段走 `_evaluateGlobalStage`。

`_evaluateImplementation` 决策：
1. `_collectReadyCodingJobs` 扫描全部 PENDING job，检查 `depends_on` 是否全 coding PASSED，batch dispatch（受并发上限约束：默认 cap=5，每次最多派 `cap − 在飞数`；`SPEC_FORGE_MAX_CONCURRENCY` 覆盖，0=不限）
2. 全部 job coding PASS 后，`implementation` PASSED/WARN，进入 `verification`；环状 `depends_on` 直接 `fail`（新增环检测）

**验证循环门**（`_evaluateVerification`）：读当前轮 `rounds[last]` 走 `testing → review → regression`；任一 FAIL 先标记下游子阶段 `SKIPPED` 再进 fix；fix PASS/FAILED → `startNextVerificationRound` 归档本轮并派下一轮 testing；统一上限 `max_retries` 轮 fix（`rounds.length - 1 >= max_retries` 即终局 FAILED）；fix WARN → 软通过（verification WARN）。

## 8. 运行入口

`${SKILL_DIR}` = 本 skill 目录（含 `SKILL.md`）的绝对路径，从 skill base directory 解析一次后原样代入。

```bash
# 初始化（默认全新自动生成 TS；init --ts=<TS> = 显式指定 TS 新建，已存在则报错）
node ${SKILL_DIR}/scripts/cli.cjs init [--ts=<TS>] [--auto-commit]

# 恢复已有 pipeline（state.json 必须存在；--latest 按 mtime 找回最新，session marker 兜底）
node ${SKILL_DIR}/scripts/cli.cjs resume --ts=<TS> [--latest] [--auto-commit]

# --auto-commit 语义：写入 state.auto_commit=true；当最后一条 update 把 pipeline 置为
# completed 时，CLI 自动执行 commit（message 用 spec.md ### Title 兜底，best-effort，
# 失败不影响 PASSED，结果随 update 的 commit 字段返回）。commit 命令只是手动重试通道。

# 调度循环（TS 由主 agent 显式传递，脚本不再读全局 .active 指针）
node ${SKILL_DIR}/scripts/scheduler.cjs --ts=<TS>       # 输出 JSON 指令
node ${SKILL_DIR}/scripts/cli.cjs update \
  --ts=<TS> \
  --agent=<agent> \
  --description="<原样复制>" \
  --output-file=specs/{TS}/handoff-<agent>.json

# 报告（--latest 按 mtime 找回最新 pipeline，用于崩溃/上下文压缩后恢复）
node ${SKILL_DIR}/scripts/cli.cjs report [--ts=<TS>] [--latest] [--json]

# 校验产物
node ${SKILL_DIR}/scripts/cli.cjs verify <paths...> | --handoff=<path>

# 性能对比（确定性，供 regression-runner 调用）
node ${SKILL_DIR}/scripts/cli.cjs perf-compare --baseline=<path> --final=<path> [--thresholds=<json>]
```

环境变量 `PROJECT_DIR`（默认 `process.cwd()`）决定 specs/ 路径解析。

## 9. 测试

```bash
node --test '__tests__/*.cjs'
```

| 文件 | 覆盖 |
|------|------|
| `scheduler.test.cjs` | 调度器全分支 |
| `state.recompute.test.cjs` | 状态重算（WARN/retry/BLOCKED） |
| `state.baseline.test.cjs` | 真实 state.json 回归（PASSED 不降级） |
| `state.exports.test.cjs` | 模块导出完整性 |
| `stage-entry.test.cjs` | StageEntry 状态机（transition/recompute/isStaleRun） |
| `dispatch-scope.test.cjs` | description 协议 encode/decode 往返 |
| `implementation.test.cjs` | implementation 复合阶段 + job DAG（depends_on 环检测） |
| `manifest-gate.test.cjs` | content-manifest 门禁 |
| `ts-lifecycle.test.cjs` | TS 生命周期 |
| `perf.test.cjs` | 压测对比阈值 |
| `verification.test.cjs` | verification 回归/fix 循环（baseline + fix/WARN/retry 循环） |
| `warn-mapping.verify.cjs` | WARN 决策映射 |
| `commit.test.cjs` | auto-commit（message/no-op/already-committed） |
| `progress.test.cjs` | 状态栏渲染/折行/耗时/session 门控 |
| `session.test.cjs` | session marker |

**行为变更必须带测试**。详见 `rules/testing.md`。

## 性能对比（perf）

`baseline-regression` / `verification`（`regression` 子阶段）两个环节在跑 build+test 之外，可选地做「开发前/后性能压测对比」，抓开发引入的性能回归。

**触发（opt-in）**：不依赖任何固定小节名（如 `## 性能压测`），而是**语义识别**——`regression-runner` 在「项目目录 `CLAUDE.md` + 用户原始请求 + 项目文件」里找四要素，只要有可执行的压测命令即启用：

1. 压测命令（如 JMeter `jmeter -n ...`、k6 `k6 run ...`、wrk、`go test -bench ...`）—— **唯一硬触发**，找不到即无压测
2. 统计文件（如 JMeter `statistics.json` 路径，或压测工具导出的结果文件路径）
3. 部署命令（替换二进制/重启服务的方式，语言无关）
4. 探活命令（如 `curl <health-endpoint>`）

后三者 best-effort：缺失时优雅降级（baseline 记 `skipped`，final 如实暴露），不反推「无压测」、也不硬 FAIL。

**流程**（由 `regression-runner` 执行，确定性对比在代码里）：

- **baseline 模式**：build+test PASS → **重新部署**（不信任运行中的服务）→ 探活 → 跑压测 → 快照 `statistics.json` 到 `specs/{TS}/perf-baseline.json`。
- **final 模式**：build+test PASS → 部署 → 探活 → 跑压测 → 快照 `specs/{TS}/perf-final.json` → 调 `cli.cjs perf-compare` 对比。

**指标与阈值**（相对变化判退化，默认值可配置）：`throughput`（↓ >10%）、`pct3ResTime`（↑ >20%）、`errorPct`（绝对值 +>0，只比相对）。

**语义**：部署命令缺失 → 无法换新二进制 → skip（best-effort）；部署命令存在但执行失败 = 硬 FAIL；压测测量失败 = WARN（best-effort 跳过）；性能退化 = `regression` 子阶段 WARN → `verification` 节点 WARN（软通过，evidence-verifier 复核），不触发 fix 循环。

**关键文件**：`scripts/perf.cjs`（确定性对比）、`scripts/cli.cjs perf-compare`（CLI）、`__tests__/perf.test.cjs`（单测）。WARN 贯通点：`recomputeVerificationStatus`（state.cjs）、`_evaluateVerification`（scheduler.cjs）、`subagent-handler.cjs` 的 regression/fix 子阶段 WARN 映射。

## 10. 修改指引

| 需求 | 改哪里 |
|------|--------|
| 调整流水线阶段 | `config.cjs` 阶段枚举 + `state.cjs` `defaultState()` |
| 调整重试 | `config.cjs` `DEFAULT_RETRY_POLICY`（仅 `global_max_retries` 生效） |
| 改 Agent 行为 | `agents/{name}.md`（保持 HANDOFF 契约） |
| 加审查规则 | `rules/security.md` 或 `rules/testing.md` |
| 改调度逻辑 | `scheduler.cjs`（决策引擎就地变更状态，`main()` 随后持久化；保持不变量） |
| 改 description 格式 | `dispatch-scope.cjs`（`encode`/`decode` 是唯一格式契约） |
| 改状态机规则（时间戳/stale/不降级） | `stage-entry.cjs`（`transition`/`recompute`） |
| 改持久化/TS 生命周期 | `store.cjs` |
| 改状态字段 | `state.cjs` `defaultState()` + 相关 recompute 函数 |

---

*代码是真实来源，本文档仅作导航。变更后请同步更新。*
