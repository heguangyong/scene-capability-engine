# Command Reference

> Quick reference for all `sce` commands

**Version**: 3.4.4
**Last Updated**: 2026-03-02

---

## Command Naming

The CLI provides three command aliases:
- `sce` - **Recommended primary command** (use this in all documentation)
- `sce` - Legacy short alias (compatible)
- `scene-capability-engine` - Legacy full alias (compatible)

**Always use `sce` in new examples and documentation.**

---

## Installation

```bash
npm install -g scene-capability-engine
```

This creates the `sce` command globally. Legacy aliases `sce` and `scene-capability-engine` are still available.

---

## Core Commands

### Project Setup

```bash
# Initialize new project
sce init [project-name]

# Adopt existing project
sce adopt

# Check project status
sce status

# Run system diagnostics
sce doctor
```

### Spec Management

```bash
# Ensure an active scene primary session exists first
sce studio plan --scene scene.customer-order-inventory --from-chat session-20260226 --goal "spec delivery cycle" --json

# Legacy low-level: create spec directory only
sce create-spec 01-00-feature-name

# Bootstrap full Spec draft (requirements/design/tasks)
sce spec bootstrap --name 01-00-feature-name --scene scene.customer-order-inventory --non-interactive
# Bootstrap now also generates mandatory scene artifacts:
# - .sce/specs/<spec>/custom/problem-domain-map.md
# - .sce/specs/<spec>/custom/scene-spec.md
# - .sce/specs/<spec>/custom/problem-domain-chain.json (machine-readable chain model)

# Run pipeline for one Spec
sce spec pipeline run --spec 01-00-feature-name --scene scene.customer-order-inventory

# Run gate for one Spec
sce spec gate run --spec 01-00-feature-name --scene scene.customer-order-inventory --json

# Maintain domain modeling artifacts explicitly
sce spec domain init --spec 01-00-feature-name --scene scene.customer-order-inventory --json
sce spec domain validate --spec 01-00-feature-name --fail-on-error --json
sce spec domain validate --spec 01-00-feature-name --fail-on-gap --json
sce spec domain coverage --spec 01-00-feature-name --json
sce spec domain refresh --spec 01-00-feature-name --scene scene.customer-order-inventory --json

# Find related historical specs before starting a new analysis
sce spec related --query "customer order inventory reconciliation drift" --scene scene.customer-order-inventory --json
sce spec related --spec 01-00-feature-name --limit 8 --json

# Multi-Spec mode defaults to orchestrate routing
sce spec bootstrap --specs "spec-a,spec-b" --max-parallel 3
sce spec pipeline run --specs "spec-a,spec-b" --max-parallel 3
sce spec gate run --specs "spec-a,spec-b" --max-parallel 3

# Show Spec progress
sce status --verbose
```

Spec session governance:
- `spec bootstrap|pipeline run|gate run` must bind to an active scene primary session (`--scene <scene-id>` or implicit binding from latest/unique active scene).
- When multiple active scenes exist, you must pass `--scene` explicitly.
- Multi-Spec orchestrate fallback (`--specs ...`) follows the same scene binding and writes per-spec child-session archive records.
- `spec bootstrap` always generates problem-domain and scene-spec artifacts to force domain-first exploration.
- `spec gate` now hard-fails when either of the following is missing or structurally incomplete:
  - `.sce/specs/<spec>/custom/problem-domain-map.md`
  - `.sce/specs/<spec>/custom/scene-spec.md`
  - `.sce/specs/<spec>/custom/problem-domain-chain.json`
- Closed-loop scene research baseline is now part of domain modeling artifacts:
  - `problem-domain-map.md` must include `Closed-Loop Research Coverage Matrix`
  - `scene-spec.md` must include `Closed-Loop Research Contract`
  - `problem-domain-chain.json` must include `research_coverage` contract
- `sce spec domain coverage` reports coverage dimensions (scene boundary, entity/relation/rules/policy/flow, failure signals, debug evidence plan, verification gate).

### Timeline Snapshots

```bash
# Manual checkpoint
sce timeline save --summary "before large refactor" --json

# Auto interval checkpoint tick (skips when interval is not reached)
sce timeline auto --json

# List and inspect snapshots
sce timeline list --limit 20 --json
sce timeline show <snapshot-id> --json

# Restore workspace to a snapshot (safe mode keeps extra files)
sce timeline restore <snapshot-id> --json

# Hard restore (also prune files not in snapshot)
sce timeline restore <snapshot-id> --prune --json

# Update timeline policy
sce timeline config --enabled true --interval 30 --max-entries 120 --json

# Push with pre-push snapshot
sce timeline push origin main
```

Timeline policy:
- default enabled with local retention under `.sce/timeline/snapshots/`
- stage/key-event checkpoints are automatically captured for `studio` and `session` commands
- interval auto-checkpoints are integrated in the same flow via timeline checkpoint capture

### Value Metrics

```bash
# Generate sample KPI input JSON
sce value metrics sample --out ./kpi-input.json --period 2026-W10 --json

# Generate weekly KPI snapshot + gate summary
sce value metrics snapshot \
  --input .sce/specs/112-00-spec-value-realization-program/custom/weekly-metrics/2026-W09.sample.json \
  --period 2026-W09 \
  --checkpoint day-60 \
  --json

# Use custom metric contract and output paths
sce value metrics snapshot \
  --input ./metrics-input.json \
  --definitions .sce/specs/112-00-spec-value-realization-program/custom/metric-definition.yaml \
  --history-dir .sce/specs/114-00-kpi-automation-and-observability/custom/weekly-metrics \
  --out .sce/specs/114-00-kpi-automation-and-observability/custom/weekly-metrics/2026-W10.json

# Generate baseline from earliest 3 history snapshots
sce value metrics baseline \
  --definitions .sce/specs/112-00-spec-value-realization-program/custom/metric-definition.yaml \
  --history-dir .sce/specs/114-00-kpi-automation-and-observability/custom/weekly-metrics \
  --from-history 3 \
  --period 2026-W10 \
  --json

# Generate trend report from latest 6 snapshots
sce value metrics trend \
  --definitions .sce/specs/112-00-spec-value-realization-program/custom/metric-definition.yaml \
  --history-dir .sce/specs/114-00-kpi-automation-and-observability/custom/weekly-metrics \
  --window 6 \
  --json
```

### Task Management

```bash
# Claim a task
sce task claim <spec-name> <task-id>

# Unclaim a task
sce task unclaim <spec-name> <task-id>

# Show task status
sce task status <spec-name>
```

### Context & Prompts

```bash
# Export spec context
sce context export <spec-name>

# Export with steering rules
sce context export <spec-name> --steering

# Generate task prompt
sce prompt generate <spec-name> <task-id>

# Generate for specific tool
sce prompt generate <spec-name> <task-id> --tool=claude-code
```

### Universal Steering & Session

```bash
# Initialize universal steering contract (.sce/steering)
sce steering init

# Compile steering package for a specific agent tool
sce steering compile --tool codex --agent-version 1.2.3 --format json --json
sce steering compile --tool claude --agent-version 0.9.0

# Start/resume/snapshot cross-agent runtime sessions
sce session start "ship order workflow hardening" --tool codex --agent-version 1.2.3 --id release-20260224
sce session resume release-20260224 --status active
sce session snapshot release-20260224 --summary "post-gate checkpoint" --payload '{"tests_passed":42}' --json
sce session show release-20260224 --json
```

Session governance defaults:
- `1 scene = 1 primary session` (managed by `studio plan --scene ...`)
- `spec` runs can bind as child sessions (`spec bootstrap|pipeline --scene <scene-id>`)
- successful `studio release` auto-archives current scene session and opens next cycle session

### Watch Mode

```bash
# Initialize watch configuration
sce watch init

# Start watch mode
sce watch start

# Stop watch mode
sce watch stop

# Check watch status
sce watch status

# View watch logs
sce watch logs

# Follow log stream in real time (tail -f behavior)
sce watch logs --follow

# Show last 100 entries, then continue following
sce watch logs --tail 100 --follow

# Show automation metrics
sce watch metrics

# List available presets
sce watch presets

# Install a preset
sce watch install <preset-name>
```

### Workflows

```bash
# List available workflows
sce workflows

# Show workflow details
sce workflows show <workflow-name>

# Open workflow guide
sce workflows guide

# Mark workflow as complete
sce workflows complete <workflow-name>
```

### Workspace Management

```bash
# Create a new workspace
sce workspace create <name> [path]

# List all workspaces
sce workspace list

# Switch active workspace
sce workspace switch <name>

# Show workspace info
sce workspace info [name]

# Remove a workspace
sce workspace remove <name> [--force]

# Scan for legacy .kiro directories in the workspace tree
sce workspace legacy-scan
sce workspace legacy-scan --max-depth 8 --json

# Migrate legacy .kiro directories to .sce (safe merge when .sce already exists)
# Non-dry-run migration now requires explicit manual confirmation.
sce workspace legacy-migrate --confirm
sce workspace legacy-migrate --dry-run --json
# Recommended: always run dry-run first, then execute manual migration
# sce workspace legacy-migrate --dry-run
# sce workspace legacy-migrate --confirm

# Audit tracked .sce assets required for deterministic CI/release behavior
sce workspace tracking-audit
sce workspace tracking-audit --json

# Audit takeover baseline drift (non-mutating)
sce workspace takeover-audit
sce workspace takeover-audit --json
sce workspace takeover-audit --strict

# Apply takeover baseline defaults explicitly
sce workspace takeover-apply
sce workspace takeover-apply --json

# Safety guardrail (default):
# If legacy .kiro directories exist, sce blocks non-migration commands
# until manual migration is completed.
# For adopted projects, startup auto-runs takeover baseline alignment
# before command execution (best effort, non-blocking).

# Legacy commands (still supported)
sce workspace sync
sce workspace team
```

### Environment Management

```bash
# List all environments
sce env list

# Switch to environment (with automatic backup)
sce env switch <name>

# Show active environment details
sce env info

# Register new environment from config file
sce env register <config-file>

# Remove environment (requires --force)
sce env unregister <name> --force

# Rollback to previous environment
sce env rollback

# Verify current environment (optional)
sce env verify

# Run command in environment context (optional)
sce env run "<command>"
```

### Multi-Repository Management

```bash
# Initialize repository configuration
sce repo init [--force] [--depth <n>]

# Show status of all repositories
sce repo status [--verbose] [--json]

# Execute command in all repositories
sce repo exec "<command>" [--dry-run]

# Check repository health
sce repo health [--json]
```

### Agent Orchestration (Codex)

```bash
# Start orchestration for multiple specs
sce orchestrate run --specs "spec-a,spec-b,spec-c" --max-parallel 3

# One-shot anti-429 profile override (without editing orchestrator.json)
sce orchestrate run --specs "spec-a,spec-b,spec-c" --rate-limit-profile conservative

# Show orchestration status
sce orchestrate status [--json]

# Stop all running sub-agents
sce orchestrate stop

# List/show/set persistent rate-limit profile
sce orchestrate profile list
sce orchestrate profile show --json
sce orchestrate profile set conservative
sce orchestrate profile set balanced --reset-overrides
```

When you pass `--specs` to `sce spec bootstrap|pipeline run|gate run`, sce now defaults to this orchestrate mode automatically.

Rate-limit profiles:
- `conservative`: strongest anti-429 throttling (recommended for unstable quota windows)
- `balanced`: default profile for normal multi-agent runs
- `aggressive`: higher throughput with lower protection margins

### Errorbook (Curated Failure Knowledge)

```bash
# Record curated remediation entry
sce errorbook record \
  --title "Order approval queue saturation" \
  --symptom "Approval queue backlog exceeded SLA" \
  --root-cause "Worker pool under-provisioned and retries amplified load" \
  --fix-action "Increase workers from 4 to 8" \
  --fix-action "Reduce retry burst window" \
  --verification "Load test confirms p95 < SLA threshold" \
  --ontology "entity,relation,decision_policy" \
  --tags "moqui,order,performance" \
  --status verified \
  --json

# Inspect temporary trial-and-error incident loop
sce errorbook incident list --state open --json
sce errorbook incident show <incident-id> --json

# List/show/find entries
sce errorbook list --status promoted --min-quality 75 --json
sce errorbook show <entry-id> --json
sce errorbook find --query "approve order timeout" --limit 10 --json
sce errorbook find --query "approve order timeout" --include-registry --json
# Prefer remote indexed search for large registry
sce errorbook find --query "approve order timeout" --include-registry --registry-mode remote --json
sce errorbook find --query "approve order timeout" --include-registry --registry-mode hybrid --json

# Export curated local entries for central registry publication
sce errorbook export --status promoted --min-quality 75 --out .sce/errorbook/exports/registry.json --json

# Sync central registry (GitHub raw URL or local file) to local cache
sce errorbook sync-registry --source https://raw.githubusercontent.com/heguangyong/sce-errorbook-registry/main/registry/errorbook-registry.json --json

# Validate registry config/source/index health
sce errorbook health-registry --json

# Promote only after strict gate checks pass
sce errorbook promote <entry-id> --json

# Eliminate obsolete/low-value entries (curation)
sce errorbook deprecate <entry-id> --reason "superseded by v2 policy" --json

# Requalify deprecated entry after remediation review
sce errorbook requalify <entry-id> --status verified --json

# Record controlled temporary mitigation (stop-bleeding only, must include governance fields)
sce errorbook record \
  --title "Temporary fallback for order approval lock contention" \
  --symptom "Fallback path enabled to keep approval flow available" \
  --root-cause "Primary lock ordering fix is in progress" \
  --fix-action "Ship lock ordering fix and remove fallback path" \
  --temporary-mitigation \
  --mitigation-reason "Emergency stop-bleeding in production" \
  --mitigation-exit "Primary path concurrency tests are green" \
  --mitigation-cleanup "spec/remove-order-approval-fallback" \
  --mitigation-deadline 2026-03-15T00:00:00Z \
  --json

# Release hard gate (default in prepublish and studio release preflight)
sce errorbook release-gate --min-risk high --fail-on-block --json

# Git managed hard gate (default in prepublish and studio release preflight)
node scripts/git-managed-gate.js --fail-on-violation --json

# Registry health gate (advisory by default; strict when env enabled)
node scripts/errorbook-registry-health-gate.js --json
SCE_REGISTRY_HEALTH_STRICT=1 node scripts/errorbook-registry-health-gate.js --json
```

Curated quality policy (`宁缺毋滥，优胜略汰`) defaults:
- All issues enter an incident loop by default:
  - each `errorbook record` writes one staging attempt under `.sce/errorbook/staging/incidents/`
  - staging incidents preserve full trial-and-error history to avoid repeated mistakes
  - when record status reaches `verified|promoted|deprecated`, the incident auto-resolves and snapshot is archived under `.sce/errorbook/staging/resolved/`
- `record` requires: `title`, `symptom`, `root_cause`, and at least one `fix_action`.
- Fingerprint dedup is automatic; repeated records merge evidence and increment occurrence count.
- Repeated-failure hard rule: from attempt `#3` of the same fingerprint (two failed rounds already happened), record must include debug evidence.
  Recommended forms: `--verification "debug: ..."` or tag `debug-evidence` or debug trace/log file references.
- `promote` enforces strict gate:
  - `root_cause` present
  - `fix_actions` non-empty
  - `verification_evidence` non-empty
  - `ontology_tags` non-empty
  - `quality_score >= 75`
- `deprecate` requires explicit `--reason` to preserve elimination traceability.
- `requalify` only accepts `candidate|verified`; `promoted` must still go through `promote` gate.
- `release-gate` blocks release when unresolved high-risk `candidate` entries remain.
- Temporary mitigation is allowed only as stop-bleeding and must include:
  - `mitigation_exit` (exit criteria)
  - `mitigation_cleanup` (cleanup task/spec)
  - `mitigation_deadline` (deadline)
- `release-gate` also blocks when temporary mitigation policy is violated:
  - missing exit/cleanup/deadline metadata
  - expired mitigation deadline
