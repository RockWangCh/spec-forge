# spec-forge

**跨 IDE 的多阶段编码流水线编排 Skill**（`spec-forge`）。

spec-forge 本身不生成业务代码。它把一次「实现功能 / 修 bug / 重构」的代码变更，编排为一条可调度、可持久化、可恢复、可审计的多阶段流水线，由专项 Agent 分工完成，直到流水线 `done` 或 `fail`：

1. **调度** —— `scheduler.cjs` 是纯函数决策引擎，读 `state.json`，输出下一条 JSON 指令
2. **持久化** —— `cli.cjs update` 是 outcome 持久化主入口，写 `specs/{TS}/state.json`（原子写）
3. **分发** —— 主代理（Coordinator）按指令经 Task 工具调用专项 Agent 执行实际工作

在任何支持「子代理派发 + shell 命令」的 IDE 中工作方式完全一致（Claude Code、TRAE、Cursor 等），**不依赖 hooks**；一条流水线在一个 IDE 启动后可在另一个 IDE 用 `resume` 续跑。

## 流水线模型

```
spec-check → task-decompose → baseline-regression → implementation → verification → evidence-verify
                                                      │                │
                                                      │                └─ testing → review → regression → (fix ↺ ≤2 轮)
                                                      │
                                                      └─ 扁平 job DAG：J1, J2 coding 并行（depends_on，并发上限默认 5）
                                                            └─ J3 coding（等 J1 coding PASS）
```

| 阶段 | 类型 | 内容 |
|------|------|------|
| `spec-check` | 全局叶子 | spec-checker 将用户请求固化为 `spec.md`（验收标准 + 用户故事） |
| `task-decompose` | 全局叶子 | task-decomposer 产出 `job-manifest.json`（扁平 `jobs[]`，acyclic `depends_on`） |
| `baseline-regression` | 全局叶子 | **写代码前**跑全量 build+test；不通过则终止流水线（项目本就损坏）。可选采集性能基线 `perf-baseline.json` |
| `implementation` | 复合 | 持有扁平 job DAG，不派发 agent；每个 job 只跑 `coding`（implementer），依赖就绪即并行分发；status 由全部 job 聚合 |
| `verification` | 复合全局 | 全部 job coding PASS 后对**整份变更集**跑一次 `testing → review → regression`，失败进入 `fix` 循环（统一上限 2 轮）；fix WARN = 软通过 |
| `evidence-verify` | 全局叶子 | evidence-verifier 独立复核全部产物与证据 |

设计要点：

- **coding 与验证解耦**：所有 job 的 coding 并行（在飞计数封顶，默认 5；`SPEC_FORGE_MAX_CONCURRENCY` 覆盖，`0` = 不限），验证不按 job/wave 切分，只在整份变更集上跑一轮。
- **门禁（required gate）**：job `coding` 必须产出 `coding-manifest-<jobId>.json`，verification `testing` 必须产出 `test-manifest.json`（AC→test 追踪）；缺失或非法直接判 FAILED。
- **性能压测（opt-in，语义识别）**：项目里存在可执行的压测命令（JMeter / k6 / wrk / `go test -bench` 等）即启用；baseline 与 final 各部署新二进制后压测对比，吞吐 ↓ >10% / p99 ↑ >20% / errorPct ↑ 判退化 → `regression` WARN（软通过，交 evidence-verifier 复核）。
- **状态语义**：`WARN` = 软通过不阻塞下游；`BLOCKED` = review 发现上游失败、等上游重跑，不消耗 retry 配额。

## 目录结构

```
spec-forge/
├── README.md              # 本文档
├── SKILL.md               # 主代理操作契约（循环流程、指令处理规则）
├── agents/                # 8 个 Agent 角色定义（Agent 自己读，主代理不读）
│   ├── spec-checker.md    # spec-check：固化 spec.md
│   ├── task-decomposer.md # task-decompose：产出 job-manifest.json
│   ├── implementer.md     # job coding：实现单个 job
│   ├── test-generator.md  # verification.testing：写并跑测试
│   ├── code-reviewer.md   # verification.review：代码审查
│   ├── regression-runner.md # baseline-regression + verification.regression
│   ├── fixer.md           # verification.fix：修复失败项
│   └── evidence-verifier.md # evidence-verify：独立复核
├── rules/                 # 审查规则（code-reviewer 引用）
│   ├── security.md
│   └── testing.md
├── scripts/               # 确定性内核（纯 Node.js，零依赖）
│   ├── scheduler.cjs      # 决策引擎：decideNext(state, config) → JSON 指令
│   ├── cli.cjs            # 统一 CLI：init / resume / update / report / verify / perf-compare / commit
│   ├── state.cjs          # 状态模型 + 访问器 + 派生 recompute
│   ├── store.cjs          # 持久化 seam：state.json 读写 + TS 生命周期
│   ├── stage-entry.cjs    # StageEntry 状态机：transition / recompute / isStaleRun
│   ├── subagent-handler.cjs # Agent 完成事件处理（状态变更核心）
│   ├── dispatch-scope.cjs # description 路由标签 encode / decode
│   ├── config.cjs         # 配置唯一源：阶段枚举 + agent 映射 + 阈值
│   ├── perf.cjs           # 压测对比（确定性）
│   ├── progress.cjs       # 进度条（Claude Code statusline，可选）
│   └── logger.cjs / markers.cjs / diff.cjs / session.cjs
└── __tests__/             # node --test 测试套件（17 个文件，247 个用例，全绿）
    ├── scheduler.test.cjs         cli 相关：commit.test.cjs  session.test.cjs
    ├── 状态模型：state.exports / state.recompute / state.baseline .test.cjs
    ├── 阶段与门禁：stage-entry / implementation / verification / manifest-gate / ts-lifecycle .test.cjs
    ├── 基础设施：dispatch-scope / subagent-handler / perf / progress .test.cjs
    └── warn-mapping.verify.cjs    # 回归校验脚本
```

