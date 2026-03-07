const {
  listCloseLoopSessions,
  statsCloseLoopControllerSessions,
  listGovernanceCloseLoopSessions
} = require('../../../lib/auto/session-query-service');

describe('auto session query service', () => {
  test('lists close-loop sessions through shared presenter path', async () => {
    const payload = await listCloseLoopSessions('proj', { limit: 1 }, {
      readCloseLoopSessionEntries: async () => ([{ id: 's1', status: 'completed' }, { id: 's2', status: 'failed' }]),
      normalizeStatusFilter: () => [],
      filterEntriesByStatus: (items) => items,
      normalizeLimit: (value, fallback) => value || fallback,
      presentCloseLoopSessionList: (projectPath, sessions, statusFilter, limit) => ({ projectPath, total: sessions.length, statusFilter, limit }),
      buildStatusCounts: () => ({}),
      getCloseLoopSessionDir: () => '.sce/auto/close-loop-sessions'
    });
    expect(payload).toEqual({ projectPath: 'proj', total: 2, statusFilter: [], limit: 1 });
  });

  test('builds controller stats summary', async () => {
    const payload = await statsCloseLoopControllerSessions('proj', { days: 7 }, {
      readCloseLoopControllerSessionEntries: async () => ([
        { status: 'completed', processed_goals: 2, pending_goals: 0, queue_format: 'jsonl', updated_at: 'u1', mtime_ms: 1000 },
        { status: 'failed', processed_goals: 1, pending_goals: 2, queue_format: 'yaml', updated_at: 'u2', mtime_ms: 900 }
      ]),
      normalizeStatsWindowDays: (value) => value,
      normalizeStatusFilter: () => [],
      filterEntriesByStatus: (items) => items,
      normalizeStatusToken: (value) => String(value || '').trim().toLowerCase(),
      isFailedStatus: (status) => status === 'failed',
      buildStatusCounts: () => ({ completed: 1, failed: 1 }),
      buildQueueFormatCounts: () => ({ jsonl: 1, yaml: 1 }),
      getCloseLoopControllerSessionDir: () => '.sce/auto/close-loop-controller-sessions',
      now: () => 1000
    });

    expect(payload).toEqual(expect.objectContaining({
      mode: 'auto-controller-session-stats',
      total_sessions: 2,
      completed_sessions: 1,
      failed_sessions: 1,
      processed_goals_sum: 3,
      pending_goals_sum: 2
    }));
  });

  test('lists governance sessions with resume filter', async () => {
    const payload = await listGovernanceCloseLoopSessions('proj', { resumeOnly: true }, {
      readGovernanceCloseLoopSessionEntries: async () => ([{ id: 'g1', resumed_from_governance_session_id: 'base' }]),
      normalizeStatusFilter: () => [],
      filterEntriesByStatus: (items) => items,
      filterGovernanceEntriesByResumeMode: (items) => items,
      normalizeLimit: (_value, fallback) => fallback,
      presentGovernanceSessionList: (_projectPath, sessions, _statusFilter, resumeOnly) => ({ total: sessions.length, resumeOnly }),
      buildStatusCounts: () => ({}),
      getGovernanceCloseLoopSessionDir: () => '.sce/auto/governance-close-loop-sessions'
    });
    expect(payload).toEqual({ total: 1, resumeOnly: true });
  });
});