- `export` outputs a machine-readable registry bundle from curated local entries (recommended default: `promoted`, `quality>=75`).
- `sync-registry` pulls external registry JSON into local cache (`.sce/errorbook/registry-cache.json`) for unified `find` retrieval.
- `find --include-registry --registry-mode remote` supports direct remote query for large registries (no full local sync required).
- Recommended for large registries: maintain a remote index file (`registry/errorbook-registry.index.json`) and shard files, then provide `index_url` in registry config.
- Since `v3.3.23`, `sce init` / `sce adopt` default baseline includes enabled central registry config in `.sce/config/errorbook-registry.json`.
- `health-registry` validates config readability, source/index accessibility, and index-to-shard resolution before release.
- `gate:errorbook-registry-health` runs in advisory mode by default during `prepublishOnly`.
  Set `SCE_REGISTRY_HEALTH_STRICT=1` to fail release when registry health reports errors.
- `git-managed-gate` blocks release when:
  - worktree has uncommitted changes
  - branch has no upstream
  - branch is ahead/behind upstream
  - upstream is not a GitHub/GitLab remote (when such remotes exist)
- If project has no GitHub/GitLab remote, gate passes by default (can hard-enforce with `--no-allow-no-remote` or `SCE_GIT_MANAGEMENT_ALLOW_NO_REMOTE=0`).
- In CI/tag detached-HEAD context (`CI=1` or `GITHUB_ACTIONS=1`), branch/upstream sync checks are relaxed by default.
  Use `SCE_GIT_MANAGEMENT_STRICT_CI=1` (or `--strict-ci`) to enforce full local-level branch checks in CI.
- When CI generates temporary release artifacts before `npm publish`, you can allow untracked-only worktree drift while keeping tracked-change protection:
  - `SCE_GIT_MANAGEMENT_ALLOW_UNTRACKED=1` (or `--allow-untracked`)
  - tracked file changes still fail the gate.

### Studio Workflow

```bash
# Build a plan from chat/session context (scene is mandatory and becomes the primary session anchor)
sce studio plan --scene scene.customer-order-inventory --from-chat session-20260226 --goal "customer+order+inventory demo" --json
# Recommended: bind spec explicitly so Studio can ingest problem-domain-chain deterministically
sce studio plan --scene scene.customer-order-inventory --spec 01-00-customer-order-inventory --from-chat session-20260226 --goal "customer+order+inventory demo" --json

# Generate patch bundle metadata (scene is inherited from plan)
sce studio generate --target 331 --json
# Optional explicit scene check (must match planned scene)
sce studio generate --scene scene.customer-order-inventory --target 331 --json

# Apply generated patch metadata
sce studio apply --patch-bundle patch-scene.customer-order-inventory-<timestamp> --json

# Record verification result
sce studio verify --profile standard --json
sce studio verify --profile strict --json

# Record release event
sce studio release --channel dev --profile standard --json
sce studio release --channel dev --profile strict --json

# Resume from latest or explicit job
sce studio resume --job <job-id> --json

# Inspect recent stage events
sce studio events --job <job-id> --limit 50 --json

# Rollback a job after apply/release
sce studio rollback --job <job-id> --reason "manual-check-failed" --json

# Enforce authorization for a protected action
SCE_STUDIO_REQUIRE_AUTH=1 SCE_STUDIO_AUTH_PASSWORD=top-secret sce studio apply --job <job-id> --auth-password top-secret --json
```

Stage guardrails are enforced by default:
- `plan` requires `--scene`; SCE binds one active primary session per scene
- `plan --spec <id>` (recommended) ingests `.sce/specs/<spec>/custom/problem-domain-chain.json` into studio job context
- when `--spec` is omitted, `plan` auto-resolves the latest matching spec chain by `scene_id` when available
- `plan` auto-searches related historical specs by `scene + goal` and writes top candidates into job metadata (`source.related_specs`)
- successful `release` auto-archives current scene session and auto-opens the next scene cycle session
- `generate` requires `plan`
- `generate` consumes the plan-stage domain-chain context and writes chain-aware metadata/report (`.sce/reports/studio/generate-<job-id>.json`)
- `apply` requires `generate`
- `verify` requires `apply`
- `release` requires `verify`
- `verify` / `release` reports and failure auto-records inherit `spec_id + domain-chain` context for better root-cause traceability

Problem evaluation mode (default required):
- Studio now runs problem evaluation on every stage: `plan`, `generate`, `apply`, `verify`, `release`.
- Default policy file: `.sce/config/problem-eval-policy.json` (also provisioned by template/adopt/takeover baseline).
- Default hard-block stages: `apply`, `release`.
- Evaluation combines risk/evidence/readiness and emits adaptive strategy:
  - `direct-execution`
  - `controlled-execution`
  - `evidence-first`
  - `explore-and-validate`
  - `debug-first`
- Evaluation report artifact is written to `.sce/reports/problem-eval/<job-id>-<stage>.json`.
- Stage metadata and event payload now include `problem_evaluation` summary plus artifact pointer.
- Environment overrides:
  - `SCE_PROBLEM_EVAL_MODE=off|advisory|required`
  - `SCE_PROBLEM_EVAL_DISABLED=1`

Studio gate execution defaults:
- `verify --profile standard` runs executable gates (unit test script when available, interactive governance report when present, scene package publish-batch dry-run when handoff manifest exists)
- `release --profile standard` runs executable release preflight (npm pack dry-run, git managed gate, errorbook release gate, weekly ops gate when summary exists, release asset integrity when evidence directory exists, scene package publish-batch ontology gate, handoff capability matrix gate)
- `verify/release --profile strict` fails when any required gate step is skipped (for example missing manifest/evidence/scripts)
- Required gate failures are auto-recorded into `.sce/errorbook` as `candidate` entries (tagged `release-blocker`) for follow-up triage.

Authorization model (optional, policy-driven):
- Enable policy: `SCE_STUDIO_REQUIRE_AUTH=1`
- Secret env key: `SCE_STUDIO_AUTH_PASSWORD` (or override key name with `SCE_STUDIO_PASSWORD_ENV`)
- Protected actions: `apply`, `release`, `rollback`
- Per-command hard requirement: add `--require-auth`

Default policy file (recommended to commit): `.sce/config/studio-security.json`

```json
{
  "enabled": false,
  "require_auth_for": ["apply", "release", "rollback"],
  "password_env": "SCE_STUDIO_AUTH_PASSWORD"
}
```

### Capability Matrix Utilities

```bash
# 1) Strategy routing: decide answer_only | code_change | code_fix | rollback
node scripts/auto-strategy-router.js \
  --input '{"goal_type":"bugfix","requires_write":true,"test_failures":2,"changed_files":1}' \
  --policy-file docs/agent-runtime/strategy-routing-policy-baseline.json \
  --json

# 2) Symbol evidence localization: query -> ranked file/line/symbol hits
node scripts/symbol-evidence-locate.js \
  --workspace . \
  --query "approve order" \
  --min-reliable-score 0.60 \
  --json

# Strict evidence gate: exit code 2 when no reliable hit is found
node scripts/symbol-evidence-locate.js \
  --workspace . \
  --query "reconcile invoice accrual" \
  --strict \
  --json

# 3) Failure attribution + bounded self-repair plan (single repair pass max by default)
node scripts/failure-attribution-repair.js \
  --error "Cannot find module @acme/order-core" \
  --attempted-passes 0 \
  --max-repair-passes 1 \
  --tests "npm run test -- order-service" \
  --json

# 4) Scene template + ontology capability mapping report
node scripts/capability-mapping-report.js \
  --input-file .sce/reports/capability-mapping-input.json \
  --out .sce/reports/capability-mapping-report.json \
  --json
```

Contract/baseline files:
- `docs/agent-runtime/symbol-evidence.schema.json`
- `docs/agent-runtime/failure-taxonomy-baseline.json`
- `docs/agent-runtime/capability-mapping-report.schema.json`
- `docs/agent-runtime/agent-result-summary-contract.schema.json`
- `docs/agent-runtime/multi-agent-coordination-policy-baseline.json`
- `docs/agent-runtime/orchestrator-rate-limit-profiles.md`

Multi-agent merge governance default:
- `sce orchestrate run` loads `docs/agent-runtime/multi-agent-coordination-policy-baseline.json`.
- When `coordination_rules.require_result_summary=true`, each sub-agent must produce `spec_id/changed_files/tests_run/tests_passed/risk_level/open_issues`.
- Merge is blocked when summary contract is invalid, when `tests_passed < tests_run` (if enabled), or when unresolved conflict issues are present (if enabled).

### Autonomous Close-Loop Program

```bash
# One-command close-loop execution:
# goal -> auto master/sub decomposition -> collab metadata -> orchestration -> terminal result
# default behavior is enforced autonomous progression (no per-step confirmation pauses)
sce auto close-loop "build autonomous close-loop and master/sub orchestration"
# default sub-spec count is auto-selected by goal complexity (typically 3-5)

# Preview decomposition only
sce auto close-loop "build autonomous close-loop and master/sub orchestration" --dry-run --json

# Generate plan but skip orchestration run
sce auto close-loop "build autonomous close-loop and master/sub orchestration" --no-run

# Run without live status stream output
sce auto close-loop "build autonomous close-loop and master/sub orchestration" --no-stream

# Add Definition-of-Done (DoD) test gate
sce auto close-loop "build autonomous close-loop and master/sub orchestration" \
  --dod-tests "npm run test:smoke"

# Strict DoD: require all tasks.md checklists are closed
sce auto close-loop "build autonomous close-loop and master/sub orchestration" \
  --dod-tasks-closed

# Write DoD evidence to custom report path
sce auto close-loop "build autonomous close-loop and master/sub orchestration" \
  --dod-report ".sce/reports/close-loop-dod.json"

# Resume from the latest close-loop session snapshot
sce auto close-loop --resume latest

# Resume from the latest interrupted close-loop session snapshot
sce auto close-loop --resume interrupted

# Quick continue shorthand (maps to --resume interrupted)
sce auto close-loop continue
sce auto close-loop 继续
sce auto continue

# Resume from a specific session id
sce auto close-loop --resume 117-20260214230000

# Apply session retention automatically after close-loop execution
sce auto close-loop "build autonomous close-loop and master/sub orchestration" \
  --session-keep 50 \
  --session-older-than-days 14

# Allow up to 2 automatic replan cycles on orchestration failures
sce auto close-loop "build autonomous close-loop and master/sub orchestration" \
  --replan-attempts 2

# Use adaptive replan budget strategy (default) or fixed
sce auto close-loop "build autonomous close-loop and master/sub orchestration" \
  --replan-strategy adaptive

# Run multiple goals in one autonomous batch (one master/sub portfolio per goal)
sce auto close-loop-batch .sce/goals.txt
sce auto close-loop-batch .sce/goals.json --dry-run --json

# Generate batch goals from one broad program goal (no goals file needed)
sce auto close-loop-batch \
  --decompose-goal "build autonomous close-loop, master/sub decomposition, orchestration and quality rollout" \
  --program-goals 4 \
  --program-min-quality-score 85 \
  --json

# Program command: broad goal -> auto split -> autonomous batch closed-loop execution
sce auto close-loop-program \
  "build autonomous close-loop, master/sub decomposition, orchestration and quality rollout" \
  --program-goals 4 \
  --program-quality-gate \
  --program-recover-max-rounds 6 \
  --program-recover-max-minutes 30 \
  --program-gate-profile staging \
  --program-gate-fallback-chain staging,prod \
  --program-gate-fallback-profile prod \
  --program-min-success-rate 95 \
  --program-max-risk-level medium \
  --program-govern-until-stable \
  --program-govern-max-rounds 3 \
  --program-govern-use-action 1 \
  --program-kpi-out .sce/reports/close-loop-program-kpi.json \
  --program-audit-out .sce/reports/close-loop-program-audit.json \
  --json

# Controller command: drain queued broad goals with close-loop-program runtime
sce auto close-loop-controller .sce/auto/program-queue.lines \
  --dequeue-limit 2 \
  --max-cycles 20 \
  --controller-done-file .sce/auto/program-done.lines \
  --controller-failed-file .sce/auto/program-failed.lines \
  --json

# Persistent controller mode: keep polling queue and execute new goals automatically
sce auto close-loop-controller .sce/auto/program-queue.lines \
  --wait-on-empty \
  --poll-seconds 30 \
  --max-cycles 1000 \
  --max-minutes 240

# Resume from latest persisted controller session
sce auto close-loop-controller --controller-resume latest --json

# Recovery command: replay unresolved goals from summary using remediation action strategy
sce auto close-loop-recover latest --json
sce auto close-loop-recover .sce/auto/close-loop-batch-summaries/batch-20260215090000.json \
  --use-action 2 \
  --recover-until-complete \
  --recover-max-rounds 3 \
  --recover-max-minutes 20 \
  --recovery-memory-ttl-days 30 \
  --recovery-memory-scope release-main \
  --program-audit-out .sce/reports/close-loop-recover-audit.json \
  --dry-run --json

# Default autonomous batch run (continue-on-error + adaptive scheduling + retry-until-complete)
sce auto close-loop-batch .sce/goals.json --json

# Run batch goals with concurrent close-loop workers
sce auto close-loop-batch .sce/goals.json --batch-parallel 3 --json

# Apply global agent budget across all concurrent goals
sce auto close-loop-batch .sce/goals.json \
  --batch-parallel 3 \
  --batch-agent-budget 6 \
  --json

# Prioritize complex goals first and enable anti-starvation aging
sce auto close-loop-batch .sce/goals.json \
  --batch-priority critical-first \
  --batch-aging-factor 3 \
  --json

# Automatically retry failed/stopped goals for one extra round
sce auto close-loop-batch .sce/goals.json \
  --batch-retry-rounds 1 \
  --batch-retry-strategy adaptive \
  --json

# Retry until all goals complete (bounded by max rounds)
sce auto close-loop-batch .sce/goals.json \
  --batch-retry-until-complete \
  --batch-retry-max-rounds 10 \
  --json

# Disable autonomous batch policy explicitly (only when you need legacy/manual tuning)
sce auto close-loop-batch .sce/goals.json \
  --no-batch-autonomous \
  --json

# Resume only pending goals from a previous batch summary
sce auto close-loop-batch --resume-from-summary .sce/reports/close-loop-batch.json --json

# Resume pending goals from latest persisted batch session summary
sce auto close-loop-batch --resume-from-summary latest --json

# Resume only failed/error goals from summary (ignore unprocessed goals)
sce auto close-loop-batch --resume-from-summary .sce/reports/close-loop-batch.json \
  --resume-strategy failed-only --json

# List persisted close-loop sessions
sce auto session list
sce auto session list --status completed,partial-failed
sce auto session list --limit 50 --json

# Aggregate close-loop session telemetry
sce auto session stats
sce auto session stats --days 14 --status completed --json

# Prune old close-loop sessions
sce auto session prune --keep 50
sce auto session prune --keep 20 --older-than-days 14 --dry-run

# List persisted spec directories
sce auto spec-session list
sce auto spec-session list --limit 100 --json

# Prune old spec directories
sce auto spec-session prune --keep 200
sce auto spec-session prune --keep 100 --older-than-days 30 --dry-run --json
sce auto spec-session prune --keep 100 --older-than-days 30 --show-protection-reasons --json

# List persisted close-loop-batch summary sessions
sce auto batch-session list
sce auto batch-session list --status failed
sce auto batch-session list --limit 50 --json

# Aggregate close-loop-batch summary telemetry
sce auto batch-session stats
sce auto batch-session stats --days 14 --status failed --json

# Prune old close-loop-batch summary sessions
sce auto batch-session prune --keep 50
sce auto batch-session prune --keep 20 --older-than-days 14 --dry-run

# List persisted close-loop-controller summary sessions
sce auto controller-session list
sce auto controller-session list --status partial-failed
sce auto controller-session list --limit 50 --json

# Aggregate close-loop-controller summary session telemetry
sce auto controller-session stats
sce auto controller-session stats --days 14 --status partial-failed --json

# Prune old close-loop-controller summary sessions
sce auto controller-session prune --keep 50
sce auto controller-session prune --keep 20 --older-than-days 14 --dry-run

# Aggregate cross-archive autonomous governance telemetry
sce auto governance stats
sce auto governance stats --days 14 --status completed,partial-failed --json
sce auto governance maintain --session-keep 50 --batch-session-keep 50 --controller-session-keep 50 --json
sce auto governance maintain --apply --session-keep 20 --batch-session-keep 20 --controller-session-keep 20 --recovery-memory-older-than-days 90 --json
sce auto governance close-loop --plan-only --max-rounds 3 --target-risk low --json
sce auto governance close-loop --max-rounds 3 --target-risk low --session-keep 20 --batch-session-keep 20 --controller-session-keep 20 --json
sce auto governance close-loop --max-rounds 3 --governance-session-keep 50 --governance-session-older-than-days 30 --json
sce auto governance close-loop --max-rounds 3 --target-risk low --execute-advisory --advisory-recover-max-rounds 3 --advisory-controller-max-cycles 20 --dry-run --json
sce auto governance close-loop --governance-resume latest --max-rounds 5 --json
sce auto governance close-loop --governance-resume latest --target-risk high --governance-resume-allow-drift --json
sce auto governance session list --limit 20 --status completed,failed --json
sce auto governance session list --resume-only --json
sce auto governance session stats --days 30 --json
sce auto governance session stats --resume-only --json
sce auto governance session prune --keep 50 --older-than-days 30 --dry-run --json

# Recovery memory maintenance
sce auto recovery-memory show --json
sce auto recovery-memory scopes --json
sce auto recovery-memory prune --older-than-days 30 --dry-run --json
sce auto recovery-memory clear --json

# Autonomous KPI trend (weekly/daily buckets + CSV export)
sce auto kpi trend --weeks 12 --period week --mode all --json
sce auto kpi trend --weeks 8 --period day --mode program --csv --out ./auto-kpi-trend.csv

# Unified observability snapshot (sessions + governance + KPI trend)
sce auto observability snapshot --days 14 --status completed,failed --json
sce auto observability snapshot --out .sce/reports/auto-observability.json --json

# Agent-facing spec interfaces
sce auto spec status 121-00-master --json
sce auto spec instructions 121-02-sub-track --json

# Autonomous archive schema compatibility
sce auto schema check --json
sce auto schema migrate --json                           # dry-run by default
sce auto schema migrate --apply --json                  # apply schema_version migration
sce auto schema migrate --only close-loop-session,batch-session --apply --json

# Dual-track handoff integration (generic external project -> sce)
sce auto handoff plan --manifest docs/handoffs/handoff-manifest.json --json
sce auto handoff plan --manifest docs/handoffs/handoff-manifest.json --strict --out .sce/reports/handoff-plan.json --json
sce auto handoff queue --manifest docs/handoffs/handoff-manifest.json --out .sce/auto/handoff-goals.lines --json
sce auto handoff template-diff --manifest docs/handoffs/handoff-manifest.json --json
sce auto handoff capability-matrix --manifest docs/handoffs/handoff-manifest.json --json
sce auto handoff capability-matrix --manifest docs/handoffs/handoff-manifest.json --profile moqui --json
sce auto handoff capability-matrix --manifest docs/handoffs/handoff-manifest.json --format markdown --out .sce/reports/handoff-capability-matrix.md --fail-on-gap --json
sce auto handoff run --manifest docs/handoffs/handoff-manifest.json --json
sce auto handoff run --manifest docs/handoffs/handoff-manifest.json --profile enterprise --json
sce auto handoff run --manifest docs/handoffs/handoff-manifest.json --min-spec-success-rate 95 --max-risk-level medium --json
sce auto handoff run --manifest docs/handoffs/handoff-manifest.json --continue-from latest --continue-strategy auto --json
sce auto handoff regression --session-id latest --json
sce auto handoff regression --session-id latest --window 5 --json
sce auto handoff regression --session-id latest --format markdown --out .sce/reports/handoff-regression.md --json
sce auto handoff regression --session-id latest --window 5 --out .sce/reports/handoff-regression.json --json
sce auto close-loop-batch .sce/auto/handoff-goals.lines --format lines --json
``` 