### Agent 分工与产物

Agent 之间不直接通信，全部通过 `specs/{TS}/` 下的文件传递。

| Agent | 输入 | 输出产物 |
|-------|------|----------|
| spec-checker | 用户请求 | `spec.md`、`spec-check-report.json` |
| task-decomposer | `spec.md` | `job-manifest.json` |
| implementer | `spec.md` + `job-manifest.json` | 源码文件 + `coding-manifest-{JOB}.json` |
| test-generator | 源码 + spec | 测试文件 + `test-manifest.json`（全局 AC→test 追踪） |
| code-reviewer | 全部产物 | `review-report.md` |
| regression-runner | 全部产物 | `baseline-regression-report.md` / `regression-conclusion.md`；有压测配置时另产出 `perf-baseline.json` / `perf-final.json` |
| fixer | 失败清单 | 修复代码 + `handoff-verification-fix.json` |
| evidence-verifier | 全部产物 | `verification-report.md` |

## 快速开始

环境要求：Node.js（任意近期版本，零 npm 依赖）；目标项目为 git 仓库。

将本目录作为 Skill 安装（如链接到 `~/.claude/skills/spec-forge` 或项目 `.claude/skills/spec-forge`），然后对主代理说：

- **开始新任务**：`/spec-forge 实现某功能 / 修复某 bug`（默认全新 pipeline，从头开始）
- **续跑**：明确要求「继续上次 / 续跑」，主代理会调 `cli.cjs resume --ts=<TS>`
- **自动提交**：`/spec-forge --auto-commit …`，流水线完成时自动 commit（best-effort，只 stage 流水线改动的源文件，排除 `specs/`，追加 `Generated-by: spec-forge` trailer，**从不 push**）

主代理的核心循环（细节见 `SKILL.md`）：

```bash
node ${SKILL_DIR}/scripts/cli.cjs init            # 1. 初始化，得到 TS
node ${SKILL_DIR}/scripts/scheduler.cjs --ts=<TS> # 2. 问调度器下一步（JSON 指令）
#    → 按 instruction 经 Task 工具派发 Agent（dispatch_batch 时并行派发）
#    → Agent 返回后立即持久化，回到 2
node ${SKILL_DIR}/scripts/cli.cjs update \
  --ts=<TS> --agent=<agent> \
  --description="<原样复制 instruction.description>" \
  --output-file=specs/{TS}/handoff-<scope>.json    # 3. 每个 Agent 返回后必须调用
node ${SKILL_DIR}/scripts/cli.cjs report --ts=<TS> # 4. 结束后出报告
```

三条铁律（写在 `SKILL.md` Rules 里，主代理必须遵守）：

- **永不直接改 `state.json`** —— 一律经 `cli.cjs update`
- **永不自己决定下一步** —— 一律问 `scheduler.cjs`
- **永不改写 `description`** —— 其中 `TS=` / `GLOBAL=` / `JOB=` / `STAGE=` 是路由标签，CLI 依赖它定位目标

## CLI 参考

```bash
node scripts/cli.cjs init [--ts=<TS>] [--auto-commit]        # 新建 pipeline（TS 缺省自动生成）
node scripts/cli.cjs resume --ts=<TS> [--latest] [--auto-commit]  # 续跑（--latest 按 mtime 找最新）
node scripts/cli.cjs update --agent=<a> --description="<d>" \
     [--ts=<TS>] [--output-file=<p> | --output=<text>]       # 持久化 Agent outcome
node scripts/cli.cjs report [--ts=<TS>] [--latest] [--json]  # 流水线报告（--json 含 jobs 数组）
node scripts/cli.cjs verify <paths...> | --handoff=<p>       # 校验产物 / handoff 中列出的文件存在
node scripts/cli.cjs perf-compare --baseline=<p> --final=<p> [--thresholds=<json>]  # 压测对比
node scripts/cli.cjs commit [--message=<t>] [--check] [--ts=<TS>]  # 手动重试 auto-commit（best-effort）
node scripts/scheduler.cjs --ts=<TS>                         # 输出下一条 JSON 调度指令
```

