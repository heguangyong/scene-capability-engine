const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { Command } = require('commander');
const { registerSteeringCommands } = require('../../../lib/commands/steering');
const { registerSessionCommands } = require('../../../lib/commands/session');

describe('steering + session commands', () => {
  let tempDir;
  let cwdSpy;
  let logSpy;
  let errorSpy;
  let exitSpy;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-cmd-steering-session-'));
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(tempDir);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
  });

  afterEach(async () => {
    cwdSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    await fs.remove(tempDir);
  });

  function parseSingleJsonLog() {
    const output = logSpy.mock.calls.map((call) => call.join('')).join('');
    return JSON.parse(output);
  }

  test('steering init and compile produce artifacts', async () => {
    const program = new Command();
    program.exitOverride();
    registerSteeringCommands(program);

    await program.parseAsync(['node', 'sce', 'steering', 'init', '--json']);
    const initPayload = parseSingleJsonLog();
    expect(initPayload.success).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce/steering/manifest.yaml'))).toBe(true);

    logSpy.mockClear();
    await program.parseAsync([
      'node',
      'sce',
      'steering',
      'compile',
      '--tool',
      'codex',
      '--agent-version',
      '1.2.3',
      '--format',
      'json',
      '--json',
    ]);
    const compilePayload = parseSingleJsonLog();
    expect(compilePayload.success).toBe(true);
    expect(compilePayload.compatibility.supported).toBe(true);
    expect(compilePayload.output).toContain('.sce/steering/compiled/steering-codex.json');
    expect(await fs.pathExists(path.join(tempDir, compilePayload.output))).toBe(true);
  });

  test('session start, resume, snapshot, show works in json mode', async () => {
    const program = new Command();
    program.exitOverride();
    registerSessionCommands(program);

    await program.parseAsync([
      'node',
      'sce',
      'session',
      'start',
      'my objective',
      '--tool',
      'codex',
      '--agent-version',
      '1.2.3',
      '--id',
      'sess-001',
      '--json',
    ]);
    let payload = parseSingleJsonLog();
    expect(payload.success).toBe(true);
    expect(payload.session.session_id).toBe('sess-001');
    expect(payload.session.steering.compatibility.supported).toBe(true);

    logSpy.mockClear();
    await program.parseAsync(['node', 'sce', 'session', 'resume', 'sess-001', '--status', 'paused', '--json']);
    payload = parseSingleJsonLog();
    expect(payload.session.status).toBe('paused');

    logSpy.mockClear();
    await program.parseAsync([
      'node',
      'sce',
      'session',
      'snapshot',
      'sess-001',
      '--summary',
      'checkpoint-1',
      '--payload',
      '{"ok":true}',
      '--json',
    ]);
    payload = parseSingleJsonLog();
    expect(payload.session.snapshots).toHaveLength(1);
    expect(payload.session.snapshots[0].payload.ok).toBe(true);

    logSpy.mockClear();
    await program.parseAsync(['node', 'sce', 'session', 'show', 'sess-001', '--json']);
    payload = parseSingleJsonLog();
    expect(payload.session.session_id).toBe('sess-001');
    expect(payload.session_source).toBe('file');
    expect(payload.scene_index).toEqual(expect.objectContaining({
      status: expect.any(String)
    }));

    logSpy.mockClear();
    await program.parseAsync(['node', 'sce', 'session', 'list', '--limit', '5', '--json']);
    payload = parseSingleJsonLog();
    expect(payload.action).toBe('session_list');
    expect(Array.isArray(payload.sessions)).toBe(true);
    expect(payload.sessions.length).toBeGreaterThanOrEqual(1);
    expect(payload.session_source).toBe('file');
    expect(payload.scene_index).toEqual(expect.objectContaining({
      status: expect.any(String)
    }));
  });
});