DoD-related options:
- `--dod-tests <command>`: run a final shell command as a completion gate
- `--dod-tests-timeout <ms>`: timeout for `--dod-tests` (default `600000`)
- `--dod-max-risk-level <low|medium|high>`: fail DoD when derived run risk is above threshold
- `--dod-kpi-min-completion-rate <n>`: minimum close-loop completion rate percent (`0-100`)
- `--dod-max-success-rate-drop <n>`: max allowed completion-rate drop vs recent baseline (`0-100`)
- `--dod-baseline-window <n>`: number of recent sessions used for baseline comparison (`1-50`, default `5`)
- `--dod-tasks-closed`: require no unchecked `- [ ]` items in generated `tasks.md`
- `--no-dod-docs`: skip doc completeness gate
- `--no-dod-collab`: skip collaboration completion gate
- `--no-dod`: disable all DoD gates
- `--dod-report <path>`: write DoD evidence report JSON to custom path
- `--no-dod-report`: disable automatic DoD report archive
- `--resume <session-or-file>`: resume from prior session id, `latest`, `interrupted` (latest non-completed session), or JSON path
  - Shorthand: `sce auto close-loop continue` / `sce auto close-loop 继续` equals `--resume interrupted`.
- `sce auto continue`: shortcut command that resumes latest interrupted close-loop session.
- `--session-id <id>`: set explicit session id for persistence
- `--no-session`: disable close-loop session persistence
- `--session-keep <n>`: prune sessions after run and keep newest `n` snapshots
- `--session-older-than-days <n>`: when pruning, only delete sessions older than `n` days
- `--subs <n>`: override automatic decomposition count (`2-5`)
- `--replan-strategy <strategy>`: `adaptive` or `fixed` replan budget strategy
- `--replan-attempts <n>`: max automatic replan cycles after failed orchestration (`0-5`, default `1`)
- `--replan-no-progress-window <n>`: stop replan when no progress repeats for `n` failed cycles (`1-10`, default `3`)
- `--no-replan`: disable automatic replan cycle
- `--no-conflict-governance`: disable lease-conflict prediction and scheduling guard
- `--no-ontology-guidance`: disable scene ontology `agent_hints` scheduling guidance

Close-loop batch (`sce auto close-loop-batch <goals-file>`) options:
- supports shared close-loop execution options (for example: `--subs`, `--max-parallel`, `--dod*`, `--replan*`, `--dry-run`, `--json`)
- `--format <format>`: parse goals file as `auto`, `json`, or `lines` (default `auto`)
- `--decompose-goal <goal>`: auto-split one broad goal into multiple batch goals using semantic clauses/categories
- `--program-goals <n>`: target generated-goal count for `--decompose-goal` (`2-12`, default adaptive)
- `--program-min-quality-score <n>`: minimum decomposition quality score before auto-refinement (`0-100`, default `70`)
- `--program-quality-gate`: fail fast if final decomposition quality is still below `--program-min-quality-score`
- `--resume-from-summary <path>`: derive pending goals from an existing batch summary (reruns failed/error and previously unprocessed goals)
- `--resume-from-summary latest`: load the most recent persisted batch session summary automatically
- `--resume-strategy <strategy>`: `pending` (default) or `failed-only` for summary resume scope
- `--batch-parallel <n>`: run up to `n` goals concurrently (`1-20`, default adaptive under autonomous policy)
- `--batch-agent-budget <n>`: global agent parallel budget shared by all running goals (`1-500`)
- `--batch-priority <strategy>`: scheduling strategy `fifo`, `complex-first`, `complex-last`, or `critical-first` (default `complex-first` under autonomous policy)
- `--batch-aging-factor <n>`: waiting-goal aging boost per scheduling cycle (`0-100`, default `2` under autonomous policy)
- `--batch-retry-rounds <n>`: retry failed/stopped goals for `n` additional rounds (`0-5`, default `0`, or until-complete under autonomous policy)
- `--batch-retry-strategy <strategy>`: retry strategy `adaptive` (default) or `strict`
- `--batch-retry-until-complete`: keep retrying until no failed/stopped goals remain or max rounds reached
- `--batch-retry-max-rounds <n>`: max extra rounds for `--batch-retry-until-complete` (`1-20`, default `10`)
- `--no-batch-autonomous`: disable autonomous closed-loop defaults and rely on explicit batch flags
- `--batch-session-id <id>`: set explicit persisted batch session id
- `--batch-session-keep <n>`: keep newest `n` persisted batch summaries after each run (`0-1000`)
- `--batch-session-older-than-days <n>`: when pruning persisted batch summaries, only delete sessions older than `n` days (`0-36500`)
- `--spec-session-keep <n>`: keep newest `n` spec directories under `.sce/specs` after run (`0-5000`)
- `--spec-session-older-than-days <n>`: when pruning specs, only delete directories older than `n` days (`0-36500`)
- `--no-spec-session-protect-active`: allow pruning active/recently referenced spec directories
- `--spec-session-protect-window-days <n>`: protection window (days) for recent session references during spec pruning (`0-36500`, default `7`)
- `--spec-session-max-total <n>`: spec directory budget ceiling under `.sce/specs` (`1-500000`)
- `--spec-session-max-created <n>`: spec growth guard for maximum estimated created directories per run (`0-500000`)
- `--spec-session-max-created-per-goal <n>`: spec growth guard for estimated created directories per processed goal (`0-1000`)
- `--spec-session-max-duplicate-goals <n>`: goal-input duplicate guard for batch runs (`0-500000`)
- `--spec-session-budget-hard-fail`: fail run when spec count exceeds `--spec-session-max-total` before/after execution
- `--no-batch-session`: disable automatic persisted batch summary session archive
- `--continue-on-error`: continue remaining goals after a failed/error goal (enabled by default under autonomous policy)
- `--out <path>`: write batch summary JSON output file
- `--resume` and `--session-id` are not supported in batch mode (sessions are per-goal)
- `--program-goals` requires `--decompose-goal`
- `<goals-file>`, `--resume-from-summary`, and `--decompose-goal` are mutually exclusive goal sources
- Batch summary includes `resource_plan` (budget/effective parallel/per-goal maxParallel/scheduling strategy/aging/starvation wait metrics/criticality summary) and `metrics` (`success_rate_percent`, `status_breakdown`, `average_sub_specs_per_goal`, `average_replan_cycles_per_goal`, `total_rate_limit_signals`, `average_rate_limit_signals_per_goal`, `total_rate_limit_backoff_ms`)
  - Under budget mode, scheduler is complexity-weighted (`goal_weight`/`scheduling_weight`) so higher-complexity goals consume more shared slots and can reduce same-batch concurrency.
  - Batch summary includes `batch_retry` telemetry (strategy, until-complete mode, configured/max/performed rounds, exhausted flag, per-round history).
  - Under `--batch-retry-strategy adaptive`, retry history includes rate-limit pressure and next-round backpressure decisions (`applied_batch_parallel`, `next_batch_parallel`, `adaptive_backpressure_applied`, `backpressure_level`). Severe pressure automatically halves `batch_parallel` / `batch_agent_budget` for the next retry round.
  - Batch summary includes `batch_session` metadata when persisted (session id + file path).
  - When using `--decompose-goal`, summary includes `generated_from_goal` metadata (strategy, target count, produced count, clause/category diagnostics, decomposition `quality`, and refinement telemetry).

Close-loop program (`sce auto close-loop-program "<goal>"`) options:
- Automatically enables autonomous batch policy (hands-off closed-loop defaults) and uses semantic decomposition from one broad goal.
- `--program-goals <n>`: target generated-goal count (`2-12`, default adaptive)
- Supports batch execution controls (`--batch-parallel`, `--batch-agent-budget`, `--batch-priority`, `--batch-aging-factor`, `--batch-retry*`)
- Supports batch summary persistence controls (`--batch-session-id`, `--batch-session-keep`, `--batch-session-older-than-days`, `--no-batch-session`)
- Supports spec retention controls (`--spec-session-keep`, `--spec-session-older-than-days`, `--no-spec-session-protect-active`)
  - Includes `--spec-session-protect-window-days` to tune recent-reference protection window.
  - Includes `--spec-session-max-total` and optional `--spec-session-budget-hard-fail` for spec-count budget governance.
- `--no-program-auto-recover`: disable built-in recovery loop after non-completed program runs
- `--program-recover-use-action <n>`: pin remediation action for auto recovery (otherwise sce uses learned memory or default action `1`)
- `--program-recover-resume-strategy <pending|failed-only>`: resume scope for built-in program recovery (default `pending`)
- `--program-recover-max-rounds <n>`: bounded recovery rounds for built-in program recovery (`1-20`, default `5`)
- `--program-recover-max-minutes <n>`: elapsed-time budget for built-in program recovery loop (minutes, default unlimited)
- `--program-gate-profile <profile>`: convergence gate profile (`default|dev|staging|prod`) to set baseline success/risk policy
- `--program-gate-fallback-profile <profile>`: fallback gate profile (`none|default|dev|staging|prod`, default `none`) used only when primary gate fails
- `--program-gate-fallback-chain <profiles>`: ordered fallback profiles (comma-separated) evaluated after primary gate failure
- `--program-min-success-rate <n>`: convergence gate minimum success rate percent (`0-100`, default `100`)
- `--program-max-risk-level <low|medium|high>`: convergence gate risk ceiling (default `high`)
- `--program-max-elapsed-minutes <n>`: convergence gate elapsed-time budget in minutes (`1-10080`, default unlimited)
- `--program-max-agent-budget <n>`: convergence gate max allowed agent budget/effective parallel budget (`1-500`)
- `--program-max-total-sub-specs <n>`: convergence gate max total sub-specs across program goals (`1-500000`)
- `--no-program-gate-auto-remediate`: disable automatic remediation hints/prune attempts after gate failure
- `--program-govern-until-stable`: enable post-run governance loop that keeps replaying/recovering until gate/anomaly stability
- `--program-govern-max-rounds <n>`: max governance rounds (`1-20`, default `3`)
- `--program-govern-max-minutes <n>`: elapsed-time budget for governance loop (`1-10080`, default `60`)
- `--program-govern-anomaly-weeks <n>`: KPI lookback weeks for anomaly-triggered governance (`1-260`, default `8`)
- `--program-govern-anomaly-period <week|day>`: KPI bucket period for anomaly governance checks (default `week`)
- `--no-program-govern-anomaly`: disable anomaly-triggered governance and only govern by gate/budget failures
- `--program-govern-use-action <n>`: pin remediation action index (`1-20`) used in governance rounds
- `--no-program-govern-auto-action`: disable automatic remediation action selection/execution in governance rounds
- `--program-min-quality-score <n>`: minimum semantic decomposition quality score before automatic refinement (`0-100`, default `70`)
- `--program-quality-gate`: fail run when final decomposition quality remains below `--program-min-quality-score`
- `--recovery-memory-scope <scope>`: scope key for recovery memory isolation (default auto: project + git branch)
- Supports shared close-loop options (`--subs`, `--max-parallel`, `--dod*`, `--replan*`, `--dry-run`, `--json`, `--out`)
- `--program-kpi-out <path>`: write a standalone program KPI snapshot JSON (`convergence_state`, `risk_level`, retry recovery, complexity ratio, wait profile)
- `--program-audit-out <path>`: write a program audit JSON (`program_coordination`, `recovery_cycle`, `program_gate`, and selected strategy metadata)
- Program summary includes `program_kpi`, `program_gate`, `program_gate_fallbacks`, `program_gate_effective`, and optional `program_kpi_file` / `program_audit_file` for portfolio-level observability pipelines.
  - `program_gate` now supports unified budget checks (success/risk + elapsed time + agent budget + total sub-spec ceiling).
  - On gate/budget failure, summary can include `program_gate_auto_remediation` with auto patch/prune actions.
- With `--program-govern-until-stable`, summary additionally includes:
  - `program_governance` (round history, stop reason, exhausted/converged state)
  - `program_governance` includes action-selection metadata (`auto_action_enabled`, `action_selection_enabled`, `pinned_action_index`, per-round `selected_action*`).
  - `program_kpi_trend` and `program_kpi_anomalies` (anomaly-aware governance context, including `rate-limit-spike` pressure that can auto-reduce `batchParallel`/`batchAgentBudget`).
- Program summary includes `program_diagnostics` with `failure_clusters` and `remediation_actions` (prioritized follow-up commands for convergence).
- Program summary includes `program_coordination` (master/sub topology, unresolved goal indexes, scheduler snapshot) and `auto_recovery` metadata.

