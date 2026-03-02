# SCE - Scene Capability Engine

[![npm version](https://badge.fury.io/js/scene-capability-engine.svg)](https://badge.fury.io/js/scene-capability-engine)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**SCE is a scene capability orchestration engine for AI-native software delivery.**  
It provides a deterministic path from `goal -> scene -> spec -> patch -> verify -> release`.

English | [简体中文](README.zh.md)

---

## Why SCE

SCE is designed for teams that want AI agents to deliver software end-to-end without losing control.

- Keep delivery aligned to requirements through Spec-first workflows.
- Scale from single-task execution to multi-agent program orchestration.
- Prevent silent drift with mandatory gates, ontology checks, and release evidence.
- Preserve local work history with timeline snapshots, not just Git pushes.

---

## Core Capabilities

| Capability | What SCE Provides | Outcome |
| --- | --- | --- |
| Scene + Spec model | Scene-governed sessions and Spec lifecycle (`requirements/design/tasks`) | Stable context across long AI runs |
| Studio workflow | `studio plan -> generate -> apply -> verify -> release` | Structured chat-to-release execution |
| Autonomous delivery | `auto close-loop`, `close-loop-program`, `close-loop-controller` | Unattended bounded convergence |
| Multi-agent orchestration | DAG scheduling, retries, 429 adaptive parallel control | Reliable parallel execution at scale |
| Domain/ontology governance | problem-domain chain + scene template + gate validation | Fewer semantic regressions |
| Local timeline safety | `timeline save/auto/list/show/restore/push` + key-event auto checkpoints | Recoverable local history |
| Errorbook-driven repair | Local + registry-backed error patterns and release gates | Faster diagnosis and safer fixes |
| Release governance | Git-managed gate, errorbook gate, handoff preflight, tag pipeline | Auditable, reproducible releases |

---

## 3-Minute Quick Start

```bash
# 1) Install
npm install -g scene-capability-engine

# 2) Adopt in your project
sce adopt

# 3) Open a primary scene session
sce studio plan --scene scene.demo --from-chat session-demo --goal "bootstrap first feature" --json

# 4) Bootstrap and run one Spec
sce spec bootstrap --name 01-00-first-feature --scene scene.demo --non-interactive
sce spec pipeline run --spec 01-00-first-feature --scene scene.demo
```

For autonomous execution:

```bash
sce auto close-loop "deliver customer + order + inventory baseline"
```

---

## Recommended Workflows

### 1) Feature Delivery (default)
```bash
sce studio plan --scene scene.customer-order --from-chat session-20260302 --goal "optimize checkout"
sce spec bootstrap --name 02-00-checkout-optimization --scene scene.customer-order --non-interactive
sce spec domain coverage --spec 02-00-checkout-optimization --json
sce spec gate run --spec 02-00-checkout-optimization --scene scene.customer-order --json
```

### 2) Program-Scale Autonomous Delivery
```bash
sce auto close-loop-program "stabilize order lifecycle and release governance" --program-govern-until-stable --json
```

### 3) Local History Safety (timeline)
```bash
sce timeline save --summary "before risky refactor"
sce timeline list --limit 20
sce timeline restore <snapshot-id>
sce timeline push origin main
```

### 4) Release Baseline
```bash
sce auto handoff preflight-check --require-pass --json
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

---

## AI Agent Compatibility

SCE is tool-agnostic and works with Codex, Claude Code, Cursor, Windsurf, VS Code Copilot, and other CLI-capable agents.

- Runtime context is managed by `.sce/` (not IDE-specific hidden folders).
- Session governance is scene-first: `1 scene = 1 primary session`.
- Spec work is attached as child sessions and auto-archived.
- Startup now auto-detects adopted projects and aligns takeover baseline defaults automatically.
- Error handling now follows a full incident loop by default: every record attempt is staged first and auto-closed on verified/promoted outcomes.
- You can inspect or force-align baseline explicitly:
  - `sce workspace takeover-audit --json`
  - `sce workspace takeover-apply --json`

---

## Documentation Map

Start here:

- [Quick Start](docs/quick-start.md)
- [Command Reference](docs/command-reference.md)
- [Autonomous Control Guide](docs/autonomous-control-guide.md)
- [Scene Runtime Guide](docs/scene-runtime-guide.md)
- [Value Observability Guide](docs/value-observability-guide.md)
- [Multi-Agent Coordination Guide](docs/multi-agent-coordination-guide.md)
- [Errorbook Registry Guide](docs/errorbook-registry.md)
- [Documentation Hub](docs/README.md)

Moqui-focused:

- [Moqui Template Core Library Playbook](docs/moqui-template-core-library-playbook.md)
- [Moqui Standard Rebuild Guide](docs/moqui-standard-rebuild-guide.md)

---

## Community

- [GitHub Discussions](https://github.com/heguangyong/scene-capability-engine/discussions)
- [GitHub Issues](https://github.com/heguangyong/scene-capability-engine/issues)

<img src="docs/images/wechat-qr.png" width="200" alt="WeChat Group QR Code">

Scan the QR code and note `sce` to join the WeChat group.

---

## License

MIT. See [LICENSE](LICENSE).

---

**Version**: 3.4.1  
**Last Updated**: 2026-03-02
