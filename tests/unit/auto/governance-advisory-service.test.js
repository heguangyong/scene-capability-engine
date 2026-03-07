const {
  executeGovernanceAdvisoryRecover,
  executeGovernanceAdvisoryControllerResume
} = require('../../../lib/auto/governance-advisory-service');

describe('auto governance advisory service', () => {
  test('executes recover advisory and returns applied summary', async () => {
    const result = await executeGovernanceAdvisoryRecover('proj', {}, {
      normalizeGovernanceAdvisoryRecoverMaxRounds: (_value, fallback) => fallback,
      loadCloseLoopBatchSummaryPayload: async () => ({ file: 'sum.json', payload: {} }),
      resolveRecoveryMemoryScope: async () => 'scope-a',
      executeCloseLoopRecoveryCycle: async () => ({
        summary: {
          status: 'completed',
          processed_goals: 2,
          failed_goals: 0,
          recovery_cycle: { round: 1 },
          batch_session: { file: 'batch.json' }
        }
      }),
      readCloseLoopBatchSummaryEntries: async () => [{ file: 'sum.json' }],
      buildCloseLoopBatchGoalsFromSummaryPayload: async () => ({ goals: ['g1'] })
    });
    expect(result).toEqual(expect.objectContaining({
      id: 'recover-latest',
      status: 'applied',
      source_summary_file: 'sum.json'
    }));
  });

  test('executes controller advisory and returns applied summary', async () => {
    const result = await executeGovernanceAdvisoryControllerResume('proj', {}, {
      normalizeGovernanceAdvisoryControllerMaxCycles: (_value, fallback) => fallback,
      loadCloseLoopControllerSessionPayload: async () => ({ file: 'controller.json', payload: {} }),
      runCloseLoopController: async () => ({
        status: 'completed',
        cycles_performed: 1,
        processed_goals: 2,
        failed_goals: 0,
        pending_goals: 0,
        stop_reason: 'queue-empty',
        controller_session: { file: 'controller.json' }
      }),
      readCloseLoopControllerSessionEntries: async () => [{ file: 'controller.json', pending_goals: 1 }]
    });
    expect(result).toEqual(expect.objectContaining({
      id: 'controller-resume-latest',
      status: 'applied',
      source_controller_session_file: 'controller.json'
    }));
  });
});