Close-loop controller (`sce auto close-loop-controller [queue-file]`) options:
- `queue-file`: optional queue file path (default `.sce/auto/close-loop-controller-goals.lines`)
- `--controller-resume <session-or-file>`: resume from persisted controller session (`latest`, session id, or file path)
- `--queue-format <auto|json|lines>`: queue parser mode (default `auto`)
- `--no-controller-dedupe`: disable duplicate broad-goal deduplication (default dedupe enabled)
- `--dequeue-limit <n>`: consume up to `n` goals per controller cycle (`1-100`, default `all` pending goals)
- `--wait-on-empty`: keep polling when queue is empty instead of stopping
- `--poll-seconds <n>`: polling interval for `--wait-on-empty` (`1-3600`, default `30`)
- `--max-cycles <n>`: max controller cycles (`1-100000`, default `1000`)
- `--max-minutes <n>`: elapsed-time budget in minutes (`1-10080`, default `120`)
- `--controller-lock-file <path>`: explicit lease lock file (default `<queue-file>.lock`)
- `--controller-lock-ttl-seconds <n>`: stale lock takeover threshold (`10-86400`, default `1800`)
- `--no-controller-lock`: disable controller lease lock (unsafe for concurrent controllers)
- `--stop-on-goal-failure`: stop immediately when one dequeued goal fails
- `--controller-session-id <id>`: set explicit persisted controller session id
- `--controller-session-keep <n>` / `--controller-session-older-than-days <n>`: retention policy for persisted controller sessions
- `--no-controller-session`: disable controller session persistence
- `--controller-out <path>`: write controller summary JSON
- `--controller-done-file <path>` / `--controller-failed-file <path>`: append completed/failed goals into line archives
- `--controller-print-program-summary`: print each nested `close-loop-program` summary during controller execution
- Supports program execution controls (`--program-*`, `--batch-*`, `--continue-on-error`, `--recovery-memory-scope`, `--dry-run`, `--json`) and runs each dequeued queue goal through full autonomous program flow.
- Summary includes controller telemetry (`history`, `results`, final `pending_goals`, `stop_reason`, `exhausted`, dedupe/lock/session metadata) plus optional done/failed archive file paths.

Close-loop recovery (`sce auto close-loop-recover [summary]`) options:
- `summary`: optional summary file path; defaults to `latest` persisted batch summary
- `--use-action <n>`: choose remediation action index from diagnostics (`1` by default)
- `--resume-strategy <pending|failed-only>`: control recovery goal scope from source summary
- `--recover-until-complete`: keep running recovery rounds until converged or max rounds reached
- `--recover-max-rounds <n>`: max recovery rounds for until-complete mode (`1-20`, default `5`)
- `--recover-max-minutes <n>`: elapsed-time budget for recovery loop (minutes, default unlimited)
- `--recovery-memory-ttl-days <n>`: prune stale recovery memory entries before auto action selection (`0-36500`)
- `--recovery-memory-scope <scope>`: scope key for recovery memory isolation (default auto: project + git branch)
- Supports batch controls (`--batch-parallel`, `--batch-agent-budget`, `--batch-priority`, `--batch-aging-factor`, `--batch-retry*`, `--no-batch-autonomous`)
- Supports spec retention controls (`--spec-session-keep`, `--spec-session-older-than-days`, `--no-spec-session-protect-active`)
  - Includes `--spec-session-protect-window-days` to tune recent-reference protection window.
  - Includes `--spec-session-max-total` and optional `--spec-session-budget-hard-fail` for spec-count budget governance.
- Supports program gate controls (`--program-gate-profile`, `--program-gate-fallback-*`, `--program-min-success-rate`, `--program-max-risk-level`, `--program-max-elapsed-minutes`, `--program-max-agent-budget`, `--program-max-total-sub-specs`)
  - Includes `--no-program-gate-auto-remediate` to disable automatic remediation hints/prune attempts.
- Supports quality/session controls (`--dod*`, `--replan*`, `--batch-session*`, `--program-kpi-out`, `--program-audit-out`, `--out`, `--dry-run`, `--json`)
- If `--use-action` is omitted, sce automatically selects remediation action from learned recovery memory when available.
- Output includes `recovered_from_summary`, `recovery_plan` (`applied_patch`, available remediation actions, `selection_source`, `selection_explain`), `recovery_cycle` (round history, convergence/exhausted state, elapsed/budget metadata), and `recovery_memory` (signature, scope, action stats, selection explanation).

Close-loop session maintenance:
- `sce auto session list [--limit <n>] [--status <csv>] [--json]`: list persisted close-loop sessions (`--status` supports comma-separated, case-insensitive filters)
- `sce auto session stats [--days <n>] [--status <csv>] [--json]`: aggregate persisted close-loop session telemetry within an optional recent-day window
- `sce auto session prune [--keep <n>] [--older-than-days <n>] [--dry-run] [--json]`: prune old session snapshots
  - List JSON output includes `status_filter` and `status_counts` over filtered sessions.
  - Stats JSON output includes `criteria`, completion/failure rates, `sub_spec_count_sum`, `master_spec_counts`, and `latest_sessions`.

Spec directory maintenance:
- `sce auto spec-session list [--limit <n>] [--json]`: list persisted spec directories under `.sce/specs`
- `sce auto spec-session prune [--keep <n>] [--older-than-days <n>] [--no-protect-active] [--protect-window-days <n>] [--show-protection-reasons] [--dry-run] [--json]`: prune old spec directories by retention policy (default protects active/recent specs)
  - Protection sources include collaboration state, close-loop sessions, batch summaries, and controller sessions (via nested batch summary references).
  - JSON output always includes `protection_ranking_top` (top protected specs by reason count); `--show-protection-reasons` additionally includes per-spec `reasons` and full `protection_ranking`.
- Batch/program/recover summaries can include `spec_session_budget` telemetry when `--spec-session-max-total` is configured.

Close-loop batch session maintenance:
- `sce auto batch-session list [--limit <n>] [--status <csv>] [--json]`: list persisted close-loop-batch summary sessions (`--status` supports comma-separated, case-insensitive filters)
- `sce auto batch-session stats [--days <n>] [--status <csv>] [--json]`: aggregate persisted close-loop-batch summary telemetry within an optional recent-day window
- `sce auto batch-session prune [--keep <n>] [--older-than-days <n>] [--dry-run] [--json]`: prune old persisted batch summaries
  - List JSON output includes `status_filter` and `status_counts` over filtered sessions.
  - Stats JSON output includes `criteria`, completion/failure rates, goal-volume sums, processed ratio, and `latest_sessions`.

Close-loop controller session maintenance:
- `sce auto controller-session list [--limit <n>] [--status <csv>] [--json]`: list persisted close-loop-controller summary sessions (`--status` supports comma-separated, case-insensitive filters)
- `sce auto controller-session stats [--days <n>] [--status <csv>] [--json]`: aggregate persisted close-loop-controller status/throughput telemetry within an optional recent-day window
- `sce auto controller-session prune [--keep <n>] [--older-than-days <n>] [--dry-run] [--json]`: prune old persisted controller summaries
  - List JSON output includes `status_filter` and `status_counts` over filtered sessions.
  - Stats JSON output includes `criteria`, `status_counts`, `queue_format_counts`, completion/failure rates, goal-volume sums, and `latest_sessions`.

Cross-archive autonomous governance maintenance:
- `sce auto governance stats [--days <n>] [--status <csv>] [--json]`: aggregate a unified governance snapshot from session/batch-session/controller-session archives plus recovery memory state.
  - JSON output includes `totals`, `throughput`, `health` (`risk_level`, `concerns`, `recommendations`, `release_gate`, `handoff_quality`), `top_master_specs`, `recovery_memory`, and full per-archive stats under `archives`.
  - `health.release_gate` now carries weekly-ops governance pressure signals from release gate history (`weekly_ops_*`, including block/warning/config-warning totals and authorization/dialogue block-rate maxima) for risk scoring and recommendation routing.
  - When handoff Moqui matrix regressions are positive, `health.recommendations` now include phased anti-429 baseline one-shot remediation commands.
  - `health.handoff_quality` carries Moqui matrix + capability lexicon governance signals:
    - `latest_capability_expected_unknown_count`
    - `latest_capability_provided_unknown_count`
    - `capability_expected_unknown_positive_rate_percent`
    - `capability_provided_unknown_positive_rate_percent`
    - `latest_moqui_matrix_regression_count`
    - `latest_moqui_matrix_regression_gate_max`
    - `avg_moqui_matrix_regression_count`
    - `max_moqui_matrix_regression_count`
    - `moqui_matrix_regression_positive_rate_percent`
- `sce auto governance maintain [--days <n>] [--status <csv>] [--session-keep <n>] [--batch-session-keep <n>] [--controller-session-keep <n>] [--recovery-memory-older-than-days <n>] [--apply] [--dry-run] [--json]`: run governance-maintenance planning and optional execution in one command.
  - Plan-only mode is default; add `--apply` to execute maintenance actions (`session prune`, `batch-session prune`, `controller-session prune`, `recovery-memory prune`).
  - When release gate is blocked, plan output prioritizes release remediation advisories (`release-gate-evidence-review`, `release-gate-scene-batch-remediate`) before routine cleanup actions.
  - JSON output includes `assessment` (pre-maintenance governance snapshot), `plan`, `executed_actions`, `summary`, and `after_assessment` (only when `--apply` without `--dry-run`).
- `sce auto governance close-loop [--days <n>] [--status <csv>] [--session-keep <n>] [--batch-session-keep <n>] [--controller-session-keep <n>] [--recovery-memory-older-than-days <n>] [--max-rounds <n>] [--target-risk <low|medium|high>] [--governance-resume <session|latest|file>] [--governance-resume-allow-drift] [--governance-session-id <id>] [--no-governance-session] [--governance-session-keep <n>] [--governance-session-older-than-days <n>] [--execute-advisory] [--advisory-recover-max-rounds <n>] [--advisory-controller-max-cycles <n>] [--plan-only] [--dry-run] [--json]`: run governance rounds until stop condition (target risk reached, release gate blocked, no actionable maintenance/advisory, non-mutating mode, maintenance/advisory failures, or max rounds).
  - `--plan-only` runs a single non-mutating planning round.
  - Governance close-loop sessions are persisted by default at `.sce/auto/governance-close-loop-sessions/*.json`; use `--governance-resume` to continue interrupted governance loops.
  - On resume, sce reuses persisted policy defaults (`target_risk`, `execute_advisory`, `advisory_policy`) unless explicitly overridden. Explicit policy drift is blocked by default; add `--governance-resume-allow-drift` to force override.
  - `--governance-session-keep` (with optional `--governance-session-older-than-days`) enables post-run governance session retention pruning while protecting the current session snapshot.
  - `--execute-advisory` enables automatic advisory action execution (`recover-latest`, `controller-resume-latest`) when governance assessment detects failed sessions or controller pending goals; sce auto-selects the latest actionable advisory source and reports `skipped` (not `failed`) when no actionable source exists.
  - JSON output includes round-by-round risk/action telemetry (`rounds`, with `risk_before/risk_after` and `release_gate_before/release_gate_after`), advisory telemetry (`execute_advisory`, `advisory_policy`, `advisory_summary`, `rounds[*].advisory_actions`), `stop_detail` + `recommendations` for explicit blocking reasons, plus `initial_assessment`, `final_assessment`, and convergence metadata.
  - When blocked by weekly release pressure, `stop_detail.weekly_ops` provides structured latest/aggregate/pressure fields so downstream agents and UI assistants do not need to parse reason strings.
  - Release-gate block reasons now include handoff matrix regression reasons when present:
    - `handoff-capability-expected-unknown-positive:<n>`
    - `handoff-capability-provided-unknown-positive:<n>`
    - `handoff-capability-expected-unknown-positive-rate:<percent>`
    - `handoff-capability-provided-unknown-positive-rate:<percent>`
    - `handoff-moqui-matrix-regressions-positive:<n>`
    - `handoff-moqui-matrix-regressions-over-gate:<n>/<max>`
  - Release-gate block reasons also include weekly-ops pressure reasons when present (examples):
    - `weekly-ops-latest-blocked`
    - `weekly-ops-blocked-runs-positive:<n>`
    - `weekly-ops-config-warnings-positive:<n>`
    - `weekly-ops-auth-tier-block-rate-high:<percent>`
    - `weekly-ops-dialogue-authorization-block-rate-high:<percent>`
- `sce auto governance session list [--limit <n>] [--status <csv>] [--resume-only] [--json]`: list persisted governance close-loop sessions (`--resume-only` filters to resumed-chain sessions only).
- `sce auto governance session stats [--days <n>] [--status <csv>] [--resume-only] [--json]`: aggregate governance close-loop session telemetry (completion/failure/convergence, rounds, risk/stop composition, resumed-chain ratios/source counts, and aggregated `release_gate` round telemetry trends).
  - `release_gate.weekly_ops_stop` summarizes weekly-ops stop pressure across governance sessions (session counts/rates, high-pressure/config-warning/auth-tier/dialogue pressure rates, and averaged blocked-runs/block-rate/config-warning totals).
- `sce auto governance session prune [--keep <n>] [--older-than-days <n>] [--dry-run] [--json]`: prune governance close-loop session archive by retention policy.

Close-loop recovery memory maintenance:
- `sce auto recovery-memory show [--scope <scope>] [--json]`: inspect persisted recovery signatures/actions and aggregate stats (optionally scoped)
- `sce auto recovery-memory scopes [--json]`: inspect aggregated recovery-memory statistics grouped by scope
- `sce auto recovery-memory prune [--older-than-days <n>] [--scope <scope>] [--dry-run] [--json]`: prune stale recovery memory entries (optionally scoped)
- `sce auto recovery-memory clear [--json]`: clear persisted recovery memory state

Autonomous KPI trend:
- `sce auto kpi trend [--weeks <n>] [--mode <all|batch|program|recover|controller>] [--period <week|day>] [--csv] [--out <path>] [--json]`: aggregate periodic KPI trend from persisted autonomous summary sessions.
  - `--period <week|day>` selects weekly (default) or daily buckets.
  - `--csv` prints CSV rows to stdout and writes CSV when used with `--out` (JSON remains default).
  - JSON output includes `mode_breakdown` (batch/program/recover/controller/other run distribution), `anomaly_detection`, and flattened `anomalies` (latest-period regression checks against historical baseline, including rate-limit pressure via `average_rate_limit_signals` / `average_rate_limit_backoff_ms`).

Unified observability snapshot:
- `sce auto observability snapshot [--days <n>] [--status <csv>] [--weeks <n>] [--trend-mode <mode>] [--trend-period <period>] [--out <path>] [--json]`: generate one unified observability snapshot that combines close-loop session stats, batch stats, controller stats, governance session stats, governance health, and KPI trend.
- JSON output includes top-level `highlights` plus detailed archive/trend payloads under `snapshots`.
  - `highlights` includes governance weekly-ops pressure counters (`governance_weekly_ops_stop_sessions`, high-pressure/config-warning/auth-tier/dialogue pressure counts/rates) plus runtime pressure counters (`governance_weekly_ops_runtime_block_rate_high_sessions`, `governance_weekly_ops_runtime_ui_mode_violation_high_sessions`, `governance_weekly_ops_runtime_ui_mode_violation_total_sum`).
  - `snapshots.governance_weekly_ops_stop` exposes the full weekly-ops stop aggregate object from governance session stats for direct dashboard consumption.

Agent-facing spec interfaces:
- `sce auto spec status <spec-name> [--json]`: structured status for one spec (`docs`, `task_progress`, `collaboration`, `health`).
- `sce auto spec instructions <spec-name> [--json]`: machine-readable execution instructions for one spec (`next_actions`, `priority_open_tasks`, recommended commands, document excerpts).

Autonomous archive schema compatibility:
- `sce auto schema check [--only <scopes>] [--json]`: scan archive schema compatibility (`schema_version`) for `close-loop-session`, `batch-session`, `controller-session`, and `governance-session`.
- `sce auto schema migrate [--only <scopes>] [--target-version <version>] [--apply] [--json]`: migrate/backfill `schema_version` across autonomous archives.
  - Default mode is dry-run; use `--apply` to persist changes.

