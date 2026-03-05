# Orchestrator Rate-Limit Profiles

This document defines the default anti-429 presets used by SCE multi-agent orchestration.

## Profiles

| Profile | Positioning | Best for |
|---|---|---|
| `conservative` | strongest throttling, safest | unstable provider quota windows, repeated `429` spikes |
| `balanced` | default baseline | normal daily multi-agent runs |
| `aggressive` | higher throughput, lower safety margin | stable quota windows with strict delivery deadlines |

## Effective Preset Values

| Key | conservative | balanced | aggressive |
|---|---:|---:|---:|
| `rateLimitMaxRetries` | 10 | 8 | 6 |
| `rateLimitBackoffBaseMs` | 2200 | 1500 | 1000 |
| `rateLimitBackoffMaxMs` | 90000 | 60000 | 30000 |
| `rateLimitCooldownMs` | 60000 | 45000 | 20000 |
| `rateLimitLaunchBudgetPerMinute` | 4 | 8 | 16 |
| `rateLimitSignalWindowMs` | 45000 | 30000 | 20000 |
| `rateLimitSignalThreshold` | 2 | 3 | 4 |
| `rateLimitSignalExtraHoldMs` | 5000 | 3000 | 2000 |
| `rateLimitDynamicBudgetFloor` | 1 | 1 | 2 |
| `rateLimitRetrySpreadMs` | 1200 | 600 | 250 |
| `rateLimitLaunchHoldPollMs` | 1000 | 1000 | 1000 |
| `rateLimitDecisionEventThrottleMs` | 1000 | 1000 | 1000 |

## Usage

Persistent (writes `.sce/config/orchestrator.json`):

```bash
sce orchestrate profile set conservative
sce orchestrate profile set balanced --reset-overrides
```

One-shot for a single run (does not change file):

```bash
sce orchestrate run --specs "spec-a,spec-b,spec-c" --rate-limit-profile conservative
```

Inspect current effective state:

```bash
sce orchestrate profile show --json
```

## Validation Checklist

Run anti-429 regression:

```bash
npm run test:orchestrator-429
```

Run full suite before release:

```bash
npm test -- --runInBand
```

Release readiness criteria:

1. No failing test in orchestrator/rate-limit scope.
2. `orchestrate profile show --json` returns expected profile and effective values.
3. Multi-agent run no longer stalls under sustained `429`; launch budget and hold telemetry progress over time.
4. `rate-limit:decision` events are emitted as machine-readable telemetry for retry/throttle/recovery transitions.
