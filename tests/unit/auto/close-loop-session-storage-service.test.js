const {
  getCloseLoopSessionDir,
  readCloseLoopSessionEntries
} = require('../../../lib/auto/close-loop-session-storage-service');

describe('auto close-loop session storage service', () => {
  test('returns close-loop session directory', () => {
    expect(getCloseLoopSessionDir('proj')).toContain('.sce');
  });

  test('reads close-loop session entries', async () => {
    const sessions = await readCloseLoopSessionEntries('proj', {
      fs: {
        pathExists: async () => true,
        readdir: async () => ['s1.json'],
        stat: async () => ({ mtimeMs: 1000 }),
        readJson: async () => ({ session_id: 's1', status: 'completed', goal: 'goal', portfolio: { master_spec: '01-00', sub_specs: ['01-01'] }, updated_at: '2026-03-07T00:00:00.000Z' })
      }
    });
    expect(sessions[0]).toEqual(expect.objectContaining({ id: 's1', status: 'completed', master_spec: '01-00', sub_spec_count: 1 }));
  });
});