环境变量：

| 变量 | 默认 | 说明 |
|------|------|------|
| `PROJECT_DIR` | `process.cwd()` | 决定 `specs/` 路径解析 |
| `SPEC_FORGE_MAX_CONCURRENCY` | `5` | job coding 在飞并发上限；`0` = 不限，非法值回退默认 |

## 进度条（可选，Claude Code statusline）

`scripts/progress.cjs` 渲染流程灯（无百分比），经 session marker（`specs/session-active/<session-id>`）自动跟随本 session 的活跃 pipeline，新 pipeline 零重配：

```
sf ✓spec-check 3m12s → ✓task-decompose 1m04s → ✓baseline-regression 2m50s
✓implementation 5m30s → ▸verification 2m10s → ·evidence-verify
jobs: ✓J0-1 3m12s ✓J1-2 2m05s ·J2-3 …
verification r2: ✓testing 1m04s → ▸review 1m06s → ·regression → ·fix
```

在 `~/.claude/settings.json` 或项目 `.claude/settings.json` 中启用（`refreshInterval: 5` 必需，否则 in-flight Task 期间进度条不走秒）：

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

statusline 是 Claude Code 专属的可选增强；skill 本体保持 IDE 无关。

## 关键不变量

修改代码时必须保持（由 247 个测试守住）：

| 不变量 | 说明 |
|--------|------|
| PASSED 不降级 | 任何 recompute / update 不得把 PASSED 改回中间态 |
| state.json 原子写 | tmp + rename，进程崩溃不留半截文件 |
| 30 分钟 stale 检测 | IN_PROGRESS 超时标记 FAILED，可 retry |
| `depends_on` 环检测 | 环状 job-manifest 直接 `fail`，不进入调度 |
| content-manifest 门禁 | `coding-manifest-{JOB}.json` / `test-manifest.json` 缺失或非法 → 该阶段 FAILED |
| 基线门 | baseline-regression 不过，流水线不写一行代码 |
| description 路由协议 | `dispatch-scope.cjs` 的 `encode`/`decode` 是唯一格式契约 |

其他行为契约：损坏的 `state.json` 会先备份为 `*.corrupt.<ts>.<timestamp>` 再回退默认态；`retry` 走 `transition` 状态机（清理上次残留的 markers/artifacts）；verification 子阶段 stale 重派有 attempt 上限。

## 开发

```bash
node --test '__tests__/*.cjs'   # 247 个测试，要求全绿
```

| 需求 | 改哪里 |
|------|--------|
| 调整流水线阶段 | `config.cjs` 阶段枚举 + `state.cjs` `defaultState()` |
| 调整重试 | `config.cjs` `DEFAULT_RETRY_POLICY`（仅 `global_max_retries` 生效） |
| 改 Agent 行为 | `agents/{name}.md`（保持 HANDOFF 契约） |
| 加审查规则 | `rules/security.md` 或 `rules/testing.md` |
| 改调度逻辑 | `scheduler.cjs`（保持不变量） |
| 改 description 格式 | `dispatch-scope.cjs` |
| 改状态机规则 | `stage-entry.cjs`（`transition`/`recompute`） |
| 改持久化 / TS 生命周期 | `store.cjs` |

约束：行为变更必须带测试；测试相互隔离、不依赖执行顺序；回归脚本只测已发布行为（新特性验收在 `testing` 阶段补）。详见 `rules/testing.md`。

## 已知限制

- `state.json` 中的 artifacts 为绝对路径，项目目录改名后 `resume` 不可靠（记档，待后续设计相对路径方案）。
- 旧版本（v6/v7）`state.json` 不迁移——零兼容策略，旧 TS 目录归档重跑。
- verification 的四子阶段精细仪式（testing/review/regression/fix + 轮次归档）是有意保留的抗 LLM 演化设计，粗化为「verify→fix→reverify」是下一轮候选。

## 文档导航

| 文档 | 内容 |
|------|------|
| [`SKILL.md`](SKILL.md) | 主代理操作契约：完整循环、指令处理、截断恢复、auto-commit |
| [`rules/testing.md`](rules/testing.md) | 测试约束：隔离、不依赖执行顺序、回归脚本边界 |

> 代码是真实来源，文档仅作导航；变更后请同步更新。