Dual-track handoff integration:
- `sce auto handoff plan --manifest <path> [--out <path>] [--strict] [--strict-warnings] [--json]`: parse handoff manifest (source project, specs, templates, known gaps) and generate an executable sce integration phase plan.
- `sce auto handoff queue --manifest <path> [--out <path>] [--append] [--no-include-known-gaps] [--dry-run] [--json]`: generate close-loop batch goal queue from handoff manifest and optionally persist line-based queue file (default `.sce/auto/handoff-goals.lines`).
- `sce auto handoff template-diff --manifest <path> [--json]`: compare manifest templates against local template exports/registry and report `missing_in_local` and `extra_in_local`.
- `sce auto handoff capability-matrix --manifest <path> [--profile <default|moqui|enterprise>] [--strict] [--strict-warnings] [--min-capability-coverage <n>] [--min-capability-semantic <n>] [--no-require-capability-semantic] [--format <json|markdown>] [--out <path>] [--remediation-queue-out <path>] [--fail-on-gap] [--json]`: generate a fast Moqui capability matrix (`template-diff + baseline + capability coverage + semantic completeness`) and optionally fail fast on gaps.
- When matrix regressions are detected in baseline compare, recommendations prioritize capability-cluster phased execution first (`npm run run:matrix-remediation-clusters-phased -- --json`), then baseline phased one-shot (`node scripts/moqui-matrix-remediation-phased-runner.js --baseline ... --json`).
- When `manifest.capabilities` is empty, sce auto-infers canonical expected capabilities from `manifest.templates` using the Moqui lexicon before deciding whether capability coverage should be skipped.
- `sce auto handoff preflight-check [--profile <default|moqui|enterprise>] [--history-file <path>] [--require-release-gate-preflight|--no-require-release-gate-preflight] [--release-evidence-window <n>] [--require-pass] [--json]`: inspect release-gate history preflight readiness and return machine-readable `pass|warning|blocked` status with reasons, runtime weekly-ops pressure signals, and executable remediation commands.
  - `--require-pass` exits non-zero when status is not `pass` (recommended for CI/release hard gates).
  - Default policy follows profile defaults and enforces release-gate preflight hard requirement (`default`/`moqui`/`enterprise` all require preflight by default).
- `sce auto handoff run --manifest <path> [--profile <default|moqui|enterprise>] [--out <path>] [--queue-out <path>] [--append] [--no-include-known-gaps] [--continue-from <session|latest|file>] [--continue-strategy <auto|pending|failed-only>] [--dry-run] [--strict] [--strict-warnings] [--no-dependency-batching] [--min-spec-success-rate <n>] [--max-risk-level <level>] [--max-moqui-matrix-regressions <n>] [--no-require-ontology-validation] [--no-require-moqui-baseline] [--min-capability-coverage <n>] [--no-require-capability-coverage] [--require-release-gate-preflight] [--release-evidence-window <n>] [--json]`: execute handoff end-to-end (`plan -> queue -> close-loop-batch -> observability`) with automatic report archive to `.sce/reports/handoff-runs/<session>.json`.
  - Default mode is dependency-aware: spec integration goals are grouped into dependency batches and executed in topological order.
  - `--continue-from` resumes pending goals from an existing handoff run report (`latest`, session id, or JSON file path). For safety, sce enforces manifest-path consistency between the previous report and current run.
  - `--continue-strategy auto|pending|failed-only` controls resumed scope. `auto` (default) derives the best strategy from prior run state (`pending` when unprocessed/planned goals exist, otherwise `failed-only` for pure failure replay).
  - Non-dry runs auto-merge release evidence into `.sce/reports/release-evidence/handoff-runs.json` with session-level gate/ontology/regression/moqui-baseline/capability-coverage snapshots. Merge failures are recorded as warnings without aborting the run.
  - `--release-evidence-window` controls trend snapshot window size (2-50, default `5`) used in merged release evidence (`latest_trend_window` and per-session `trend_window`).
  - Run output includes `moqui_baseline` snapshot by default, with artifacts at `.sce/reports/release-evidence/moqui-template-baseline.json` and `.sce/reports/release-evidence/moqui-template-baseline.md`.
  - `moqui_baseline.summary` now includes `scope_breakdown`, `coverage_matrix`, and `gap_frequency` for ER/BR/decision closure tracking.
  - `moqui_baseline.compare` now includes `coverage_matrix_deltas` and `coverage_matrix_regressions` for trend-level entity/relation/rule/decision closure movement and negative-delta alerts (used by matrix-regression hard gate).
  - Run output includes `moqui_capability_coverage` snapshot by default (when manifest `capabilities` is declared), with artifacts at `.sce/reports/release-evidence/moqui-capability-coverage.json` and `.sce/reports/release-evidence/moqui-capability-coverage.md`.
  - When `manifest.capabilities` is not declared, sce attempts lexicon-based capability inference from `manifest.templates` first; only fully non-mappable manifests keep capability coverage in skipped mode.
  - Run output includes `release_gate_preflight` (latest release gate history signal snapshot + blocked reasons) and carries this context into `warnings`.
  - `release_gate_preflight` now also carries runtime weekly-ops pressure metrics (`latest_weekly_ops_runtime_block_rate_percent`, `latest_weekly_ops_runtime_ui_mode_violation_total`, `latest_weekly_ops_runtime_ui_mode_violation_rate_percent`) for UI-mode policy diagnostics.
  - `release_gate_preflight` is hard-gated by default; use `--no-require-release-gate-preflight` only for emergency bypass or isolated diagnostics.
  - `phases[*].details` for `observability` now includes weekly-ops stop pressure counters (`weekly_ops_stop_sessions`, `weekly_ops_high_pressure_sessions`, config-warning/auth-tier/dialogue pressure session counts) and runtime pressure counters (`weekly_ops_runtime_block_rate_high_sessions`, `weekly_ops_runtime_ui_mode_violation_high_sessions`, `weekly_ops_runtime_ui_mode_violation_total_sum`) sourced from the unified observability snapshot.
  - `--profile` applies preset gate policy defaults before explicit option overrides:
    - `default`: default takeover policy (release-gate preflight hard requirement enabled).
    - `moqui`: explicit Moqui-intake baseline (same hard-gate defaults as `default`).
    - `enterprise`: stricter release control baseline (`max-risk-level=medium`, `release-evidence-window=10`, preflight hard requirement enabled).
  - When Moqui baseline/capability gates fail, sce auto-generates remediation queue lines at `.sce/auto/moqui-remediation.lines`.
  - Run result includes `failure_summary` (failed phase/gate/release-gate preflight highlights) and `recommendations` with executable follow-up commands (for example, auto-generated `--continue-from <session>` on failed/incomplete batches).
  - When matrix regressions are detected, recommendations now prioritize capability-cluster phased execution (`npm run run:matrix-remediation-clusters-phased -- --json`) and include capability-cluster batch fallback plus baseline phased one-shot remediation (`node scripts/moqui-matrix-remediation-phased-runner.js --baseline ... --json`).
  - Moqui regression recovery recommendations now include an explicit labeled sequence block: `Step 1 (Cluster phased)` then `Step 2 (Baseline phased)`.
  - Gate defaults: `--min-spec-success-rate` defaults to `100`, `--max-risk-level` defaults to `high`, `--max-moqui-matrix-regressions` defaults to `0`, ontology validation requirement is enabled by default, Moqui baseline requirement is enabled by default, and capability coverage minimum defaults to `100` when manifest `capabilities` is declared.
  - Use `--no-require-ontology-validation`, `--no-require-moqui-baseline`, or `--no-require-capability-coverage` only for emergency bypass.
- `sce auto handoff regression [--session-id <id|latest>] [--window <n>] [--format <json|markdown>] [--out <path>] [--json]`: compare one handoff run report with its previous run and output trend deltas (success-rate/risk/failed-goals/elapsed time).
  - `--window` (2-50, default `2`) returns multi-run `series`, `window_trend`, and `aggregates` for broader regression visibility.
  - Regression JSON now includes `risk_layers` (low/medium/high/unknown buckets with per-layer session list and quality aggregates).
  - `--format` supports `json` (default) and `markdown` for human-readable report rendering.
  - Markdown report includes `Trend Series` (ASCII success/ontology bars per session) and `Risk Layer View`.
  - `--out` writes the generated regression report using the selected format.
  - Output includes `recommendations` to guide next action when trend degrades or risk escalates, including phased anti-429 baseline one-shot remediation when Moqui matrix regressions are detected.
- `sce auto handoff evidence [--file <path>] [--session-id <id|latest>] [--window <n>] [--format <json|markdown>] [--out <path>] [--json]`: quick-review merged release evidence and render current-batch gate/ontology/regression/moqui-baseline/capability-coverage/risk-layer overview.
  - Default evidence file is `.sce/reports/release-evidence/handoff-runs.json`.
  - `--window` (1-50, default `5`) controls how many recent sessions are aggregated in review.
  - JSON output includes `current_overview` (with `release_gate_preflight`, `failure_summary`, and preflight policy flags), `aggregates.status_counts`, `aggregates.gate_pass_rate_percent`, and `risk_layers`.
  - Markdown output includes `Current Gate`, `Current Release Gate Preflight`, `Current Failure Summary`, `Current Ontology`, `Current Regression`, `Current Moqui Baseline`, `Current Capability Coverage`, `Trend Series`, and `Risk Layer View`.
  - `Current Release Gate Preflight` includes runtime pressure lines (runtime block-rate and ui-mode violation totals/rates) when signals exist in release-gate history.
  - Add `--release-draft <path>` to auto-generate a release notes draft and evidence review markdown in one run.
  - `--release-version` sets draft version tag (defaults to `v<package.json version>`), and `--release-date` accepts `YYYY-MM-DD` (default: current UTC date).
  - Use `--review-out <path>` to override the generated evidence review markdown path (default `.sce/reports/release-evidence/handoff-evidence-review.md`).
- `sce auto handoff gate-index [--dir <path>] [--history-file <path>] [--keep <n>] [--out <path>] [--json]`: aggregate `release-gate-*.json` audits into a cross-version history index.
  - Default scan dir is `.sce/reports/release-evidence`, default output file is `.sce/reports/release-evidence/release-gate-history.json`.
  - `--history-file` merges an existing index (for example, previous release asset) before dedup/refresh.
  - `--keep` retains latest N entries (`1-5000`, default `200`).
  - Aggregates include scene package batch, capability unknown trend, drift, weekly ops pressure (including runtime ui-mode/runtime block-rate telemetry), config warning pressure, and release-preflight/hard-gate signals (`scene_package_batch_*`, `capability_expected_unknown_*`, `capability_provided_unknown_*`, `drift_alert_*`, `drift_block_*`, `weekly_ops_*`, `config_warnings_total`, `release_gate_preflight_*`) when present in gate reports.
  - `--markdown-out <path>` writes a human-readable trend card markdown for PR/Issue handoff.

Moqui template library lexicon audit (script-level governance helper):
- `node scripts/moqui-lexicon-audit.js [--manifest <path>] [--template-dir <path>] [--lexicon <path>] [--out <path>] [--markdown-out <path>] [--fail-on-gap] [--json]`: audit manifest/template capability names against canonical Moqui lexicon; reports unknown aliases and uncovered expected capabilities.
  - Expected capability scope uses `manifest.capabilities` first; when empty, it infers canonical expected capabilities from `manifest.templates` and emits `expected_scope` metadata (`source`, `inferred_*`, `unresolved_templates`).
  - By default, template capability auditing is scoped to `manifest.templates` (when matched), reducing noise from unrelated templates.
  - Template scope matching normalizes `sce.scene--*` / `kse.scene--*` prefixes, so renamed template namespaces still map correctly.

Moqui release summary helper (script-level consolidated gate view):
- `node scripts/moqui-release-summary.js [--evidence <path>] [--baseline <path>] [--lexicon <path>] [--capability-matrix <path>] [--interactive-governance <path>] [--matrix-remediation-plan <path>] [--out <path>] [--markdown-out <path>] [--fail-on-gate-fail] [--json]`: merge handoff release-evidence + baseline + lexicon + capability-matrix + interactive-governance into one Moqui release gate summary (`passed | failed | incomplete`) with executable remediation recommendations.
  - When matrix regressions exist and remediation plan is available, recommendations include concrete template/capability priority order from `template_priority_matrix` and `capability_clusters`.
  - Matrix-regression recovery recommendations now use explicit labeled sequence steps: `Step 1 (Cluster phased)` then `Step 2 (Baseline phased)`.
  - Default inputs:
    - `.sce/reports/release-evidence/handoff-runs.json`
    - `.sce/reports/release-evidence/moqui-template-baseline.json`
    - `.sce/reports/release-evidence/moqui-lexicon-audit.json`
    - `.sce/reports/handoff-capability-matrix.json`
  - Default outputs:
    - `.sce/reports/release-evidence/moqui-release-summary.json`
    - `.sce/reports/release-evidence/moqui-release-summary.md`
  - `--fail-on-gate-fail` exits with code `2` when summary gate is `failed`.

Release governance snapshot export helper (release-asset extraction):
- `node scripts/release-governance-snapshot-export.js`:
  - reads release evidence summary from `RELEASE_EVIDENCE_SUMMARY_FILE`
  - extracts `governance_snapshot` into independent audit assets
  - writes:
    - `RELEASE_GOVERNANCE_SNAPSHOT_JSON` (default `.sce/reports/release-evidence/governance-snapshot.json`)
    - `RELEASE_GOVERNANCE_SNAPSHOT_MD` (default `.sce/reports/release-evidence/governance-snapshot.md`)
  - never hard-fails release flow when summary is missing; writes unavailable placeholder with warning instead.

Release weekly ops summary helper (ops closed-loop evidence):
- `node scripts/release-ops-weekly-summary.js [--evidence <path>] [--gate-history <path>] [--interactive-governance <path>] [--matrix-signals <path>] [--from <iso>] [--to <iso>] [--window-days <n>] [--out <path>] [--markdown-out <path>] [--json]`: aggregate weekly handoff/gate/governance/matrix telemetry into one operational risk card.
  - Default inputs:
    - `.sce/reports/release-evidence/handoff-runs.json`
    - `.sce/reports/release-evidence/release-gate-history.json`
    - `.sce/reports/interactive-governance-report.json`
    - `.sce/reports/interactive-matrix-signals.jsonl`
  - Default outputs:
    - `.sce/reports/release-evidence/weekly-ops-summary.json`
    - `.sce/reports/release-evidence/weekly-ops-summary.md`
  - Missing inputs are reported as warnings and reflected in `health.risk`/recommendations.
- npm alias: `npm run report:release-ops-weekly`

Release weekly ops gate helper (release hard-gate):
- `node scripts/release-weekly-ops-gate.js`:
  - reads weekly summary from `RELEASE_WEEKLY_OPS_SUMMARY_FILE`
  - default policy:
    - `RELEASE_WEEKLY_OPS_ENFORCE=true`
    - `RELEASE_WEEKLY_OPS_REQUIRE_SUMMARY=true`
    - `RELEASE_WEEKLY_OPS_MAX_RISK_LEVEL=medium`
  - optional thresholds:
    - `RELEASE_WEEKLY_OPS_MAX_GOVERNANCE_BREACHES=<n>`
    - `RELEASE_WEEKLY_OPS_MAX_AUTHORIZATION_TIER_BLOCK_RATE_PERCENT=<n>` (default `40`)
    - `RELEASE_WEEKLY_OPS_MAX_DIALOGUE_AUTHORIZATION_BLOCK_RATE_PERCENT=<n>` (default `40`)
    - `RELEASE_WEEKLY_OPS_MAX_RUNTIME_UI_MODE_VIOLATION_TOTAL=<n>` (default `0`)
    - `RELEASE_WEEKLY_OPS_MAX_RUNTIME_UI_MODE_VIOLATION_RATE_PERCENT=<n>`
    - `RELEASE_WEEKLY_OPS_MAX_MATRIX_REGRESSION_RATE_PERCENT=<n>`
  - invalid numeric threshold values emit `config_warnings` and fall back to defaults.
  - merges result into `RELEASE_GATE_REPORT_FILE` when provided.
- npm alias: `npm run gate:release-ops-weekly`

Release risk remediation bundle helper (weekly + drift unified command pack):
- `node scripts/release-risk-remediation-bundle.js [--gate-report <path>] [--out <path>] [--markdown-out <path>] [--lines-out <path>] [--json]`: derive deduplicated remediation commands from `release-gate` report signals (`weekly_ops`, `drift`) and export JSON/Markdown/lines artifacts.
  - when weekly gate includes `dialogue-authorization`/`authorization-tier` block-rate pressure, plan includes policy-specific diagnostics (`interactive-dialogue-governance`, `interactive-authorization-tier-evaluate`).
  - Default input: `.sce/reports/release-evidence/release-gate.json`
  - Default outputs:
    - `.sce/reports/release-evidence/release-risk-remediation-bundle.json`
    - `.sce/reports/release-evidence/release-risk-remediation-bundle.md`
    - `.sce/reports/release-evidence/release-risk-remediation.commands.lines`
