const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { runCliWithRetry } = require('./cli-runner');

const packageJson = require('../../package.json');

function runCli(args, options = {}) {
  return runCliWithRetry(args, {
    cwd: options.cwd || process.cwd(),
    timeoutMs: options.timeoutMs || 10000,
    skipSteeringCheck: options.skipSteeringCheck !== false,
    maxTransientRetries: options.maxTransientRetries || 1
  });
}

describe('version CLI integration', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-version-cli-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  test('prints package version deterministically', async () => {
    const result = await runCli(['--version'], { cwd: tempDir });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.trim()).toBe('');
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  test('version command is allowlisted even with legacy .kiro directory present', async () => {
    await fs.ensureDir(path.join(tempDir, '.kiro', 'steering'));
    await fs.writeFile(path.join(tempDir, '.kiro', 'steering', 'ENVIRONMENT.md'), '# legacy', 'utf8');

    const result = await runCli(['--version'], { cwd: tempDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
    expect(await fs.pathExists(path.join(tempDir, '.kiro', 'steering', 'ENVIRONMENT.md'))).toBe(true);
  });

  test('version command has no steering cleanup side effects', async () => {
    await fs.ensureDir(path.join(tempDir, '.sce', 'steering', 'compiled'));
    await fs.writeFile(path.join(tempDir, '.sce', 'steering', 'manifest.yaml'), 'schema_version: 1.0', 'utf8');
    await fs.writeFile(path.join(tempDir, '.sce', 'steering', 'compiled', 'steering-codex.json'), '{"ok":true}', 'utf8');
    await fs.writeFile(path.join(tempDir, '.sce', 'steering', 'legacy-temp.txt'), 'keep', 'utf8');

    const result = await runCli(['--version'], { cwd: tempDir, skipSteeringCheck: false });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'steering', 'manifest.yaml'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'steering', 'compiled', 'steering-codex.json'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'steering', 'legacy-temp.txt'))).toBe(true);

    const backupDir = path.join(tempDir, '.sce', 'backups');
    const backups = await fs.pathExists(backupDir) ? await fs.readdir(backupDir) : [];
    const cleanupBackups = backups.filter((name) => name.startsWith('steering-cleanup-'));
    expect(cleanupBackups).toHaveLength(0);
  });
});
