# Auto Refactor Index

## Goal

Reduce `lib/commands/auto.js` by extracting helper, presenter, summary, service, and storage logic into stable modules before final command-layer slimming.

## Current Modules

1. `lib/auto/session-metrics.js`
- `buildStatusCounts`
- `buildQueueFormatCounts`
- `buildMasterSpecCounts`
- `buildTopCountEntries`

2. `lib/auto/archive-summary.js`
- `normalizeStatusToken`
- `isCompletedStatus`
- `isFailedStatus`
- `normalizeStatsWindowDays`
- `filterEntriesByStatus`
- `filterGovernanceEntriesByResumeMode`
- `calculatePercent`

3. `lib/auto/retention-policy.js`
- `normalizeKeep`
- `normalizeSpecKeep`
- `normalizeOlderThanDays`
- `normalizeSpecSessionProtectWindowDays`
- `normalizeSpecSessionMaxTotal`
- `normalizeSpecSessionMaxCreated`
- `normalizeSpecSessionMaxCreatedPerGoal`
- `normalizeSpecSessionMaxDuplicateGoals`

4. `lib/auto/spec-protection.js`
- `collectSpecNamesFromBatchSummary`
- `collectSpecNamesFromCloseLoopSessionPayload`
- `collectSpecNamesFromBatchSummaryPayload`
- `createProtectionReasonRecord`
- `ensureProtectionReasonRecord`
- `incrementProtectionReason`
- `buildProtectionRanking`
- `buildSpecProtectionReasonPayload`

5. `lib/auto/session-presenter.js`
- `presentCloseLoopSessionList`
- `presentCloseLoopSessionStats`
- `presentControllerSessionList`

6. `lib/auto/governance-signals.js`
- `normalizeHandoffText`
- `parseAutoHandoffGateBoolean`
- `normalizeAutoHandoffGateRiskLevel`
- `toGovernanceReleaseGateNumber`
- `normalizeGovernanceReleaseGateSnapshot`
- `normalizeGovernanceWeeklyOpsStopDetail`

7. `lib/auto/governance-session-presenter.js`
- `presentGovernanceSessionList`

8. `lib/auto/governance-stats-presenter.js`
- `presentGovernanceSessionStats`

9. `lib/auto/governance-maintenance-presenter.js`
- `buildAutoGovernanceMaintenancePlan`
- `summarizeGovernanceMaintenanceExecution`

10. `lib/auto/governance-summary.js`
- `deriveGovernanceRiskLevel`
- `buildGovernanceConcerns`
- `buildGovernanceRecommendations`

11. `lib/auto/program-diagnostics.js`
- `buildProgramFailureClusters`
- `buildProgramRemediationActions`
- `buildProgramDiagnostics`

12. `lib/auto/governance-maintenance-service.js`
- `runAutoGovernanceMaintenance`

13. `lib/auto/governance-close-loop-service.js`
- `runAutoGovernanceCloseLoop`

14. `lib/auto/governance-stats-service.js`
- `buildAutoGovernanceStats`

15. `lib/auto/governance-advisory-service.js`
- `executeGovernanceAdvisoryRecover`
- `executeGovernanceAdvisoryControllerResume`

16. `lib/auto/recovery-selection-service.js`
- `resolveLatestRecoverableBatchSummary`
- `resolveLatestPendingControllerSession`

17. `lib/auto/close-loop-recovery-service.js`
- `executeCloseLoopRecoveryCycle`

18. `lib/auto/session-query-service.js`
- `listCloseLoopSessions`
- `statsCloseLoopSessions`
- `listGovernanceCloseLoopSessions`
- `statsGovernanceCloseLoopSessions`
- `listCloseLoopControllerSessions`
- `statsCloseLoopControllerSessions`

19. `lib/auto/session-prune-service.js`
- `pruneCloseLoopBatchSummarySessions`
- `pruneCloseLoopControllerSessions`
- `pruneCloseLoopSessions`
- `pruneCloseLoopBatchSummarySessionsCli`
- `pruneCloseLoopControllerSessionsCli`

20. `lib/auto/session-persistence-service.js`
- `maybePersistCloseLoopControllerSummary`
- `maybePersistCloseLoopBatchSummary`

21. `lib/auto/governance-session-storage-service.js`
- `readGovernanceCloseLoopSessionEntries`
- `resolveGovernanceCloseLoopSessionFile`
- `loadGovernanceCloseLoopSessionPayload`
- `persistGovernanceCloseLoopSession`

