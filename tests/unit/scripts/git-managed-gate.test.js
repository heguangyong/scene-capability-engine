'use strict';

const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  parseArgs,
  evaluateGitManagedGate,
  runGitManagedGateScript
} = require('../../../scripts/git-managed-gate');

function runGit(repoPath, args) {
  const result = spawnSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return `${result.stdout || ''}`.trim();
}

function initManagedRepo(baseDir) {
  const repoPath = path.join(baseDir, 'repo');
  const remotePath = path.join(baseDir, 'remotes', 'github.com', 'acme', 'sample.git');
  fs.ensureDirSync(repoPath);
  fs.ensureDirSync(path.dirname(remotePath));

  runGit(repoPath, ['init', '-b', 'main']);
  runGit(repoPath, ['config', 'user.email', 'bot@example.com']);
  runGit(repoPath, ['config', 'user.name', 'bot']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# sample\n', 'utf8');
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init']);
  runGit(baseDir, ['init', '--bare', remotePath]);
  runGit(repoPath, ['remote', 'add', 'origin', remotePath]);
  runGit(repoPath, ['push', '-u', 'origin', 'main']);

  return {
    repoPath,
    remotePath
  };
}

describe('git-managed-gate script', () => {
  let tempDir;
  let originalLog;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-git-managed-gate-'));
    originalLog = console.log;
    console.log = jest.fn();
  });

  afterEach(async () => {
    console.log = originalLog;
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  test('parseArgs supports core flags', () => {
    const parsed = parseArgs([
      '--project-path', tempDir,
      '--fail-on-violation',
      '--no-allow-no-remote',
      '--allow-untracked',
      '--target-hosts', 'github.com,gitlab.com',
      '--ci-context',
      '--strict-ci',
      '--json'
    ]);

    expect(parsed.projectPath).toBe(path.resolve(tempDir));
    expect(parsed.failOnViolation).toBe(true);
    expect(parsed.allowNoRemote).toBe(false);
    expect(parsed.allowUntracked).toBe(true);
    expect(parsed.targetHosts).toEqual(['github.com', 'gitlab.com']);
    expect(parsed.ciContext).toBe(true);
    expect(parsed.strictCi).toBe(true);
    expect(parsed.json).toBe(true);
  });

  test('parseArgs auto-detects CI context from environment', () => {
    const parsed = parseArgs([], {
      CI: 'true',
      SCE_GIT_MANAGEMENT_STRICT_CI: '1',
      SCE_GIT_MANAGEMENT_ALLOW_UNTRACKED: 'true'
    });

    expect(parsed.ciContext).toBe(true);
    expect(parsed.strictCi).toBe(true);
    expect(parsed.allowUntracked).toBe(true);
  });

  test('passes with warning when no github/gitlab remote and allowNoRemote is true', () => {
    const repoPath = path.join(tempDir, 'local-only');
    fs.ensureDirSync(repoPath);
    runGit(repoPath, ['init', '-b', 'main']);

    const payload = evaluateGitManagedGate({
      projectPath: repoPath,
      allowNoRemote: true,
      targetHosts: ['github.com', 'gitlab.com']
    });

    expect(payload.passed).toBe(true);
    expect(payload.reason).toBe('no-target-remote-allowed');
    expect(payload.warnings.length).toBeGreaterThanOrEqual(1);
  });

  test('fails when managed remote exists but local branch is ahead', () => {
    const { repoPath } = initManagedRepo(tempDir);
    fs.writeFileSync(path.join(repoPath, 'CHANGELOG.md'), 'new line\n', 'utf8');
    runGit(repoPath, ['add', '.']);
    runGit(repoPath, ['commit', '-m', 'ahead commit']);

    const payload = evaluateGitManagedGate({
      projectPath: repoPath,
      allowNoRemote: false,
      targetHosts: ['github.com', 'gitlab.com']
    });

    expect(payload.passed).toBe(false);
    expect(payload.violations.some((item) => item.includes('ahead of upstream'))).toBe(true);
  });

  test('passes when managed remote exists and branch is clean+synced', async () => {
    const { repoPath } = initManagedRepo(tempDir);

    const payload = await runGitManagedGateScript({
      projectPath: repoPath,
      failOnViolation: true,
      json: true,
      allowNoRemote: false,
      targetHosts: ['github.com', 'gitlab.com']
    });

    expect(payload.passed).toBe(true);
    expect(payload.exit_code).toBe(0);
    expect(payload.reason).toBe('managed-and-synced');
  });

  test('returns exit code 2 when failOnViolation is enabled and gate fails', async () => {
    const repoPath = path.join(tempDir, 'local-only-fail');
    fs.ensureDirSync(repoPath);
    runGit(repoPath, ['init', '-b', 'main']);

    const payload = await runGitManagedGateScript({
      projectPath: repoPath,
      failOnViolation: true,
      json: true,
      allowNoRemote: false,
      targetHosts: ['github.com', 'gitlab.com']
    });

    expect(payload.passed).toBe(false);
    expect(payload.exit_code).toBe(2);
  });

  test('passes in CI mode when detached HEAD is expected', () => {
    const { repoPath } = initManagedRepo(tempDir);
    runGit(repoPath, ['checkout', '--detach', 'HEAD']);

    const payload = evaluateGitManagedGate({
      projectPath: repoPath,
      allowNoRemote: false,
      targetHosts: ['github.com', 'gitlab.com'],
      ciContext: true,
      strictCi: false
    });

    expect(payload.passed).toBe(true);
    expect(payload.warnings.some((item) => item.includes('ci context detected'))).toBe(true);
  });

  test('passes in relaxed CI mode even when tracked worktree changes exist', () => {
    const { repoPath } = initManagedRepo(tempDir);
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# changed in ci\n', 'utf8');

    const payload = evaluateGitManagedGate({
      projectPath: repoPath,
      allowNoRemote: false,
      targetHosts: ['github.com', 'gitlab.com'],
      ciContext: true,
      strictCi: false
    });

    expect(payload.passed).toBe(true);
    expect(payload.details.worktree_enforced).toBe(false);
    expect(payload.warnings.some((item) => item.includes('tracked worktree changes'))).toBe(true);
  });

  test('allows untracked files when allowUntracked is enabled', () => {
    const { repoPath } = initManagedRepo(tempDir);
    fs.writeFileSync(path.join(repoPath, 'temp-generated.json'), '{"ok":true}\n', 'utf8');

    const payload = evaluateGitManagedGate({
      projectPath: repoPath,
      allowNoRemote: false,
      allowUntracked: true,
      targetHosts: ['github.com', 'gitlab.com']
    });

    expect(payload.passed).toBe(true);
    expect(payload.details.worktree_changes.untracked_count).toBeGreaterThan(0);
    expect(payload.warnings.some((item) => item.includes('untracked files detected'))).toBe(true);
  });

  test('still fails when tracked changes exist even if allowUntracked is enabled', () => {
    const { repoPath } = initManagedRepo(tempDir);
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# modified\n', 'utf8');

    const payload = evaluateGitManagedGate({
      projectPath: repoPath,
      allowNoRemote: false,
      allowUntracked: true,
      targetHosts: ['github.com', 'gitlab.com']
    });

    expect(payload.passed).toBe(false);
    expect(payload.violations).toContain('working tree has uncommitted changes');
  });

  test('fails in strict CI mode when detached HEAD has no upstream', () => {
    const { repoPath } = initManagedRepo(tempDir);
    runGit(repoPath, ['checkout', '--detach', 'HEAD']);

    const payload = evaluateGitManagedGate({
      projectPath: repoPath,
      allowNoRemote: false,
      targetHosts: ['github.com', 'gitlab.com'],
      ciContext: true,
      strictCi: true
    });

    expect(payload.passed).toBe(false);
    expect(payload.violations).toEqual(expect.arrayContaining([
      'detached HEAD is not allowed for managed release',
      'current branch has no upstream tracking branch'
    ]));
  });

  test('fails in strict CI mode when tracked worktree changes exist', () => {
    const { repoPath } = initManagedRepo(tempDir);
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# strict ci changed\n', 'utf8');

    const payload = evaluateGitManagedGate({
      projectPath: repoPath,
      allowNoRemote: false,
      targetHosts: ['github.com', 'gitlab.com'],
      ciContext: true,
      strictCi: true
    });

    expect(payload.passed).toBe(false);
    expect(payload.details.worktree_enforced).toBe(true);
    expect(payload.violations).toContain('working tree has uncommitted changes');
  });
});
