const {
  readGovernanceCloseLoopSessionEntries,
  resolveGovernanceCloseLoopSessionFile,
  loadGovernanceCloseLoopSessionPayload,
  persistGovernanceCloseLoopSession
} = require('../../../lib/auto/governance-session-storage-service');

describe('auto governance session storage service', () => {
  test('reads governance session entries with derived telemetry', async () => {
    const payload = {
      governance_session: { id: 'gov-1' },
      status: 'failed',
      target_risk: 'high',
      final_assessment: { health: { risk_level: 'medium', release_gate: { available: true } } },
      rounds: [{}],
      stop_detail: { reasons: ['weekly-ops-latest-blocked'], weekly_ops: { latest: { blocked: true } } },
      updated_at: '2026-03-07T00:00:00.000Z'
    };
    const sessions = await readGovernanceCloseLoopSessionEntries('proj', {
      getGovernanceCloseLoopSessionDir: () => '.sce/auto/governance-close-loop-sessions',
      fs: {
        pathExists: async () => true,
        readdir: async () => ['gov-1.json'],
        stat: async () => ({ mtimeMs: 1000 }),
        readJson: async () => payload
      },
      normalizeGovernanceReleaseGateSnapshot: (value) => value,
      summarizeGovernanceRoundReleaseGateTelemetry: () => ({ observed_rounds: 1, changed_rounds: 0 }),
      normalizeGovernanceWeeklyOpsStopDetail: (value) => value,
      deriveGovernanceWeeklyOpsReasonFlags: () => ({ blocked: true })
    });
    expect(sessions[0]).toEqual(expect.objectContaining({ id: 'gov-1', status: 'failed', round_release_gate_observed: 1 }));
  });

  test('loads latest governance session payload', async () => {
    const loaded = await loadGovernanceCloseLoopSessionPayload('proj', 'latest', {
      readGovernanceCloseLoopSessionEntries: async () => [{ file: 'gov-1.json' }],
      getGovernanceCloseLoopSessionDir: () => '.sce/auto/governance-close-loop-sessions',
      sanitizeBatchSessionId: (value) => value,
      fs: {
        pathExists: async () => true,
        readJson: async () => ({ governance_session: { id: 'gov-1' } })
      }
    });
    expect(loaded).toEqual(expect.objectContaining({ id: 'gov-1', file: 'gov-1.json' }));
  });

  test('persists governance close-loop session payload', async () => {
    const writes = [];
    const persisted = await persistGovernanceCloseLoopSession('proj', 'gov-1', { mode: 'x' }, 'running', {
      sanitizeBatchSessionId: (value) => value,
      getGovernanceCloseLoopSessionDir: () => '.sce/auto/governance-close-loop-sessions',
      schemaVersion: '1.0',
      fs: {
        ensureDir: async () => {},
        writeJson: async (file, payload) => writes.push({ file, payload })
      },
      now: () => new Date('2026-03-07T00:00:00.000Z')
    });
    expect(persisted).toEqual(expect.objectContaining({ id: 'gov-1' }));
    expect(writes[0].payload.governance_session.id).toBe('gov-1');
  });
});
