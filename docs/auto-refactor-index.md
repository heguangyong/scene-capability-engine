# Auto Refactor Index

## Goal

Reduce `lib/commands/auto.js` by extracting pure helper and presenter logic into stable modules before any mainline cutover.

## Current Shadow Modules

1. `lib/auto/session-metrics.js`
- `buildStatusCounts`
- `buildQueueFormatCounts`
- `buildMasterSpecCounts`
- `buildTopCountEntries`

2. `lib/auto/program-diagnostics.js`
- `buildProgramFailureClusters`
- `buildProgramRemediationActions`
- `buildProgramDiagnostics`

3. `lib/auto/spec-protection.js`
- `collectSpecNamesFromBatchSummary`
- `collectSpecNamesFromCloseLoopSessionPayload`
- `collectSpecNamesFromBatchSummaryPayload`
- `createProtectionReasonRecord`
- `ensureProtectionReasonRecord`
- `incrementProtectionReason`
- `buildProtectionRanking`
- `buildSpecProtectionReasonPayload`

4. `lib/auto/archive-summary.js`
- `normalizeStatusToken`
- `isCompletedStatus`
- `isFailedStatus`
- `normalizeStatsWindowDays`
- `filterEntriesByStatus`
- `filterGovernanceEntriesByResumeMode`
- `calculatePercent`

5. `lib/auto/retention-policy.js`
- `normalizeKeep`
- `normalizeSpecKeep`
- `normalizeOlderThanDays`
- `normalizeSpecSessionProtectWindowDays`
- `normalizeSpecSessionMaxTotal`
- `normalizeSpecSessionMaxCreated`
- `normalizeSpecSessionMaxCreatedPerGoal`
- `normalizeSpecSessionMaxDuplicateGoals`

6. `lib/auto/session-presenter.js`
- `presentCloseLoopSessionList`
- `presentCloseLoopSessionStats`
- `presentControllerSessionList`

7. `lib/auto/governance-signals.js`
- `normalizeHandoffText`
- `parseAutoHandoffGateBoolean`
- `normalizeAutoHandoffGateRiskLevel`
- `toGovernanceReleaseGateNumber`
- `normalizeGovernanceReleaseGateSnapshot`
- `normalizeGovernanceWeeklyOpsStopDetail`

8. `lib/auto/governance-session-presenter.js`
- `presentGovernanceSessionList`

9. `lib/auto/governance-stats-presenter.js`
- `presentGovernanceSessionStats`

10. `lib/auto/governance-maintenance-presenter.js`
- `buildAutoGovernanceMaintenancePlan`
- `summarizeGovernanceMaintenanceExecution`

## Validation Coverage

Unit tests:
- `tests/unit/auto/archive-summary.test.js`
- `tests/unit/auto/program-diagnostics.test.js`
- `tests/unit/auto/spec-protection.test.js`
- `tests/unit/auto/retention-policy.test.js`
- `tests/unit/auto/session-presenter.test.js`
- `tests/unit/auto/governance-signals.test.js`
- `tests/unit/auto/governance-session-presenter.test.js`
- `tests/unit/auto/governance-stats-presenter.test.js`
- `tests/unit/auto/governance-maintenance-presenter.test.js`
- `tests/unit/auto/governance-summary.test.js`

Integration guardrails:
- `tests/integration/auto-close-loop-cli.integration.test.js`
- `tests/integration/version-cli.integration.test.js`
- `tests/integration/legacy-migration-guard-cli.integration.test.js`
- `tests/integration/takeover-baseline-cli.integration.test.js`

## Safe Mainline Cutover Order

1. `session-metrics` [completed]
- Low-level counters only.
- Verified via auto session/batch-session/controller-session/governance stats integration coverage.

2. `archive-summary` [completed]
- Shared status classification and percent calculation.
- Verified via all session list/stats and governance archive integration coverage.

3. `retention-policy` [completed]
- Shared retention/prune argument normalization.
- Verified via session/spec-session/batch-session/controller-session/governance-session prune integration coverage.

4. `spec-protection` [completed]
- Shared spec protection and reason ranking.
- Verified via spec-session prune protection ranking and close-loop-batch budget-guard integration coverage.

5. `session-presenter` [completed]
- Shared result payload builders for session list/stats.
- Verified via all session list/stats commands and governance archive integration coverage.

6. `governance-signals` [completed]
- Shared release gate / weekly ops normalization.
- Verified via auto governance stats/maintain/close-loop integration coverage.

7. `program-diagnostics` [completed]
- Shared close-loop program failure clustering and remediation advice.
- Verified via close-loop-program/close-loop-recover/KPI/audit integration coverage.

8. `governance-session-presenter` [completed]
- Shared governance session list payload builder.
- Verified via auto governance session list integration coverage.

9. `governance-stats-presenter` [completed]
- Shared governance stats payload builder.
- Verified via auto governance stats integration coverage.

10. `governance-maintenance-presenter` [completed]
- Shared maintenance plan/result summary.
- Verified via auto governance maintain/close-loop integration coverage.

## Phase Status

- Phase 1 mainline cutover is complete for the planned `auto.js` shadow modules.
- Governance summary logic is also extracted into `lib/auto/governance-summary.js`.
- Phase 2 has started with `lib/auto/governance-maintenance-service.js` as the first orchestration service extraction.
- Next phase should focus on service-layer extraction for session/archive/governance orchestration.
- Phase 2 now includes `lib/auto/governance-close-loop-service.js` alongside governance maintenance orchestration.

- Phase 2 now also includes `lib/auto/governance-stats-service.js` for governance archive aggregation and health synthesis.
## Current Policy
- Phase 2 now also includes `lib/auto/governance-advisory-service.js` for recovery/controller advisory execution and latest-source selection.

- Phase 2 now also includes `lib/auto/session-query-service.js` for close-loop/controller/governance session list/stats orchestration.
- Shadow modules may be added freely if they are pure and unit-tested.
- Phase 2 now also includes `lib/auto/session-prune-service.js` for close-loop/batch/controller session prune orchestration.
- Mainline cutover is allowed only one cluster at a time.
- Phase 2 now also includes `lib/auto/session-persistence-service.js` for batch/controller session persistence and retention-trigger orchestration.
- Every cutover requires:
- Phase 2 now also includes `lib/auto/governance-session-storage-service.js` for governance session read/load/persist storage boundaries.
  1. `node --check lib/commands/auto.js`
- Phase 2 now also includes `lib/auto/controller-session-storage-service.js` for controller session read/resolve/load storage boundaries.
  2. `npx jest tests/integration/auto-close-loop-cli.integration.test.js --runInBand`
- Phase 2 now also includes `lib/auto/batch-summary-storage-service.js` for batch summary read/resolve/load storage boundaries.
  3. If startup behavior is touched, also run:
- Phase 2 now also includes `lib/auto/close-loop-session-storage-service.js` for close-loop session read storage boundaries.
     - `tests/integration/version-cli.integration.test.js`
     - `tests/integration/legacy-migration-guard-cli.integration.test.js`
     - `tests/integration/takeover-baseline-cli.integration.test.js`

## Stop Condition

Do not continue cutover if any single-cluster change causes broad `auto-close-loop` integration failures. Revert that cutover and keep only the shadow module + unit tests.
