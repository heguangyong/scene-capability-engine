const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_BIN_PATH = path.join(__dirname, '..', '..', 'bin', 'scene-capability-engine.js');

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  const lowered = `${value || ''}`.trim().toLowerCase();
  if (!lowered) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'y', 'on'].includes(lowered);
}

function isRetryableTransientExit(code, signal) {
  if (signal) {
    return false;
  }
  if (typeof code !== 'number' || !Number.isFinite(code)) {
    return false;
  }
  return code === -1 || (code >>> 0) === 4294967295;
}

function runCliWithRetry(args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1, Number.parseInt(`${options.timeoutMs}`, 10))
    : 20000;
  const nodeArgs = Array.isArray(options.nodeArgs) ? options.nodeArgs : [];
  const env = options.env ? { ...process.env, ...options.env } : process.env;
  const binPath = options.binPath || DEFAULT_BIN_PATH;
  const skipSteeringCheck = options.skipSteeringCheck !== false;
  const maxTransientRetries = Number.isFinite(Number(options.maxTransientRetries))
    ? Math.max(0, Number.parseInt(`${options.maxTransientRetries}`, 10))
    : 1;
  const shell = normalizeBoolean(options.shell, false);

  return new Promise((resolve, reject) => {
    const runAttempt = (attemptNo) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const child = spawn(
        'node',
        [
          ...nodeArgs,
          binPath,
          '--no-version-check',
          ...(skipSteeringCheck ? ['--skip-steering-check'] : []),
          ...args
        ],
        {
          cwd,
          env,
          shell
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

      child.on('close', (code, signal) => {
        clearTimeout(timeout);

        if (timedOut) {
          reject(new Error(`CLI command timed out after ${timeoutMs}ms`));
          return;
        }

        if (attemptNo < maxTransientRetries && isRetryableTransientExit(code, signal)) {
          runAttempt(attemptNo + 1);
          return;
        }

        resolve({
          exitCode: typeof code === 'number' && Number.isFinite(code) ? code : 1,
          stdout,
          stderr,
          retries: attemptNo
        });
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    };

    runAttempt(0);
  });
}

module.exports = {
  runCliWithRetry
};
