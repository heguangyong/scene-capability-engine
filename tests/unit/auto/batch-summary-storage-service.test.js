const {
  getCloseLoopBatchSummaryDir,
  readCloseLoopBatchSummaryEntries,
  resolveCloseLoopBatchSummaryFile,
  loadCloseLoopBatchSummaryPayload
} = require('../../../lib/auto/batch-summary-storage-service');

describe('auto batch summary storage service', () => {
  test('returns batch summary directory', () => {
    expect(getCloseLoopBatchSummaryDir('proj')).toContain('.sce');
  });

  test('reads batch summary entries', async () => {
    const sessions = await readCloseLoopBatchSummaryEntries('proj', {
      fs: {
        pathExists: async () => true,
        readdir: async () => ['b1.json'],
        stat: async () => ({ mtimeMs: 1000 }),
        readJson: async () => ({ batch_session: { id: 'b1' }, status: 'completed', total_goals: 2, processed_goals: 2, updated_at: '2026-03-07T00:00:00.000Z' })
      }
    });
    expect(sessions[0]).toEqual(expect.objectContaining({ id: 'b1', status: 'completed' }));
  });

  test('resolves latest batch summary file', async () => {
    const file = await resolveCloseLoopBatchSummaryFile('proj', 'latest', {
      fs: {
        pathExists: async () => true,
        readdir: async () => ['b1.json'],
        stat: async () => ({ mtimeMs: 1000 })
      }
    });
    expect(file).toContain('b1.json');
  });

  test('loads batch summary payload', async () => {
    const loaded = await loadCloseLoopBatchSummaryPayload('proj', 'b1.json', {
      fs: { pathExists: async () => true, readJson: async () => ({ status: 'completed' }) }
    });
    expect(loaded).toEqual(expect.objectContaining({ file: expect.stringContaining('b1.json') }));
  });
});