- npm alias: `npm run report:release-risk-remediation`

Release asset integrity check helper (release artifact completeness gate):
- `node scripts/release-asset-integrity-check.js`:
  - validates required release evidence assets in `RELEASE_ASSET_INTEGRITY_DIR` (default `.sce/reports/release-evidence`).
  - default required files:
    - `release-gate-{tag}.json`
    - `release-gate-history-{tag}.json|.md`
    - `governance-snapshot-{tag}.json|.md`
    - `weekly-ops-summary-{tag}.json|.md`
    - `release-risk-remediation-{tag}.json|.md|.lines`
  - default behavior: enforce blocking when any required asset is missing (`RELEASE_ASSET_INTEGRITY_ENFORCE=true`).
  - supports override via `RELEASE_ASSET_INTEGRITY_REQUIRED_FILES` (comma-separated, `{tag}` placeholder supported).
  - writes optional reports:
    - `RELEASE_ASSET_INTEGRITY_REPORT_JSON`
    - `RELEASE_ASSET_INTEGRITY_REPORT_MD`
  - merges result into `RELEASE_GATE_REPORT_FILE` when provided.
- npm alias: `npm run gate:release-asset-integrity`

Release optional-asset nonempty normalize helper (pre-upload 0-byte guard):
- `node scripts/release-asset-nonempty-normalize.js --file <path> [--file <path> ...] [--kind auto|json|jsonl|lines|text] [--note <text>] [--event <event>] [--dry-run] [--json]`:
  - creates placeholder content when file is missing.
  - fills placeholder content when file exists but is empty.
  - keeps file untouched when it already has content.
  - intended for optional release assets (`.jsonl`, `.lines`) before GitHub Release upload.

Autonomous strategy router helper (answer/code/fix/rollback policy):
- `node scripts/auto-strategy-router.js --input-file <path> [--policy-file <path>] --json`
- `node scripts/auto-strategy-router.js --input '{"goal_type":"bugfix","requires_write":true}' --json`
  - returns decision: `answer_only|code_change|code_fix|rollback`.
  - returns `reasons[]` and `next_actions[]` for auditable routing.
  - default policy baseline: `docs/agent-runtime/strategy-routing-policy-baseline.json`.

Matrix regression gate helper (script-level configurable hard gate):
- `node scripts/matrix-regression-gate.js [--baseline <path>] [--max-regressions <n>] [--enforce] [--out <path>] [--json]`: evaluate matrix regression count from baseline compare payload (`coverage_matrix_regressions` preferred, fallback `regressions`) and enforce hard gate when enabled.
  - Default baseline input: `.sce/reports/release-evidence/moqui-template-baseline.json`
  - Default output: `.sce/reports/release-evidence/matrix-regression-gate.json`
  - `--enforce` exits with code `2` when regressions exceed `--max-regressions`.
- npm alias: `npm run gate:matrix-regression`

Moqui matrix remediation queue helper (script-level automatic queue export):
- `node scripts/moqui-matrix-remediation-queue.js [--baseline <path>] [--out <path>] [--lines-out <path>] [--markdown-out <path>] [--batch-json-out <path>] [--capability-cluster-goals-out <path>] [--commands-out <path>] [--phase-high-lines-out <path>] [--phase-medium-lines-out <path>] [--phase-high-goals-out <path>] [--phase-medium-goals-out <path>] [--phase-high-parallel <n>] [--phase-high-agent-budget <n>] [--phase-medium-parallel <n>] [--phase-medium-agent-budget <n>] [--phase-cooldown-seconds <n>] [--no-phase-split] [--min-delta-abs <n>] [--top-templates <n>] [--json]`: convert matrix regressions into remediation goals consumable by `sce auto close-loop-batch`, with per-metric template candidates/capability focus, phase-split anti-429 outputs (`high` then `medium`), capability-cluster executable goals, and direct command templates.
  - JSON output includes `template_priority_matrix` (cross-regression template priority ranking) and `capability_clusters` (capability-level remediation clusters with suggested templates).
  - JSON output includes `capability_cluster_goal_count` and writes `mode=moqui-matrix-capability-cluster-goals` payload with cluster-level `goals` for direct batch execution.
  - Default inputs/outputs:
    - Baseline: `.sce/reports/release-evidence/moqui-template-baseline.json`
    - Plan JSON: `.sce/reports/release-evidence/matrix-remediation-plan.json`
    - Queue lines: `.sce/auto/matrix-remediation.lines`
    - Plan Markdown: `.sce/reports/release-evidence/matrix-remediation-plan.md`
    - Batch goals JSON: `.sce/auto/matrix-remediation.goals.json`
    - Capability-cluster goals JSON: `.sce/auto/matrix-remediation.capability-clusters.json`
    - Commands Markdown: `.sce/reports/release-evidence/matrix-remediation-commands.md`
    - High queue lines: `.sce/auto/matrix-remediation.high.lines`
    - Medium queue lines: `.sce/auto/matrix-remediation.medium.lines`
    - High goals JSON: `.sce/auto/matrix-remediation.goals.high.json`
    - Medium goals JSON: `.sce/auto/matrix-remediation.goals.medium.json`
  - Default phased execution policy:
    - High phase: `--batch-parallel 1 --batch-agent-budget 2`
    - Medium phase: `--batch-parallel 1 --batch-agent-budget 2`
    - Cooldown: `sleep 30` seconds between phases
- npm alias: `npm run report:matrix-remediation-queue`

Moqui matrix remediation phased runner helper (script-level one-shot execution):
- `node scripts/moqui-matrix-remediation-phased-runner.js [--baseline <path>] [--queue-out <path>] [--queue-lines-out <path>] [--queue-markdown-out <path>] [--queue-batch-json-out <path>] [--queue-commands-out <path>] [--cluster-goals <path>] [--cluster-high-goals-out <path>] [--cluster-medium-goals-out <path>] [--min-delta-abs <n>] [--top-templates <n>] [--high-goals <path>] [--medium-goals <path>] [--high-lines <path>] [--medium-lines <path>] [--phase-high-parallel <n>] [--phase-high-agent-budget <n>] [--phase-medium-parallel <n>] [--phase-medium-agent-budget <n>] [--phase-cooldown-seconds <n>] [--high-retry-max-rounds <n>] [--medium-retry-max-rounds <n>] [--phase-recovery-attempts <n>] [--phase-recovery-cooldown-seconds <n>] [--no-fallback-lines] [--continue-on-error] [--dry-run] [--json]`: execute matrix remediation in anti-429 phased order (`high -> cooldown -> medium`) using `sce auto close-loop-batch`; when `--baseline` is provided, it auto-generates the queue package first (`prepare + run` in one command), and when `--cluster-goals` is provided it derives phase goals from capability clusters before execution.
  - Default inputs:
    - High goals JSON: `.sce/auto/matrix-remediation.goals.high.json`
    - Medium goals JSON: `.sce/auto/matrix-remediation.goals.medium.json`
    - High lines fallback: `.sce/auto/matrix-remediation.high.lines`
    - Medium lines fallback: `.sce/auto/matrix-remediation.medium.lines`
  - Default execution policy:
    - High: `--batch-parallel 1 --batch-agent-budget 2 --batch-retry-max-rounds 3`
    - Medium: `--batch-parallel 1 --batch-agent-budget 2 --batch-retry-max-rounds 2`
    - Cooldown: `30` seconds
    - Phase process recovery: `--phase-recovery-attempts 2` with `--phase-recovery-cooldown-seconds 30`; on retry, phase parallel/agent-budget are halved (floor, min=1)
  - Zero-prep mode:
    - `node scripts/moqui-matrix-remediation-phased-runner.js --baseline .sce/reports/release-evidence/moqui-template-baseline.json --json`
- npm alias: `npm run run:matrix-remediation-phased`
- npm alias (baseline zero-prep): `npm run run:matrix-remediation-from-baseline -- --json`
- npm alias (capability clusters): `npm run run:matrix-remediation-clusters`
- npm alias (capability clusters phased): `npm run run:matrix-remediation-clusters-phased -- --json`

Interactive customization plan gate helper (script-level secure-by-default check):
- `node scripts/interactive-change-plan-gate.js --plan <path> [--policy <path>] [--catalog <path>] [--out <path>] [--markdown-out <path>] [--fail-on-block] [--fail-on-non-allow] [--json]`: evaluate interactive change plans against default guardrails (approval, sensitive-data masking, secrets, irreversible backup, high-risk action catalog) and output `allow | review-required | deny`.
  - Default policy: `docs/interactive-customization/guardrail-policy-baseline.json`
  - Default catalog: `docs/interactive-customization/high-risk-action-catalog.json` (or `policy.catalog_policy.catalog_file`)
  - Default outputs:
    - `.sce/reports/interactive-change-plan-gate.json`
    - `.sce/reports/interactive-change-plan-gate.md`
  - `--fail-on-block` exits with code `2` on `deny`
  - `--fail-on-non-allow` exits with code `2` on `deny` or `review-required`

Interactive context bridge helper (script-level provider normalization):
- `node scripts/interactive-context-bridge.js --input <path> [--provider <moqui|generic>] [--out-context <path>] [--out-report <path>] [--context-contract <path>] [--no-strict-contract] [--json]`: normalize raw UI/provider payload into standard interactive `page-context` and validate against context contract before intent generation.
  - Default input sample: `docs/interactive-customization/moqui-context-provider.sample.json`
  - Default outputs:
    - `.sce/reports/interactive-page-context.normalized.json`
    - `.sce/reports/interactive-context-bridge.json`
  - Strict contract validation is enabled by default; `--no-strict-contract` keeps report generation for diagnostics.
  - CLI equivalent: `sce scene context-bridge --input <path> --json`
  - npm alias: `npm run report:interactive-context-bridge`

Interactive full flow helper (script-level one-command entry):
- `node scripts/interactive-flow.js --input <path> (--goal <text> | --goal-file <path>) [--provider <moqui|generic>] [--execution-mode <suggestion|apply>] [--business-mode <user-mode|ops-mode|dev-mode>] [--business-mode-policy <path>] [--allow-mode-override] [--runtime-mode <user-assist|ops-fix|feature-dev>] [--runtime-environment <dev|staging|prod>] [--runtime-policy <path>] [--authorization-tier-policy <path>] [--authorization-tier-out <path>] [--policy <path>] [--catalog <path>] [--dialogue-policy <path>] [--dialogue-profile <business-user|system-maintainer>] [--ui-mode <user-app|ops-console>] [--context-contract <path>] [--approval-role-policy <path>] [--approval-actor-role <name>] [--approver-actor-role <name>] [--auto-execute-low-risk] [--auth-password-hash <sha256>] [--auth-password <text>] [--feedback-score <0..5>] [--work-order-out <path>] [--work-order-markdown-out <path>] [--fail-on-runtime-non-allow] [--no-matrix] [--matrix-min-score <0..100>] [--matrix-min-valid-rate <0..100>] [--matrix-compare-with <path>] [--matrix-signals <path>] [--matrix-fail-on-portfolio-fail] [--matrix-fail-on-regression] [--json]`: run `context-bridge -> interactive-loop -> matrix-baseline-snapshot` in one command for Moqui workbench integration.
  - Default flow artifact root: `.sce/reports/interactive-flow/<session-id>/`
  - Default flow summary output: `.sce/reports/interactive-flow/<session-id>/interactive-flow.summary.json`
  - Default dialogue report output: `.sce/reports/interactive-flow/<session-id>/interactive-dialogue-governance.json`
  - Default dialogue-authorization signal stream:
    - `.sce/reports/interactive-flow/<session-id>/interactive-dialogue-authorization-signals.jsonl` (session)
    - `.sce/reports/interactive-dialogue-authorization-signals.jsonl` (global append-only stream)
  - Default runtime report output: `.sce/reports/interactive-flow/<session-id>/interactive-runtime-policy.json`
  - Default authorization tier report output: `.sce/reports/interactive-flow/<session-id>/interactive-authorization-tier.json`
  - Default work-order outputs:
    - `.sce/reports/interactive-flow/<session-id>/interactive-work-order.json`
    - `.sce/reports/interactive-flow/<session-id>/interactive-work-order.md`
  - Default matrix outputs:
    - `.sce/reports/interactive-flow/<session-id>/moqui-template-baseline.json`
    - `.sce/reports/interactive-flow/<session-id>/moqui-template-baseline.md`
    - `.sce/reports/interactive-matrix-signals.jsonl` (append-only signal stream)
  - Matrix stage is enabled by default; use `--no-matrix` only for diagnostics.
  - CLI equivalent: `sce scene interactive-flow --input <path> --goal "<goal>" --json`
  - npm alias: `npm run run:interactive-flow -- --input docs/interactive-customization/moqui-context-provider.sample.json --goal "Adjust order screen field layout for clearer input flow" --json`

Interactive read-only intent helper (script-level stage-A copilot bridge):
- `node scripts/interactive-intent-build.js --context <path> (--goal <text> | --goal-file <path>) [--user-id <id>] [--session-id <id>] [--out-intent <path>] [--out-explain <path>] [--audit-file <path>] [--context-contract <path>] [--no-strict-contract] [--mask-keys <csv>] [--json]`: build a read-only `Change_Intent` from page context + business goal, emit masked context preview, append audit event JSONL, and generate explain markdown.
  - Default outputs:
    - `.sce/reports/interactive-change-intent.json`
    - `.sce/reports/interactive-page-explain.md`
    - `.sce/reports/interactive-copilot-audit.jsonl`
  - Default context contract: `docs/interactive-customization/moqui-copilot-context-contract.json` (fallback built-in baseline when file is absent)
  - Contract validation is strict by default (required fields, payload size, forbidden keys).
  - This helper never executes write actions; it only produces suggestion-stage artifacts.

Interactive dialogue governance helper (script-level communication-rule gate):
- `node scripts/interactive-dialogue-governance.js (--goal <text> | --goal-file <path>) [--context <path>] [--policy <path>] [--profile <business-user|system-maintainer>] [--ui-mode <user-app|ops-console>] [--execution-mode <suggestion|apply>] [--runtime-environment <dev|staging|prod>] [--authorization-dialogue-policy <path>] [--out <path>] [--fail-on-deny] [--json]`: evaluate user request text against embedded-assistant communication policy, output `allow|clarify|deny`, and produce machine-readable authorization dialogue requirements (`authorization_dialogue`) for non-technical users.
  - Embedded assistant authorization dialogue baseline: `docs/interactive-customization/embedded-assistant-authorization-dialogue-rules.md`
  - Dual-surface integration guide: `docs/interactive-customization/dual-ui-mode-integration-guide.md`
  - Default output: `.sce/reports/interactive-dialogue-governance.json`
  - Default policy: `docs/interactive-customization/dialogue-governance-policy-baseline.json` (fallback builtin policy when missing)
  - Default authorization dialogue policy: `docs/interactive-customization/authorization-dialogue-policy-baseline.json`
  - Default profile: `business-user` (use `system-maintainer` for maintenance/operator conversations)
  - `--fail-on-deny` exits with code `2` to block unsafe requests in CI/automation.

Interactive change-plan generator helper (script-level stage-B planning bridge):
- `node scripts/interactive-plan-build.js --intent <path> [--context <path>] [--execution-mode <suggestion|apply>] [--out-plan <path>] [--out-markdown <path>] [--json]`: generate structured `Change_Plan` from `Change_Intent`, including action candidates, risk level, verification checks, rollback plan, approval status, and gate hint command.
  - Default outputs:
    - `.sce/reports/interactive-change-plan.generated.json`
    - `.sce/reports/interactive-change-plan.generated.md`
  - Generated plans can be evaluated directly by `interactive-change-plan-gate`.

