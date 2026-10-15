# CLAUDE.md

本仓库是 **spec-forge** —— 跨 IDE 的多阶段编码流水线编排 Skill。先读 `README.md`（项目定位与流水线全景）、`CODE_WIKI.md`（架构地图与文件职责）、`docs/DESIGN.md`（设计决策日志）。

## 项目本质约束

- 本项目**不生成业务代码**，只做三件事：调度（`scheduler.cjs`）、持久化（`cli.cjs update` 写 `state.json`）、分发（Task 调专项 agent）。任何「让流水线自己写业务代码」的改动都是方向性错误。
- **薄编排原则**：主代理不做流水线决策、不直接写 `state.json`。所有状态变更必须经 `scripts/cli.cjs update`（scheduler 亦就地标记 IN_PROGRESS/stale 并写回，是已知例外）。
- **单一写口**：`state.json` 的写入口只有 `cli.cjs update` / `scheduler.cjs main()`。新增绕过这两个入口的写路径 = 架构破坏。
- **配置唯一源**：阶段枚举、agent 映射、阈值只在 `scripts/config.cjs`。禁止在其他文件里硬编码阶段名或 agent 名。

## 架构不变量（改动前必读，违反即 bug）

1. **状态机不降级**：stage 状态只能沿合法迁移路径前进（见 `stage-entry.cjs` 的 `transition`），PASSED 不允许被改回 FAILED/PENDING 等。`recompute`（派生聚合）与显式 `transition` 是两条不同路径，不得混用。
2. **原子写**：`state.json` 写入必须原子（temp + rename，见 `store.cjs`）。任何新持久化路径沿用此模式。
3. **DAG 约束**：`implementation.jobs[]` 的 `depends_on` 必须 acyclic，scheduler 有环检测 fail-fast。新增调度逻辑不得绕过环检测。
4. **stale 检测**：`isStaleRun` 防止旧 run 的迟到结果覆盖新状态。新增异步路径必须保留该防线。
5. **description 协议**：dispatch description 含 `TS=... GLOBAL=...` / `TS=... JOB=... STAGE=coding` 标签，由 `dispatch-scope.cjs` encode/decode。修改格式必须同时改 encode、decode 与 `__tests__/dispatch-scope.test.cjs`。
6. **内容清单门**：job coding 产出 `specs/{TS}/coding-manifest-<jobId>.json`，testing 产出 `specs/{TS}/test-manifest.json`；`cli.cjs update` 校验存在 + 可解析 + 关键字段，缺失即 FAIL。不得弱化为"仅 pass/fail"。
7. **verification 循环语义**：`testing → review → regression → (fix ↺)`，testing FAIL 跳过 review+regression 直达 fix，fix WARN 软通过，`max_retries` 耗尽即 FAILED。语义见 `docs/DESIGN.md` 与 `SKILL.md`，改动必须同步两处文档 + `__tests__/verification.test.cjs`。
8. **schema_version**：改状态模型必须递增 `schema_version` 并提供兼容读取；`docs/state.v6-historical.json` 是历史样例。

## 代码风格

- **纯 CommonJS（`.cjs`）**，Node 原生能力，**零第三方运行时依赖**。新增依赖 = 需要明确理由，默认拒绝。
- **模块分层**（见 `CODE_WIKI.md` 依赖图）：
  - 叶子模块（无内部依赖）：`config.cjs`、`store.cjs`、`dispatch-scope.cjs`、`logger.cjs`、`markers.cjs`、`perf.cjs`
  - 禁止引入循环依赖；新模块先想清楚它属于哪一层。
- **scheduler.cjs 的 `decideNext(state, config)` 是纯函数**：同样的 state 进，同样的指令出。禁止在其中读时钟、随机数、文件系统或环境变量（并发上限等配置经 `config.cjs` 注入）。
- **注释与文档语言**：仓库现有文档为中英混排（说明性文字多用中文、代码与 API 用英文）。跟随现状，不要单方面全面切换语言。
- **与周边代码一致**：命名、错误处理（exit code 0/1）、JSON stdout 输出格式均跟随现有模块。

## 测试要求

- **每个行为变更都要带测试**。测试框架为 Node 原生 `node:test`，放在 `__tests__/`，命名 `*.test.cjs`（手动验证脚本用 `*.verify.cjs`）。
- **运行方式（重要）**：本环境下 `node --test` 必须逐文件运行，目录整体运行会失败：

  ```bash
  node --test __tests__/scheduler.test.cjs
  # 全量：
  for f in __tests__/*.test.cjs __tests__/*.verify.cjs; do node --test "$f" || exit 1; done
  ```

- 当前基线：16 个测试文件、247 个用例全绿。提交前必须全量跑过；有任何 fail 不允许交付。
- 测试写法跟随现有文件：`decideNext` 用构造好的 state 对象直接断言，不 mock 文件系统；涉及 `state.json` 读写用临时目录并在 teardown 清理。
- **不弱化现有断言**：放宽断言需要明确理由并在 PR 中说明。
- 优先测行为而非实现细节；覆盖边界与失败路径（环、stale、截断、清单缺失）。

## 文档同步义务

代码行为变更时，以下文档必须同步，否则视为文档漂移（本仓库历史上吃过亏，见 `docs/SIMPLIFY.md`）：

| 改动 | 必须同步 |
|------|----------|
| 流水线语义 / 循环规则 | `SKILL.md` + `docs/DESIGN.md` |
| 状态模型 / schema | `docs/DESIGN.md` + `CODE_WIKI.md` + 递增 `schema_version` |
| 模块职责 / 依赖 | `CODE_WIKI.md` |
| 阶段枚举 / agent 映射 / 阈值 | `scripts/config.cjs` 唯一修改点 |
| 面向用户的使用方式 | `README.md` |

## 安全红线（摘要，全文见 `rules/security.md`）

- 永不读取、打印、记录或提交 `.env`、凭据、私钥、token。
- 严禁把用户输入拼接进 shell 命令；`child_process.exec` 只用常量字符串。
- 路径由外部输入构造时必须校验（防 traversal）。
- 提交信息与日志不泄露内部路径、IP、端口。

## Git 约定

- 运行期产物 `specs/` 已 gitignore，不得把 `state.json`、handoff、日志提交进仓库。
- 提交前：全量测试绿 + 相关文档已同步。
- 主分支为 `main`；未经要求不主动 commit/push。
