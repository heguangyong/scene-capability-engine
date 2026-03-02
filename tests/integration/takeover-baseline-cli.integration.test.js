const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function runCli(args, options = {}) {
  const binPath = path.join(__dirname, '..', '..', 'bin', 'scene-capability-engine.js');
  const cwd = options.cwd || process.cwd();
  const timeoutMs = options.timeoutMs || 20000;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(
      'node',
      [binPath, '--no-version-check', '--skip-steering-check', ...args],
      {
        cwd,
        env: process.env,
        shell: false
      }
    );

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`CLI command timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({
        exitCode: typeof code === 'number' ? code : 1,
        stdout,
        stderr
      });
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

describe('takeover baseline CLI integration', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-takeover-cli-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  test('startup auto-applies takeover baseline before non-audit command execution', async () => {
    await fs.ensureDir(path.join(tempDir, '.sce'));
    await fs.writeJson(path.join(tempDir, '.sce', 'version.json'), {
      'sce-version': '3.0.0',
      'template-version': '3.0.0'
    }, { spaces: 2 });

    const statusResult = await runCli(['status'], { cwd: tempDir });
    expect(statusResult.exitCode).toBe(0);

    const result = await runCli(['workspace', 'takeover-audit', '--json'], { cwd: tempDir });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(`${result.stdout}`.trim());
    expect(payload.mode).toBe('workspace-takeover-baseline');
    expect(payload.detected_project).toBe(true);
    expect(payload.passed).toBe(true);
    expect(payload.summary.pending).toBe(0);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'config', 'takeover-baseline.json'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'config', 'problem-eval-policy.json'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'config', 'problem-closure-policy.json'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'reports', 'takeover-baseline-latest.json'))).toBe(true);
  });

  test('takeover-audit reports non-sce directory gracefully', async () => {
    const result = await runCli(['workspace', 'takeover-audit', '--json'], { cwd: tempDir });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(`${result.stdout}`.trim());
    expect(payload.mode).toBe('workspace-takeover-baseline');
    expect(payload.detected_project).toBe(false);
    expect(payload.passed).toBe(true);
  });
});
