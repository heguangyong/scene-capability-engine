const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { SessionStore } = require('../../../lib/runtime/session-store');

describe('SessionStore', () => {
  let tempDir;
  let store;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-session-store-'));
    store = new SessionStore(tempDir);
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  test('startSession creates a new session record', async () => {
    const session = await store.startSession({
      tool: 'codex',
      agentVersion: '1.2.3',
      objective: 'test objective',
      sessionId: 'my-session',
    });

    expect(session.session_id).toBe('my-session');
    expect(session.tool).toBe('codex');
    expect(session.agent_version).toBe('1.2.3');
    expect(session.status).toBe('active');
    expect(session.steering.manifest_path).toBe('.sce/steering/manifest.yaml');
    expect(session.steering.compatibility.supported).toBe(true);

    const sessionPath = path.join(tempDir, '.sce/sessions/my-session.json');
    expect(await fs.pathExists(sessionPath)).toBe(true);
  });

  test('resumeSession updates latest session status and timeline', async () => {
    await store.startSession({
      tool: 'generic',
      objective: 'resume flow',
      sessionId: 'resume-me',
    });

    const resumed = await store.resumeSession('latest', { status: 'paused' });
    expect(resumed.session_id).toBe('resume-me');
    expect(resumed.status).toBe('paused');
    expect(resumed.timeline.some((event) => event.event === 'session_resumed')).toBe(true);
  });

  test('snapshotSession appends snapshots and updates status', async () => {
    await store.startSession({
      tool: 'claude',
      objective: 'snapshot flow',
      sessionId: 'snap-me',
    });

    const updated = await store.snapshotSession('snap-me', {
      summary: 'checkpoint A',
      status: 'active',
      payload: { changed_files: 3 },
    });

    expect(updated.snapshots).toHaveLength(1);
    expect(updated.snapshots[0].summary).toBe('checkpoint A');
    expect(updated.snapshots[0].payload.changed_files).toBe(3);
    expect(updated.timeline.some((event) => event.event === 'snapshot_created')).toBe(true);
  });

  test('getSession latest returns most recent updated session', async () => {
    await store.startSession({ sessionId: 'first', objective: 'first' });
    await store.startSession({ sessionId: 'second', objective: 'second' });
    await store.snapshotSession('second', { summary: 'newer' });

    const latest = await store.getSession('latest');
    expect(latest.session_id).toBe('second');
  });

  test('beginSceneSession binds one active primary session per scene', async () => {
    const first = await store.beginSceneSession({
      sceneId: 'scene.customer-order',
      objective: 'cycle one'
    });
    expect(first.created_new).toBe(true);
    expect(first.scene_cycle).toBe(1);
    expect(first.session.scene.id).toBe('scene.customer-order');
    expect(first.session.scene.role).toBe('primary');

    const second = await store.beginSceneSession({
      sceneId: 'scene.customer-order',
      objective: 'cycle one retry'
    });
    expect(second.created_new).toBe(false);
    expect(second.session.session_id).toBe(first.session.session_id);
    expect(second.scene_cycle).toBe(1);
  });

  test('completeSceneSession archives current cycle and auto starts next cycle', async () => {
    const current = await store.beginSceneSession({
      sceneId: 'scene.fulfillment',
      objective: 'fulfillment cycle'
    });

    const completion = await store.completeSceneSession('scene.fulfillment', current.session.session_id, {
      summary: 'release completed'
    });

    expect(completion.completed_session.status).toBe('completed');
    expect(completion.completed_session.scene.state).toBe('completed');
    expect(completion.next_session).toBeDefined();
    expect(completion.next_session.scene.id).toBe('scene.fulfillment');
    expect(completion.next_session.scene.role).toBe('primary');
    expect(completion.next_scene_cycle).toBe(2);
    expect(completion.next_session.session_id).not.toBe(current.session.session_id);
  });

  test('listSceneRecords can read from sqlite index when scene-index file is missing', async () => {
    await store.beginSceneSession({
      sceneId: 'scene.sqlite-fallback',
      objective: 'sqlite fallback'
    });

    await fs.remove(path.join(tempDir, '.sce', 'session-governance', 'scene-index.json'));

    const records = await store.listSceneRecords();
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records[0]).toEqual(expect.objectContaining({
      scene_id: 'scene.sqlite-fallback'
    }));
    expect(Array.isArray(records[0].cycles)).toBe(true);

    const diagnostics = await store.getSceneIndexDiagnostics();
    expect(diagnostics).toEqual(expect.objectContaining({
      read_preference: 'sqlite',
      status: expect.any(String)
    }));
  });
});
