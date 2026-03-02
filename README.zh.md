# SCE - Scene Capability Engine

[![npm version](https://badge.fury.io/js/scene-capability-engine.svg)](https://badge.fury.io/js/scene-capability-engine)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**SCE 是面向 AI 原生软件交付的场景能力引擎。**  
它提供从 `goal -> scene -> spec -> patch -> verify -> release` 的可控闭环。

[English](README.md) | 简体中文

---

## 为什么用 SCE

SCE 面向希望让 AI Agent 端到端推进交付、同时保持治理可控的团队。

- 以 Spec 先行，减少需求漂移和返工。
- 从单任务执行扩展到多 Agent 程序级编排。
- 通过强制门禁、ontology 校验、发布证据避免“看起来完成”。
- 通过本地时间线快照保护过程资产，不只依赖 Git 推送。

---

## 核心能力矩阵

| 能力 | SCE 提供什么 | 结果 |
| --- | --- | --- |
| Scene + Spec 模型 | 场景主会话治理 + Spec 生命周期（需求/设计/任务） | 长周期 AI 上下文稳定 |
| 自动 intake + Spec 治理 | 目标意图识别、自动绑定/创建 spec、按 scene 组合治理 | 场景需求自动纳管，spec 增长可控 |
| Studio 工作流 | `studio plan -> generate -> apply -> verify -> release` | 对话到发布路径结构化 |
| 自动闭环交付 | `auto close-loop`、`close-loop-program`、`close-loop-controller` | 无人值守有界收敛 |
| 多 Agent 编排 | DAG 调度、重试、429 自适应并行 | 并行执行稳定可控 |
| 领域/本体治理 | problem-domain chain + scene template + gate 校验 | 降低语义回归 |
| 问题闭环治理 | problem-domain map + chain + `problem-contract` + closure gate | 根因优先修复，过程有界收敛 |
| 问题评估路由 | 分阶段风险/证据/就绪度评分 + 强制策略 | `apply/release` 可控阻断，执行路径自适应 |
| 本地时间线安全 | `timeline save/auto/list/show/restore/push` + 关键节点自动打点 | 本地历史可回放可恢复 |
| Errorbook 修复体系 | 本地 + 注册表错题库 + 发布门禁 | 定位更快、修复更稳 |
| 发布治理 | git 管理门禁、errorbook 门禁、handoff preflight、tag 发布链路 | 可审计、可复现发布 |

---

## 3 分钟快速上手

```bash
# 1) 安装
npm install -g scene-capability-engine

# 2) 在项目中启用
sce adopt

# 3) 打开主场景会话
sce studio plan --scene scene.demo --from-chat session-demo --goal "bootstrap first feature" --json

# 4) 生成并执行一个 Spec
sce spec bootstrap --name 01-00-first-feature --scene scene.demo --non-interactive
sce spec pipeline run --spec 01-00-first-feature --scene scene.demo
```

需要全自动推进时：

```bash
sce auto close-loop "deliver customer + order + inventory baseline"
```

---

## 推荐使用路径

### 1) 功能交付（默认路径）
```bash
sce studio plan --scene scene.customer-order --from-chat session-20260302 --goal "optimize checkout"
sce spec bootstrap --name 02-00-checkout-optimization --scene scene.customer-order --non-interactive
sce spec domain coverage --spec 02-00-checkout-optimization --json
sce spec gate run --spec 02-00-checkout-optimization --scene scene.customer-order --json
```

### 2) 程序级自动交付
```bash
sce auto close-loop-program "stabilize order lifecycle and release governance" --program-govern-until-stable --json
```

### 3) 本地历史安全（时间线）
```bash
sce timeline save --summary "before risky refactor"
sce timeline list --limit 20
sce timeline restore <snapshot-id>
sce timeline push origin main
```

### 4) 发布基线
```bash
sce auto handoff preflight-check --require-pass --json
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

---

## 默认问题解决闭环

SCE 默认按“问题域闭环”推进诊断与修复：

1. 先收敛问题域边界：`problem-domain-map.md`、`scene-spec.md`、`problem-domain-chain.json`、`problem-contract.json`。
2. 试错过程进入 incident staging（`.sce/errorbook/staging/incidents/`），避免重复犯错。
3. 由 problem evaluation 在变更前优先排序高相关区域，再进入 apply/release。

默认硬规则：
- 同一问题指纹失败两轮后，后续尝试必须补充 debug 证据。
- 当 spec 绑定时，`studio verify/release` 默认执行 `problem-closure-gate`。
- `studio plan` 默认执行目标 intake（自动绑定已有 spec 或新建 spec），并自动写入 scene 维度的 spec 治理快照。
- 默认策略会阻断 `studio plan --manual-spec` 与 `--no-spec-governance`（仅在确有必要且策略显式放开时可绕过）。
- 历史 spec 可通过 `sce studio backfill-spec-scenes --apply` 分批回填到 scene 治理映射（写入 `.sce/spec-governance/spec-scene-overrides.json`）。

---

## AI Agent 适配

SCE 对工具无锁定，可接入 Codex、Claude Code、Cursor、Windsurf、VS Code Copilot 等。

- 运行时上下文统一由 `.sce/` 管理（不依赖特定 IDE 隐藏目录）。
- 会话治理默认场景优先：`1 scene = 1 primary session`。
- Spec 执行作为子会话自动归档，支持跨轮次追踪。
- 启动时会自动识别已接管项目并对齐接管基线默认配置。
- 问题评估策略默认启用（`.sce/config/problem-eval-policy.json`），Studio 各阶段都会执行评估。
- 问题闭环策略默认启用（`.sce/config/problem-closure-policy.json`），缺失必要问题/领域证据时会在 verify/release 阶段阻断。
- 错误处理默认进入完整 incident 闭环：每次记录先落到 staging 试错链路，verified/promoted 后自动收束归档。
- 也可显式审计/修正接管基线：
  - `sce workspace takeover-audit --json`
  - `sce workspace takeover-apply --json`

---

## 重要版本变更

- `3.5.0`：新增 Studio 目标自动 intake + 场景 spec 组合治理（`sce studio intake`、`sce studio portfolio`），并默认启用 intake 策略基线与治理快照产物，控制场景内 spec 无序增长。
- `3.4.6`：新增默认 `problem-closure-gate` + `problem-contract` 基线，并强化问题评估强制维度（`problem_contract`/`ontology_alignment`/`convergence`），提升 verify/release 收敛控制。
- `3.4.5`：`git-managed-gate` 在默认 CI 放宽模式下（`CI/GITHUB_ACTIONS` 且非 strict）对工作区变更改为告警，不再误阻断发布。
- `3.4.4`：新增 `SCE_GIT_MANAGEMENT_ALLOW_UNTRACKED=1` / `--allow-untracked`；发布工作流在 npm publish 前生成证据资产时可放行未跟踪文件。
- `3.4.3`：Studio 全阶段接入强制问题评估（`plan/generate/apply/verify/release`），并引入策略文件 `.sce/config/problem-eval-policy.json` 与评估报告落盘。
- `3.4.2`：Errorbook 升级为完整 incident staging 闭环（尝试记录、incident 查询、resolved 归档）。
- `3.4.1`：新增 workspace takeover baseline 自动化（`takeover-audit` / `takeover-apply`）与启动对齐能力。

---

## 文档导航

建议先看：

- [快速开始](docs/zh/quick-start.md)
- [命令参考](docs/command-reference.md)
- [自动闭环指南](docs/autonomous-control-guide.md)
- [场景运行时指南](docs/scene-runtime-guide.md)
- [Value 可观测指南](docs/zh/value-observability-guide.md)
- [多 Agent 协同指南](docs/multi-agent-coordination-guide.md)
- [Errorbook 注册表指南](docs/errorbook-registry.md)
- [文档总览](docs/zh/README.md)

Moqui 方向：

- [Moqui 模板核心库 Playbook](docs/moqui-template-core-library-playbook.md)
- [Moqui 标准重建指南](docs/moqui-standard-rebuild-guide.md)

---

## 社区

- [GitHub Discussions](https://github.com/heguangyong/scene-capability-engine/discussions)
- [GitHub Issues](https://github.com/heguangyong/scene-capability-engine/issues)

<img src="docs/images/wechat-qr.png" width="200" alt="微信群二维码">

扫码添加微信并备注 `sce` 入群。

---

## License

MIT，见 [LICENSE](LICENSE)。

---

**版本**：3.5.0  
**最后更新**：2026-03-02