Interactive one-click loop helper (script-level orchestration entry):
- `node scripts/interactive-customization-loop.js --context <path> (--goal <text> | --goal-file <path>) [--execution-mode <suggestion|apply>] [--business-mode <user-mode|ops-mode|dev-mode>] [--business-mode-policy <path>] [--allow-mode-override] [--runtime-mode <user-assist|ops-fix|feature-dev>] [--runtime-environment <dev|staging|prod>] [--runtime-policy <path>] [--authorization-tier-policy <path>] [--authorization-tier-out <path>] [--policy <path>] [--catalog <path>] [--dialogue-policy <path>] [--dialogue-profile <business-user|system-maintainer>] [--ui-mode <user-app|ops-console>] [--context-contract <path>] [--approval-role-policy <path>] [--approval-actor-role <name>] [--approver-actor-role <name>] [--no-strict-contract] [--auto-approve-low-risk] [--auto-execute-low-risk] [--auth-password-hash <sha256>] [--auth-password <text>] [--feedback-score <0..5>] [--feedback-comment <text>] [--feedback-tags <csv>] [--allow-suggestion-apply] [--work-order-out <path>] [--work-order-markdown-out <path>] [--fail-on-dialogue-deny] [--fail-on-gate-non-allow] [--fail-on-runtime-non-allow] [--json]`: run dialogue->intent->plan->gate->runtime->authorization-tier->approval pipeline in one command and optionally trigger low-risk one-click apply via Moqui adapter.
  - CLI equivalent: `sce scene interactive-loop --context <path> --goal "<goal>" --context-contract docs/interactive-customization/moqui-copilot-context-contract.json --execution-mode apply --auto-execute-low-risk --auth-password "<password>" --feedback-score 5 --json`
  - Default loop artifact root: `.sce/reports/interactive-loop/<session-id>/`
  - Default summary output: `.sce/reports/interactive-loop/<session-id>/interactive-customization-loop.summary.json`
- `--auto-execute-low-risk` executes `interactive-moqui-adapter --action low-risk-apply` only when `risk_level=low`, dialogue decision != `deny`, and gate decision=`allow`.
- `--runtime-mode` and `--runtime-environment` default to `ops-fix@staging`; runtime decision must be `allow` before low-risk auto execute.
- `--business-mode` preset map: `user-mode -> suggestion + business-user + user-app + user-assist`, `ops-mode -> apply + system-maintainer + ops-console + ops-fix`, `dev-mode -> apply + system-maintainer + ops-console + feature-dev`.
- Authorization tier defaults:
  - `business-user` profile is suggestion-only (`apply` denied by default)
  - `system-maintainer` profile can apply, but environment step-up requirements still apply (password/role separation/manual review)
- Default runtime report: `.sce/reports/interactive-loop/<session-id>/interactive-runtime-policy.json`
- Default authorization tier report: `.sce/reports/interactive-loop/<session-id>/interactive-authorization-tier.json`
- Default authorization tier signal stream:
  - Session: `.sce/reports/interactive-loop/<session-id>/interactive-authorization-tier-signals.jsonl`
  - Global: `.sce/reports/interactive-authorization-tier-signals.jsonl`
- Default dialogue-authorization signal stream:
  - Session: `.sce/reports/interactive-loop/<session-id>/interactive-dialogue-authorization-signals.jsonl`
  - Global: `.sce/reports/interactive-dialogue-authorization-signals.jsonl`
- Default work-order outputs:
  - `.sce/reports/interactive-loop/<session-id>/interactive-work-order.json`
  - `.sce/reports/interactive-loop/<session-id>/interactive-work-order.md`
- Apply-mode mutating plans require password authorization by default (`plan.authorization.password_required=true`).
- `--feedback-score` logs feedback to both session artifact and global governance file (`.sce/reports/interactive-user-feedback.jsonl`).
- npm alias: `npm run run:interactive-loop -- --context docs/interactive-customization/page-context.sample.json --goal "Improve order entry clarity" --json`

Interactive runtime policy helper (script-level mode/environment gate):
- `node scripts/interactive-runtime-policy-evaluate.js --plan <path> [--ui-mode <user-app|ops-console>] [--runtime-mode <user-assist|ops-fix|feature-dev>] [--runtime-environment <dev|staging|prod>] [--policy <path>] [--fail-on-non-allow] [--json]`: evaluate plan execution safety by runtime role, UI surface, and environment constraints.
  - Default policy: `docs/interactive-customization/runtime-mode-policy-baseline.json`
  - `policy.ui_modes` (when configured) enforces UI-surface contract, such as `user-app` suggestion-only and apply routed to `ops-console`.
  - Default output: `.sce/reports/interactive-runtime-policy.json`
  - `--fail-on-non-allow` exits with code `2` on `deny` or `review-required`.

Interactive authorization-tier helper (script-level profile/environment step-up gate):
- `node scripts/interactive-authorization-tier-evaluate.js [--execution-mode <suggestion|apply>] [--dialogue-profile <business-user|system-maintainer>] [--runtime-mode <name>] [--runtime-environment <dev|staging|prod>] [--auto-execute-low-risk] [--live-apply] [--policy <path>] [--out <path>] [--fail-on-non-allow] [--json]`: evaluate whether execution intent is permitted under dialogue profile and runtime environment authorization tier.
  - Default policy: `docs/interactive-customization/authorization-tier-policy-baseline.json`
  - Default output: `.sce/reports/interactive-authorization-tier.json`
  - `--fail-on-non-allow` exits with code `2` on `deny` or `review-required`.

Interactive work-order helper (script-level usage/maintenance/dev closure):
- `node scripts/interactive-work-order-build.js --plan <path> [--dialogue <path>] [--intent <path>] [--gate <path>] [--runtime <path>] [--authorization-tier <path>] [--approval-state <path>] [--execution-attempted] [--execution-result <value>] [--execution-id <id>] [--out <path>] [--markdown-out <path>] [--json]`: build auditable work-order record from dialogue/plan/gate/runtime/authorization-tier/approval/execution signals.
  - Default outputs:
    - `.sce/reports/interactive-work-order.json`
    - `.sce/reports/interactive-work-order.md`

Interactive approval workflow helper (script-level stage-B approval state machine):
- `node scripts/interactive-approval-workflow.js --action <init|submit|approve|reject|execute|verify|archive|status> [--plan <path>] [--state-file <path>] [--audit-file <path>] [--actor <id>] [--actor-role <name>] [--role-policy <path>] [--comment <text>] [--password <text>] [--password-hash <sha256>] [--password-hash-env <name>] [--password-required] [--password-scope <csv>] [--json]`: maintain approval lifecycle state for interactive change plans and append approval events to JSONL audit logs.
  - Default state file: `.sce/reports/interactive-approval-state.json`
  - Default audit file: `.sce/reports/interactive-approval-events.jsonl`
  - `init` requires `--plan`; high-risk plans are marked as `approval_required=true`.
  - Password authorization can be required per plan (`plan.authorization.password_required=true`) or overridden in `init`.
  - `execute` is blocked (exit code `2`) when approval is required but current status is not `approved`.

Interactive Moqui adapter helper (script-level stage-C controlled execution contract):
- `node scripts/interactive-moqui-adapter.js --action <capabilities|plan|validate|apply|low-risk-apply|rollback> [--intent <path>] [--context <path>] [--plan <path>] [--execution-id <id>] [--execution-mode <suggestion|apply>] [--policy <path>] [--catalog <path>] [--moqui-config <path>] [--live-apply] [--no-dry-run] [--allow-suggestion-apply] [--json]`: run unified Moqui adapter interface (`capabilities/plan/validate/apply/low-risk-apply/rollback`) for interactive customization stage-C.
  - Default plan output (`--action plan`): `.sce/reports/interactive-change-plan.adapter.json`
  - Default command output: `.sce/reports/interactive-moqui-adapter.json`
  - Default execution record (for `apply`/`rollback`): `.sce/reports/interactive-execution-record.latest.json`
  - Default append-only execution ledger: `.sce/reports/interactive-execution-ledger.jsonl`
  - `low-risk-apply` is one-click mode: only `risk_level=low` and gate decision `allow` can execute.
  - `apply` exits with code `2` when result is non-success (`failed` or `skipped`), ensuring CI-safe gating.
- npm alias: `npm run report:interactive-adapter-capabilities`

Interactive user feedback helper (script-level stage-D feedback ingestion):
- `node scripts/interactive-feedback-log.js --score <0..5> [--comment <text>] [--user-id <id>] [--session-id <id>] [--intent-id <id>] [--plan-id <id>] [--execution-id <id>] [--channel <ui|cli|api|other>] [--tags <csv>] [--product <name>] [--module <name>] [--page <name>] [--scene-id <name>] [--feedback-file <path>] [--json]`: append structured business-user feedback records into the interactive feedback JSONL stream for governance metrics.
  - Default feedback file: `.sce/reports/interactive-user-feedback.jsonl`
  - Score range: `0..5`
- npm alias: `npm run log:interactive-feedback -- --score 5 --comment "clear and safe"`

Interactive governance report helper (script-level stage-D/6 observability + alerting):
- `node scripts/interactive-governance-report.js [--intent-audit <path>] [--approval-audit <path>] [--execution-ledger <path>] [--feedback-file <path>] [--matrix-signals <path>] [--dialogue-authorization-signals <path>] [--runtime-signals <path>] [--authorization-tier-signals <path>] [--thresholds <path>] [--period <weekly|monthly|all|custom>] [--from <iso>] [--to <iso>] [--out <path>] [--markdown-out <path>] [--fail-on-alert] [--json]`: compute interactive governance KPIs (adoption/success/rollback/security-intercept/satisfaction + matrix pass/regression/stage-error + dialogue/runtime/authorization-tier pressure), evaluate threshold breaches, and emit machine/human-readable governance report.
  - Default thresholds: `docs/interactive-customization/governance-threshold-baseline.json`
  - Default minimum intent sample threshold: `min_intent_samples=5` (below this becomes warning, not breach)
  - Default feedback input: `.sce/reports/interactive-user-feedback.jsonl`
  - Default matrix input: `.sce/reports/interactive-matrix-signals.jsonl`
  - Default dialogue authorization signal input: `.sce/reports/interactive-dialogue-authorization-signals.jsonl`
  - Default runtime policy signal input: `.sce/reports/interactive-runtime-signals.jsonl`
  - Default authorization tier signal input: `.sce/reports/interactive-authorization-tier-signals.jsonl`
  - Default outputs:
    - `.sce/reports/interactive-governance-report.json`
    - `.sce/reports/interactive-governance-report.md`
  - `--fail-on-alert` exits with code `2` when medium/high breaches exist.
- npm alias: `npm run report:interactive-governance`

Moqui standard rebuild helper (script-level recovery bootstrap):
- `node scripts/moqui-standard-rebuild.js [--metadata <path>] [--out <path>] [--markdown-out <path>] [--bundle-out <path>] [--json]`: build a standard Moqui recovery bundle from metadata, including recommended SCE template matrix, recovery spec plan, handoff manifest seed, ontology seed, and page-copilot context contract.
  - Output now includes `recovery.readiness_matrix`, `recovery.readiness_summary`, and `recovery.prioritized_gaps` for template capability matrix scoring and remediation planning.
  - Bundle now includes `rebuild/matrix-remediation.lines` (gap remediation queue lines).
  - Bundle now includes `rebuild/matrix-remediation-plan.json|.md` (gap-to-source-file remediation plan).
  - This workflow is scoped to SCE outputs and does not mutate business project code directly.
  - Recommended usage for rebuild target path: `E:/workspace/331-poc-rebuild` (keep `331-poc` repair stream isolated).

Moqui rebuild gate helper (CI/pre-release readiness gate):
- `node scripts/moqui-rebuild-gate.js [--metadata <path>] [--out <path>] [--markdown-out <path>] [--bundle-out <path>] [--min-ready <n>] [--max-partial <n>] [--max-gap <n>]`: run rebuild and fail when readiness gate is not met (default: ready>=6, partial<=0, gap<=0).
- npm alias: `npm run gate:moqui-rebuild`

Moqui metadata extractor helper (script-level catalog bootstrap):
- `node scripts/moqui-metadata-extract.js [--project-dir <path>] [--out <path>] [--markdown-out <path>] [--json]`: build a normalized metadata catalog from multiple sources for rebuild automation. Default sources include Moqui XML resources (`entity/service/screen/form/rule/decision`), scene package contracts (`.sce/specs/**/docs/scene-package.json`), handoff manifest/capability matrix, and handoff evidence JSON.
  - Recommended first step before `moqui-standard-rebuild`.
  - Keep extraction source read-only and run rebuild generation against SCE output directories.

Recommended `.sce/config/orchestrator.json`:

```json
{
  "agentBackend": "codex",
  "maxParallel": 3,
  "timeoutSeconds": 900,
  "maxRetries": 2,
  "rateLimitProfile": "balanced",
  "rateLimitMaxRetries": 8,
  "rateLimitBackoffBaseMs": 1500,
  "rateLimitBackoffMaxMs": 60000,
  "rateLimitAdaptiveParallel": true,
  "rateLimitParallelFloor": 1,
  "rateLimitCooldownMs": 45000,
  "rateLimitLaunchBudgetPerMinute": 8,
  "rateLimitLaunchBudgetWindowMs": 60000,
  "rateLimitSignalWindowMs": 30000,
  "rateLimitSignalThreshold": 3,
  "rateLimitSignalExtraHoldMs": 3000,
  "rateLimitDynamicBudgetFloor": 1,
  "apiKeyEnvVar": "CODEX_API_KEY",
  "codexArgs": ["--skip-git-repo-check"],
  "codexCommand": "npx @openai/codex"
}
```

`rateLimitProfile` applies preset anti-429 behavior (`conservative|balanced|aggressive`). Any explicit `rateLimit*` field in `orchestrator.json` overrides the selected profile value.

`rateLimit*` settings provide dedicated retry/backoff and adaptive throttling when providers return 429 / too-many-requests errors. Engine retry honors `Retry-After` / `try again in ...` hints from provider error messages and clamps final retry waits by `rateLimitBackoffMaxMs` to avoid unbounded pause windows. During active backoff windows, new pending spec launches are paused to reduce request bursts (launch hold remains active even if adaptive parallel throttling is disabled). Sustained 429 spikes are additionally controlled by:
- `rateLimitSignalWindowMs`: rolling signal window for spike detection
- `rateLimitSignalThreshold`: signals required inside window before escalation
- `rateLimitSignalExtraHoldMs`: extra launch hold per escalation unit
- `rateLimitDynamicBudgetFloor`: lowest dynamic launch budget allowed during sustained pressure

`orchestrate stop` interrupts pending retry waits immediately so long backoff windows do not look like deadlocks.

Codex sub-agent permission defaults:
- `--sandbox danger-full-access` is always injected by orchestrator runtime.
- `--ask-for-approval never` is injected by default when `codexArgs` does not explicitly set approval mode.
- Explicit `codexArgs` values still win, for example `--ask-for-approval on-request`.

### Scene Template Engine

```bash
# Template registry (typed templates + compatibility filters)
sce templates list --type <spec-scaffold|capability-template|runtime-playbook> --compatible-with <semver> --risk <low|medium|high|critical>
sce templates search <keyword> --type <spec-scaffold|capability-template|runtime-playbook> --compatible-with <semver>
sce templates show <template-path>
sce templates update [--source <name>]

# Validate template variable schema in a scene package
sce scene template-validate --package <path>
sce scene template-validate --package ./my-package --json

# Resolve inheritance chain and display merged variable schema
sce scene template-resolve --package <name>
sce scene template-resolve --package scene-erp-inventory --json

# Render template package with variable substitution
sce scene template-render --package <name> --values <json-or-path> --out <dir>
sce scene template-render --package scene-erp --values '{"entity_name":"Order"}' --out ./output --json
```

### Scene Package Batch Publish

