# SCE - Scene Capability Engine

[![npm version](https://badge.fury.io/js/scene-capability-engine.svg)](https://badge.fury.io/js/scene-capability-engine)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**SCE 是面向 AI 原生软件交付的场景能力编排引擎。**  
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
| Studio 工作流 | `studio plan -> generate -> apply -> verify -> release` | 对话到发布路径结构化 |
| 自动闭环交付 | `auto close-loop`、`close-loop-program`、`close-loop-controller` | 无人值守有界收敛 |
| 多 Agent 编排 | DAG 调度、重试、429 自适应并行 | 并行执行稳定可控 |
| 领域/本体治理 | problem-domain chain + scene template + gate 校验 | 降低语义回归 |
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

## AI Agent 适配

SCE 对工具无锁定，可接入 Codex、Claude Code、Cursor、Windsurf、VS Code Copilot 等。

- 运行时上下文统一由 `.sce/` 管理（不依赖特定 IDE 隐藏目录）。
- 会话治理默认场景优先：`1 scene = 1 primary session`。
- Spec 执行作为子会话自动归档，支持跨轮次追踪。

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

**版本**：3.3.26  
**最后更新**：2026-03-02
