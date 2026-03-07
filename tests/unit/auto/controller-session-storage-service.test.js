const {
  readCloseLoopControllerSessionEntries,
  resolveCloseLoopControllerSessionFile,
  loadCloseLoopControllerSessionPayload
} = require('../../../lib/auto/controller-session-storage-service');

describe('auto controller session storage service', () => {
  test('reads controller session entries', async () => {
    const sessions = await readCloseLoopControllerSessionEntries('proj', {
      getCloseLoopControllerSessionDir: () => '.sce/auto/close-loop-controller-sessions',
      fs: {
        pathExists: async () => true,
        readdir: async () => ['c1.json'],
        stat: async () => ({ mtimeMs: 1000 }),
        readJson: async () => ({ controller_session: { id: 'c1' }, status: 'completed', processed_goals: 2, pending_goals: 0, updated_at: '2026-03-07T00:00:00.000Z' })
      }
    });
    expect(sessions[0]).toEqual(expect.objectContaining({ id: 'c1', status: 'completed' }));
  });

  test('resolves latest controller session file', async () => {
    const file = await resolveCloseLoopControllerSessionFile('proj', 'latest', {
      readCloseLoopControllerSessionEntries: async () => [{ file: 'c1.json' }],
      getCloseLoopControllerSessionDir: () => '.sce/auto/close-loop-controller-sessions',
      sanitizeBatchSessionId: (value) => value,
      fs: { pathExists: async () => true }
    });
    expect(file).toBe('c1.json');
  });

  test('loads controller session payload', async () => {
    const loaded = await loadCloseLoopControllerSessionPayload('proj', 'c1.json', {
      fs: { pathExists: async () => true, readJson: async () => ({ controller_session: { id: 'c1' } }) }
    });
    expect(loaded).toEqual(expect.objectContaining({ id: 'c1', file: expect.stringContaining('c1.json') }));
  });
});