```bash
# Publish scene package templates from a handoff manifest
# Defaults: completed specs only + ontology validation required + ontology batch gate (avg>=70, valid-rate>=100%)
sce scene package-publish-batch --manifest docs/handoffs/handoff-manifest.json --json

# Optional convenience preset for 331-style path conventions (manifest/docs fallback paths)
sce scene package-publish-batch --from-331 --json

# Preview batch publish plan without writing template files
sce scene package-publish-batch --manifest docs/handoffs/handoff-manifest.json --dry-run --json

# Publish selected specs only
sce scene package-publish-batch --manifest docs/handoffs/handoff-manifest.json --include 62-00-moqui-full-capability-closure-program,62-01-moqui-capability-itemized-parity-matrix --json

# Disable status filter and use docs/* fallback paths for manifest entries missing scene paths
sce scene package-publish-batch --manifest docs/handoffs/handoff-manifest.json --status all --fallback-spec-package docs/scene-package.json --fallback-scene-manifest docs/scene.yaml --force --json

# Read specs from non-standard manifest path
sce scene package-publish-batch --manifest docs/handoffs/handoff-manifest.json --manifest-spec-path handoff.spec_items --json

# Tighten per-spec ontology semantic quality threshold before publish
sce scene package-publish-batch --manifest docs/handoffs/handoff-manifest.json --ontology-min-score 70 --json

# Persist ontology/publish batch report for governance tracking
sce scene package-publish-batch --manifest docs/handoffs/handoff-manifest.json --dry-run --ontology-report-out .sce/reports/scene-package-ontology-batch.json --json

# Enforce batch-level ontology portfolio gate (average score + valid-rate)
sce scene package-publish-batch --manifest docs/handoffs/handoff-manifest.json --dry-run --ontology-min-average-score 60 --ontology-min-valid-rate 90 --json

# Emergency bypass (not recommended): disable ontology validation requirement
sce scene package-publish-batch --manifest docs/handoffs/handoff-manifest.json --no-require-ontology-validation --json

# Export ontology remediation task draft markdown
sce scene package-publish-batch --manifest docs/handoffs/handoff-manifest.json --dry-run --ontology-task-out .sce/reports/scene-package-ontology-task-draft.md --json

# Export ontology remediation queue lines (directly consumable by close-loop-batch)
sce scene package-publish-batch --manifest docs/handoffs/handoff-manifest.json --dry-run --ontology-task-queue-out .sce/auto/ontology-remediation.lines --json
```

Compatibility contract note:
- Scene package compatibility uses `compatibility.min_sce_version` as canonical field.

### Scene Package Ontology Backfill Batch

```bash
# Backfill ontology_model from a handoff manifest (commit mode)
sce scene package-ontology-backfill-batch --manifest docs/handoffs/handoff-manifest.json --spec-package-path docs/scene-package.json --json

# Use 331-poc preset defaults in dry-run mode
sce scene package-ontology-backfill-batch --from-331 --dry-run --json

# Backfill selected specs only
sce scene package-ontology-backfill-batch --from-331 --include 62-00-moqui-full-capability-closure-program,62-01-moqui-capability-itemized-parity-matrix --dry-run --json

# Export detailed backfill report for governance review
sce scene package-ontology-backfill-batch --from-331 --dry-run --out-report .sce/reports/scene-package-ontology-backfill-report.json --json
```

### Moqui Template Baseline Scorecard

```bash
# Preferred CLI entry: score Moqui + scene orchestration templates in the local template library
# (default filter: moqui|erp|suite|playbook|runbook|decision|action|governance)
sce scene moqui-baseline --json

# Script alias (same behavior)
npm run report:moqui-baseline

# Consolidated Moqui release gate summary (recommended before tag/publish)
npm run report:moqui-summary

# Score all scene templates instead of the default Moqui + orchestration subset
sce scene moqui-baseline --include-all --json

# Customize score thresholds and output paths
sce scene moqui-baseline \
  --min-score 75 \
  --min-valid-rate 100 \
  --out .sce/reports/moqui-template-baseline.json \
  --markdown-out .sce/reports/moqui-template-baseline.md \
  --json

# Compare with a previous baseline and fail CI on portfolio gate fail
sce scene moqui-baseline \
  --compare-with .sce/reports/release-evidence/moqui-template-baseline-prev.json \
  --fail-on-portfolio-fail \
  --json
```

Release workflow default:
- Runs interactive loop smoke (`npm run test:interactive-loop-smoke`) in test/release test jobs.
- Runs interactive flow smoke (`npm run test:interactive-flow-smoke`) in test/release test jobs.
- Runs interactive governance gate by default (`interactive-governance-report --period weekly --fail-on-alert`) in test and release pipelines.
- Evaluates matrix regression gate in CI/release with configurable policy:
  - `KSE_MATRIX_REGRESSION_GATE_ENFORCE` (`true|false`, default advisory/disabled)
  - `KSE_MATRIX_REGRESSION_GATE_MAX` (default `0`)
- Optional release summary hard-gate:
  - `KSE_MOQUI_RELEASE_SUMMARY_ENFORCE` (`true|false`, default advisory/disabled)
- Publishes `moqui-template-baseline.json` + `moqui-template-baseline.md` as release assets.
- Publishes `moqui-release-summary.json` + `moqui-release-summary.md` as release review assets.
- Publishes `interactive-governance-<tag>.json` + `interactive-governance-<tag>.md` as release evidence assets.
- Publishes `interactive-matrix-signals-<tag>.jsonl`, `matrix-regression-gate-<tag>.json`, and `matrix-remediation-plan-<tag>.{json,md}` + `matrix-remediation-<tag>.lines` + `matrix-remediation-goals-<tag>.json` + `matrix-remediation-commands-<tag>.md` + `matrix-remediation-{high,medium}-<tag>.lines` + `matrix-remediation-goals-{high,medium}-<tag>.json` + `matrix-remediation-phased-plan-<tag>.json` as release evidence assets.
- Publishes `weekly-ops-summary-<tag>.json` + `weekly-ops-summary-<tag>.md` as release operational closed-loop assets.
- Evaluates weekly ops risk gate by default (`release-weekly-ops-gate`; default block when `risk > medium` or summary missing).
- Publishes `release-risk-remediation-<tag>.json|.md|.lines` derived from unified weekly+drift gate signals.
- Evaluates and publishes release asset integrity audit (`release-asset-integrity-<tag>.json|.md`) before `npm publish`.
- Enforces baseline portfolio gate by default (`KSE_MOQUI_BASELINE_ENFORCE` defaults to `true` when unset).

### Moqui ERP Integration

```bash
# Test connectivity and authentication to Moqui ERP instance
sce scene connect --config <path>
sce scene connect --config ./moqui-config.json --json

# Discover available entities, services, and screens from Moqui ERP
sce scene discover --config <path>
sce scene discover --config ./moqui-config.json --type entities --json

# Extract scene templates from Moqui ERP instance
sce scene extract --config <path> --out <dir>
sce scene extract --config ./moqui-config.json --type entities --pattern crud --out ./templates --json
sce scene extract --config ./moqui-config.json --dry-run --json
```

### Scene Template Quality Pipeline

```bash
# Lint scene package for quality issues (10-category checks)
sce scene lint --package <path>
sce scene lint --package ./my-scene-package --json
sce scene lint --package ./my-scene-package --strict

# Calculate quality score (0-100, 5-dimension scoring with agent_readiness)
sce scene score --package <path>
sce scene score --package ./my-scene-package --json
sce scene score --package ./my-scene-package --strict

# One-stop contribute pipeline: validate → lint → score → preview → publish
sce scene contribute --package <path>
sce scene contribute --package ./my-scene-package --registry ./registry --json
sce scene contribute --package ./my-scene-package --dry-run
sce scene contribute --package ./my-scene-package --skip-lint --json
```

### Scene Ontology Enhancement

```bash
# Show ontology graph (nodes and edges) from scene manifest
sce scene ontology show --package <path>
sce scene ontology show --package ./my-scene-package --json

# Query dependency chain for a specific node reference
sce scene ontology deps --package <path> --ref <node-ref>
sce scene ontology deps --package ./my-scene-package --ref entity:Order --json

# Analyze reverse dependency impact radius (what will be affected)
sce scene ontology impact --package <path> --ref <node-ref>
sce scene ontology impact --package ./my-scene-package --ref service:createOrder --relation depends_on,composes --max-depth 2 --json

# Find shortest ontology relation path between two refs
sce scene ontology path --package <path> --from <source-ref> --to <target-ref>
sce scene ontology path --package ./my-scene-package --from service:createOrder --to entity:Order --undirected --json

# Validate ontology graph (detect dangling edges, cycles)
sce scene ontology validate --package <path>
sce scene ontology validate --package ./my-scene-package --json

# Show action abstraction info (inputs, outputs, side-effects)
sce scene ontology actions --package <path>
sce scene ontology actions --package ./my-scene-package --ref service:createOrder --json

# Parse and display data lineage (source → transform → sink)
sce scene ontology lineage --package <path>
sce scene ontology lineage --package ./my-scene-package --ref entity:Order --json

# Show agent hints (autonomous operation guidance)
sce scene ontology agent-info --package <path>
sce scene ontology agent-info --package ./my-scene-package --json
```

### Version & Upgrade

```bash
# Show version info
sce version-info

# Check for upgrades
sce upgrade check

# Perform upgrade
sce upgrade
```

---

## Global Options

```bash
# Set language
sce --lang zh <command>
sce --lang en <command>

# Show help
sce --help
sce <command> --help

# Show version
sce --version

```

---

## Common Workflows

### Starting a New Feature

```bash
# 0. Open a scene primary session
sce studio plan --scene scene.customer-order-inventory --from-chat session-20260226 --goal "new feature delivery" --json

# 1. Bootstrap spec draft
sce spec bootstrap --name 01-00-my-feature --scene scene.customer-order-inventory --non-interactive

# 2. Run spec pipeline
sce spec pipeline run --spec 01-00-my-feature --scene scene.customer-order-inventory

# 3. Run spec gate
sce spec gate run --spec 01-00-my-feature --scene scene.customer-order-inventory --json

# 4. Export context
sce context export 01-00-my-feature

# 5. Work on tasks...

# 6. Sync progress
sce workspace sync
```

### Managing Multiple Projects

```bash
# 1. Register your projects as workspaces
sce workspace create project-a ~/projects/project-a
sce workspace create project-b ~/projects/project-b

# 2. List all workspaces
sce workspace list

# 3. Switch between projects
sce workspace switch project-a

# 4. Check current workspace
sce workspace info

# 5. Work on the active project...

# 6. Switch to another project
sce workspace switch project-b
```

### Setting Up Automation

```bash
# 1. Initialize watch mode
sce watch init

# 2. Install presets
sce watch install auto-sync
sce watch install test-runner

# 3. Start watching
sce watch start

# 4. Check status
sce watch status
```

### Working with Team

```bash
# 1. Check team status
sce workspace team

# 2. Claim a task
sce task claim 01-00-feature 1.1

# 3. Work on task...

# 4. Sync when done
sce workspace sync
```

### Managing Multiple Environments

```bash
# 1. Register your environments
sce env register config/dev.json
sce env register config/staging.json
sce env register config/prod.json

# 2. List all environments
sce env list

# 3. Switch to development environment
sce env switch development

# 4. Check current environment
sce env info

# 5. Verify environment is configured correctly
sce env verify

# 6. Run commands in environment context
sce env run "npm test"

# 7. Switch to staging for testing
sce env switch staging

# 8. Rollback if something goes wrong
sce env rollback
```

---

## Tips

1. **Use `sce` not compatibility aliases** (`sco` / `sce` / `scene-capability-engine`) - Shorter and easier to type
2. **Add `--help` to any command** - Get detailed usage information
3. **Use tab completion** - Most shells support command completion
4. **Check `sce doctor`** - Diagnose issues quickly
5. **Use watch mode** - Automate repetitive tasks
6. **Use workspace management** - Easily switch between multiple sce projects
7. **Use environment management** - Manage dev, test, staging, prod configurations with automatic backup
8. **Use multi-repo management** - Coordinate operations across multiple Git repositories

---

## Detailed Command Documentation

### Multi-Repository Management Commands

#### `sce repo init`

Initialize repository configuration by scanning the project directory for Git repositories.

**Usage:**
```bash
sce repo init [options]
```

**Options:**
- `--force` - Overwrite existing configuration without confirmation
- `--depth <n>` - Maximum directory depth to scan (default: 3)

**Behavior:**
- Scans project directory recursively for Git repositories
- Excludes `.sce` directory from scanning
- Extracts remote URL from `origin` remote (or first available remote)
- Detects current branch for each repository
- Prompts for confirmation if configuration already exists (unless `--force`)
- Creates `.sce/project-repos.json` configuration file

**Example:**
```bash
# Initialize with default settings
sce repo init

# Force overwrite without confirmation
sce repo init --force

# Scan deeper directory structure
sce repo init --depth 5
```

**Output:**
```
Scanning for Git repositories...
Found 3 repositories:
  ✓ frontend (main) - https://github.com/user/frontend.git
  ✓ backend (develop) - https://github.com/user/backend.git
  ✓ shared (main) - https://github.com/user/shared.git

Configuration saved to .sce/project-repos.json
```

---

#### `sce repo status`

Display the Git status of all configured repositories.

**Usage:**
```bash
sce repo status [options]
```

**Options:**
- `--verbose` - Show detailed file-level changes
- `--json` - Output in JSON format for scripting

**Output includes:**
- Current branch name
- Number of modified, added, and deleted files
- Commits ahead/behind remote
- Clean/dirty status indicator
- Error status for inaccessible repositories

**Example:**
```bash
# Basic status
sce repo status

# Detailed status with file changes
sce repo status --verbose

# JSON output for automation
sce repo status --json
```

**Output:**
```
┌──────────┬─────────┬────────┬──────────┬───────┬────────┐
│ Name     │ Branch  │ Status │ Modified │ Ahead │ Behind │
├──────────┼─────────┼────────┼──────────┼───────┼────────┤
│ frontend │ main    │ Clean  │ 0        │ 0     │ 0      │
│ backend  │ develop │ Dirty  │ 3        │ 2     │ 0      │
│ shared   │ main    │ Clean  │ 0        │ 0     │ 1      │
└──────────┴─────────┴────────┴──────────┴───────┴────────┘
```

---

#### `sce repo exec`

Execute a Git command in all configured repositories.

**Usage:**
```bash
sce repo exec "<command>" [options]
```

**Options:**
- `--dry-run` - Show commands without executing them
- `--continue-on-error` - Continue even if commands fail (default: true)

**Behavior:**
- Executes command sequentially in each repository
- Displays output for each repository with clear separators
- Continues with remaining repositories if one fails
- Shows summary of successes and failures at the end

**Example:**
```bash
# Pull latest changes
sce repo exec "git pull"

# Create and checkout new branch
sce repo exec "git checkout -b feature/new-feature"

# Preview without executing
sce repo exec "git push" --dry-run

# Fetch all remotes
sce repo exec "git fetch --all"

# Show commit history
sce repo exec "git log --oneline -5"
```

**Output:**
```
=== frontend ===
Already up to date.

=== backend ===
Updating abc123..def456
Fast-forward
 src/api.js | 10 +++++-----
 1 file changed, 5 insertions(+), 5 deletions(-)

=== shared ===
Already up to date.

Summary: 3 succeeded, 0 failed
```

---

#### `sce repo health`

Perform health checks on all configured repositories.

**Usage:**
```bash
sce repo health [options]
```

**Options:**
- `--json` - Output in JSON format for automation

**Checks performed:**
- Path exists and is accessible
- Directory is a valid Git repository
- Remote URL is reachable (network check)
- Default branch exists

**Example:**
```bash
# Run health check
sce repo health

# JSON output for CI/CD
sce repo health --json
```

**Output:**
```
┌──────────┬──────────────┬────────────┬──────────────────┬───────────────┐
│ Name     │ Path Exists  │ Git Repo   │ Remote Reachable │ Branch Exists │
├──────────┼──────────────┼────────────┼──────────────────┼───────────────┤
│ frontend │ ✓            │ ✓          │ ✓                │ ✓             │
│ backend  │ ✓            │ ✓          │ ✓                │ ✓             │
│ shared   │ ✓            │ ✓          │ ✗                │ ✓             │
└──────────┴──────────────┴────────────┴──────────────────┴───────────────┘

Overall Health: 2 healthy, 1 unhealthy
```

---

## See Also

- [Multi-Repository Management Guide](./multi-repo-management-guide.md)
- [Environment Management Guide](./environment-management-guide.md)
- [Manual Workflows Guide](./manual-workflows-guide.md)
- [Cross-Tool Guide](./cross-tool-guide.md)
- [Adoption Guide](./adoption-guide.md)
- [Developer Guide](./developer-guide.md)
- [Errorbook Registry Guide](./errorbook-registry.md)

---

**Need Help?**
- Run `sce --help` for command reference
- Check [GitHub Issues](https://github.com/heguangyong/scene-capability-engine/issues)
- Review [Documentation](../README.md)


