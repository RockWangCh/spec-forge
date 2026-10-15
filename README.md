# spec-forge

跨 IDE 的多阶段编码流水线编排 Skill（基于 Claude Code 的 Task 子代理体系）。它本身不生成业务代码，只做三件事：

1. **调度** — `scripts/scheduler.cjs` 纯函数决策，每轮返回下一步 JSON 指令
2. **持久化** — `scripts/cli.cjs update` 是 `state.json` 的唯一写口（outcome 持久化主入口）
3. **分发** — 主代理通过 Task 工具调用 `agents/` 下的专项 Agent 执行实际工作

循环直到 scheduler 返回 `done` 或 `fail`。流水线可在任意 IDE（Claude Code、TRAE、Cursor 等）中启动，并经 `cli.cjs resume --ts=<TS>` 在任意其他 IDE 续跑——无需 hooks。

## 流水线

```
spec-check (spec-checker)
  → task-decompose (task-decomposer)
  → baseline-regression (regression-runner)     [全量 build+test，FAIL → 终止流水线（项目本来就坏）]
  → implementation                                [复合阶段：扁平 job DAG]
        └─ jobs[].coding（implementer，按 acyclic depends_on 并行，并发上限默认 5）
  → verification                                  [复合阶段：testing → review → regression → (fix ↺ ≤2 轮)]
  → evidence-verify (evidence-verifier)
```

- **扁平 job DAG（全语言通用）**：`implementation` 持有扁平 `jobs[]`，每个 job 只做 `coding`，由 acyclic `depends_on` 排序；scheduler 以 `dispatch_batch` 一次性返回所有依赖就绪的 job，支持流式更新（先返回的 job 立即落盘并解锁下游）。并发上限默认 5，`SPEC_FORGE_MAX_CONCURRENCY` 可覆盖（0 = 不限）。
- **验证不做 per-wave**：全部 job coding PASS 后，对整份变更集跑一次全局 `verification`：testing（test-generator，产出全局 `test-manifest.json`）→ review（code-reviewer，`review-report.md`）→ regression（regression-runner，全量 build+test），失败进入 `fix` 循环（fixer）。fix WARN 视为软通过；`max_retries` 轮耗尽则 verification FAILED。
- **内容清单门**：job coding 必须产出 `specs/{TS}/coding-manifest-<jobId>.json`，testing 必须产出 `specs/{TS}/test-manifest.json`（AC→测试追溯）。`cli.cjs update` 校验清单存在且字段完整，缺失直接判 FAIL——不只是 pass/fail，而是强制留痕。

## 使用方式

把本仓库安装为 Claude Code 的 Skill（目录名 `spec-forge`），然后对 Claude 说：

```
/spec-forge <需求描述>              # 全新流水线，从头开始
/spec-forge --auto-commit <需求>    # 完成后自动 commit
/spec-forge 继续上次                # 续跑已有流水线（cli.cjs resume）
```

主代理（编排者）按 `SKILL.md` 操作契约循环执行：

```
init → scheduler 循环 {
    dispatch / dispatch_batch  → Task 派发 agent（description 原样拷贝，含 TS=... GLOBAL=... 协议标签）
    wait                       → 有在飞 Task 则等待
    done / fail                → 退出循环
  | 每次 Task 返回 → cli.cjs update 落盘 → 再调 scheduler }
→ report → （可选）auto-commit
```

> 主代理是**薄编排层**：不做流水线决策、不直接写 `state.json`，一切经 CLI。

## 常用 CLI

```bash
node scripts/cli.cjs init [--ts=<TS>] [--auto-commit]   # 新建流水线，输出 JSON（含 ts）
node scripts/cli.cjs resume --ts=<TS> [--auto-commit]   # 续跑
node scripts/scheduler.cjs --ts=<TS>                    # 决策下一步（JSON 指令到 stdout）
node scripts/cli.cjs update --ts=<TS> --agent=<type> \
  --description="TS=... GLOBAL=..." --output-file=<handoff.json>   # 持久化 agent 结果
node scripts/cli.cjs report --ts=<TS> [--json]          # 流水线报告
node scripts/cli.cjs commit [--ts=<TS>]                 # 手动补跑 auto-commit
```

TS 是流水线的全局标识，由主代理显式传给每个 scheduler/update/report 调用。运行期产物（`state.json`、handoff、清单、日志）都在 `specs/{TS}/` 下，已被 gitignore。

## 仓库结构

```
SKILL.md            主代理操作契约（循环流程、指令处理、截断恢复）
CODE_WIKI.md        AI 维护参考：架构地图、模块依赖、文件职责
agents/             Agent 角色定义（spec-checker / task-decomposer / implementer /
                    test-generator / code-reviewer / regression-runner / fixer /
                    evidence-verifier）。Agent 自己读，主代理不读。
scripts/            核心实现（CommonJS，无第三方运行时依赖）
  scheduler.cjs       决策引擎 decideNext(state, config)
  state.cjs           状态模型 + 门面（default 工厂 / 访问器 / recompute / 谓词）
  store.cjs           持久化 seam：state.json 读写 + TS 生命周期
  stage-entry.cjs     StageEntry 状态机：transition / recompute / isStaleRun
  cli.cjs             统一 CLI：init / update / report / verify / perf-compare / commit
  subagent-handler.cjs  Agent 完成事件处理（状态变更核心）
  config.cjs          配置唯一源：阶段枚举 + agent 映射 + 阈值
  dispatch-scope.cjs  description 协议 encode/decode
  markers.cjs         HANDOFF JSON 解析；diff.cjs 变更检测；logger.cjs 日志；
  progress.cjs 状态栏（optional）；perf.cjs 压测对比
rules/              共享规则模板（testing.md / security.md），按项目定制
docs/               DESIGN.md（设计决策日志）、SIMPLIFY.md（精简计划留痕）
__tests__/          node:test 单元测试（16 个文件，全部绿）
```

## 开发与测试

无第三方运行时依赖，Node 原生 `node:test`。注意：`node --test` 需**逐文件**运行（目录整体运行在该 Node 版本上会把目录当作单个测试条目）：

```bash
node --test __tests__/scheduler.test.cjs            # 单文件
for f in __tests__/*.test.cjs __tests__/*.verify.cjs; do node --test "$f" || break; done   # 全量
```

测试覆盖的不变量包括：PASSED 不降级、原子写、stale 检测、DAG 环检测、流式并发不重复派发、清单门校验、auto-commit 路径。

## 核心设计文档

- `docs/DESIGN.md` — 经多轮 grilling 对齐的设计决策日志（状态模型、循环语义、job-DAG 重构）
- `docs/SIMPLIFY.md` — 2026-10 梳理与精简计划（架构判断：核心承重、外围精简）
- `CODE_WIKI.md` — 给 AI 维护者看的地图与契约