22. `lib/auto/controller-session-storage-service.js`
- `readCloseLoopControllerSessionEntries`
- `resolveCloseLoopControllerSessionFile`
- `loadCloseLoopControllerSessionPayload`

23. `lib/auto/batch-summary-storage-service.js`
- `getCloseLoopBatchSummaryDir`
- `readCloseLoopBatchSummaryEntries`
- `resolveCloseLoopBatchSummaryFile`
- `loadCloseLoopBatchSummaryPayload`

24. `lib/auto/close-loop-session-storage-service.js`
- `getCloseLoopSessionDir`
- `readCloseLoopSessionEntries`

25. `lib/auto/archive-schema-service.js`
- `normalizeSchemaScope`
- `normalizeTargetSchemaVersion`
- `getAutoArchiveSchemaTargets`
- `classifyArchiveSchemaCompatibility`
- `checkAutoArchiveSchema`
- `migrateAutoArchiveSchema`

## Validation Coverage

Unit tests:
- `tests/unit/auto/archive-summary.test.js`
- `tests/unit/auto/archive-schema-service.test.js`
- `tests/unit/auto/program-diagnostics.test.js`
- `tests/unit/auto/spec-protection.test.js`
- `tests/unit/auto/retention-policy.test.js`
- `tests/unit/auto/session-presenter.test.js`
- `tests/unit/auto/governance-signals.test.js`
- `tests/unit/auto/governance-session-presenter.test.js`
- `tests/unit/auto/governance-stats-presenter.test.js`
- `tests/unit/auto/governance-maintenance-presenter.test.js`
- `tests/unit/auto/governance-summary.test.js`
- `tests/unit/auto/governance-maintenance-service.test.js`
- `tests/unit/auto/governance-close-loop-service.test.js`
- `tests/unit/auto/governance-stats-service.test.js`
- `tests/unit/auto/governance-advisory-service.test.js`
- `tests/unit/auto/recovery-selection-service.test.js`
- `tests/unit/auto/close-loop-recovery-service.test.js`
- `tests/unit/auto/session-query-service.test.js`
- `tests/unit/auto/session-prune-service.test.js`
- `tests/unit/auto/session-persistence-service.test.js`
- `tests/unit/auto/governance-session-storage-service.test.js`
- `tests/unit/auto/controller-session-storage-service.test.js`
- `tests/unit/auto/batch-summary-storage-service.test.js`
- `tests/unit/auto/close-loop-session-storage-service.test.js`

Integration guardrails:
- `tests/integration/auto-close-loop-cli.integration.test.js`
- `tests/integration/version-cli.integration.test.js`
- `tests/integration/legacy-migration-guard-cli.integration.test.js`
- `tests/integration/takeover-baseline-cli.integration.test.js`

## Phase Status

- Phase 1 mainline cutover is complete for the planned `auto.js` helper/presenter/policy modules.
- Governance summary logic is extracted into `lib/auto/governance-summary.js`.
- Phase 2 service/storage extraction currently includes:
- `lib/auto/governance-maintenance-service.js`
- `lib/auto/governance-close-loop-service.js`
- `lib/auto/governance-stats-service.js`
- `lib/auto/governance-advisory-service.js`
- `lib/auto/recovery-selection-service.js`
- `lib/auto/close-loop-recovery-service.js`
- `lib/auto/session-query-service.js`
- `lib/auto/session-prune-service.js`
- `lib/auto/session-persistence-service.js`
- `lib/auto/governance-session-storage-service.js`
- `lib/auto/controller-session-storage-service.js`
- `lib/auto/batch-summary-storage-service.js`
- `lib/auto/close-loop-session-storage-service.js`
- `lib/auto/archive-schema-service.js`
- Remaining work is concentrated in final orchestration slimming, runtime side-effect governance, and documentation/release closure.

## Current Policy

- Mainline cutover and service extraction proceed one focused boundary at a time.
- Every boundary extraction requires:
1. `node --check lib/commands/auto.js`
2. targeted `tests/unit/auto/*`
3. `tests/integration/auto-close-loop-cli.integration.test.js --runInBand`
4. if startup behavior is touched, also run:
- `tests/integration/version-cli.integration.test.js`
- `tests/integration/legacy-migration-guard-cli.integration.test.js`
- `tests/integration/takeover-baseline-cli.integration.test.js`

## Stop Condition

Do not continue a boundary extraction if it causes broad `auto-close-loop` integration failures. Revert that boundary to the last stable service/storage split, then debug from there.
