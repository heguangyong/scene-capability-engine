const {
  resolveLatestRecoverableBatchSummary,
  resolveLatestPendingControllerSession
} = require('../../../lib/auto/recovery-selection-service');

describe('auto recovery selection service', () => {
  test('resolves latest recoverable batch summary by pending goals', async () => {
    const result = await resolveLatestRecoverableBatchSummary('proj', 'pending', {
      readCloseLoopBatchSummaryEntries: async () => [{ file: 'a.json' }, { file: 'b.json' }],
      loadCloseLoopBatchSummaryPayload: async (_projectPath, file) => ({ file, payload: { ok: true } }),
      buildCloseLoopBatchGoalsFromSummaryPayload: async (_payload, file) => ({ goals: file === 'a.json' ? [] : ['g1'] })
    });
    expect(result).toEqual(expect.objectContaining({ file: 'b.json' }));
  });

  test('resolves latest pending controller session', async () => {
    const result = await resolveLatestPendingControllerSession('proj', {
      readCloseLoopControllerSessionEntries: async () => [{ pending_goals: 0 }, { file: 'c.json', pending_goals: 2 }],
      loadCloseLoopControllerSessionPayload: async () => ({ file: 'c.json', payload: { ok: true } })
    });
    expect(result).toEqual(expect.objectContaining({ file: 'c.json' }));
  });
});
