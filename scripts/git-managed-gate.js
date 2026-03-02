#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function parseBoolean(value, fallback = false) {
  const normalized = normalizeText(`${value || ''}`).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseArgs(argv = [], env = process.env) {
  const ciDetected = parseBoolean(env.GITHUB_ACTIONS, false) || parseBoolean(env.CI, false);
  const options = {
    projectPath: process.cwd(),
    failOnViolation: false,
    allowNoRemote: parseBoolean(env.SCE_GIT_MANAGEMENT_ALLOW_NO_REMOTE, true),
    allowUntracked: parseBoolean(env.SCE_GIT_MANAGEMENT_ALLOW_UNTRACKED, false),
    targetHosts: normalizeText(env.SCE_GIT_MANAGEMENT_TARGET_HOSTS || 'github.com,gitlab.com')
      .split(',')
      .map((item) => normalizeText(item).toLowerCase())
      .filter(Boolean),
    ciContext: ciDetected,
    strictCi: parseBoolean(env.SCE_GIT_MANAGEMENT_STRICT_CI, false),
    json: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    if (token === '--project-path' && next) {
      options.projectPath = path.resolve(next);
      index += 1;
    } else if (token === '--fail-on-violation') {
      options.failOnViolation = true;
    } else if (token === '--allow-no-remote') {
      options.allowNoRemote = true;
    } else if (token === '--no-allow-no-remote') {
      options.allowNoRemote = false;
    } else if (token === '--allow-untracked') {
      options.allowUntracked = true;
    } else if (token === '--no-allow-untracked') {
      options.allowUntracked = false;
    } else if (token === '--target-hosts' && next) {
      options.targetHosts = `${next}`
        .split(',')
        .map((item) => normalizeText(item).toLowerCase())
        .filter(Boolean);
      index += 1;
    } else if (token === '--ci-context') {
      options.ciContext = true;
    } else if (token === '--no-ci-context') {
      options.ciContext = false;
    } else if (token === '--strict-ci') {
      options.strictCi = true;
    } else if (token === '--no-strict-ci') {
      options.strictCi = false;
    } else if (token === '--json') {
      options.json = true;
    } else if (token === '--help' || token === '-h') {
      options.help = true;
    }
  }

  if (options.targetHosts.length === 0) {
    options.targetHosts = ['github.com', 'gitlab.com'];
  }
  return options;
}

function printHelp() {
  const lines = [
    'Usage: node scripts/git-managed-gate.js [options]',
    '',
    'Options:',
    '  --project-path <path>     Project path (default: cwd)',
    '  --fail-on-violation       Exit with code 2 when violations exist',
    '  --allow-no-remote         Allow pass when no GitHub/GitLab remote is configured',
    '  --no-allow-no-remote      Fail when no GitHub/GitLab remote is configured',
    '  --allow-untracked         Allow untracked files in worktree (tracked changes still fail)',
    '  --no-allow-untracked      Fail when untracked files exist (default)',
    '  --target-hosts <csv>      Remote host match list (default: github.com,gitlab.com)',
    '  --ci-context              Treat current run as CI context (default from CI/GITHUB_ACTIONS env)',
    '  --no-ci-context           Force local mode even if CI env exists',
    '  --strict-ci               In CI, enforce local-level branch/upstream sync checks',
    '  --no-strict-ci            In CI, relax detached/upstream sync checks (default)',
    '  --json                    Print JSON payload',
    '  -h, --help                Show help'
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function runGit(projectPath, args) {
  const result = spawnSync('git', args, {
    cwd: projectPath,
    encoding: 'utf8',
    windowsHide: true
  });
  return {
    status: Number.isInteger(result.status) ? result.status : 1,
    stdout: `${result.stdout || ''}`.trim(),
    stderr: `${result.stderr || ''}`.trim()
  };
}

function parseRemotes(raw = '', targetHosts = []) {
  const lines = `${raw || ''}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const byName = new Map();

  for (const line of lines) {
    const match = line.match(/^([^\s]+)\s+([^\s]+)\s+\((fetch|push)\)$/i);
    if (!match) {
      continue;
    }
    const name = match[1];
    const url = match[2];
    const kind = match[3].toLowerCase();
    const current = byName.get(name) || { name, fetch: '', push: '' };
    if (kind === 'fetch') {
      current.fetch = url;
    } else if (kind === 'push') {
      current.push = url;
    }
    byName.set(name, current);
  }

  const allRemotes = Array.from(byName.values());
  const normalizedHosts = targetHosts.map((item) => `${item}`.toLowerCase());
  const targetRemotes = allRemotes.filter((remote) => {
    const url = `${remote.fetch || remote.push || ''}`.toLowerCase();
    return normalizedHosts.some((host) => url.includes(host));
  });

  return {
    allRemotes,
    targetRemotes
  };
}

function parseAheadBehind(raw = '') {
  const parts = `${raw}`.trim().split(/\s+/).map((item) => Number.parseInt(item, 10));
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
    return { ahead: null, behind: null };
  }
  return {
    ahead: parts[0],
    behind: parts[1]
  };
}

function parsePorcelainStatus(raw = '') {
  const lines = `${raw || ''}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let trackedCount = 0;
  let untrackedCount = 0;
  for (const line of lines) {
    if (line.startsWith('??')) {
      untrackedCount += 1;
      continue;
    }
    trackedCount += 1;
  }
  return {
    total_count: lines.length,
    tracked_count: trackedCount,
    untracked_count: untrackedCount
  };
}

function evaluateGitManagedGate(options = {}) {
  const projectPath = options.projectPath || process.cwd();
  const targetHosts = Array.isArray(options.targetHosts) ? options.targetHosts : ['github.com', 'gitlab.com'];
  const allowNoRemote = options.allowNoRemote !== false;
  const allowUntracked = options.allowUntracked === true;
  const ciContext = options.ciContext === true;
  const strictCi = options.strictCi === true;
  const relaxForCi = ciContext && !strictCi;

  const violations = [];
  const warnings = [];
  const details = {
    project_path: projectPath,
    target_hosts: targetHosts,
    ci_context: ciContext,
    strict_ci: strictCi,
    relaxed_ci: relaxForCi,
    remotes: [],
    target_remotes: [],
    branch: null,
    upstream: null,
    ahead: null,
    behind: null,
    clean_worktree: null,
    worktree_changes: {
      total_count: 0,
      tracked_count: 0,
      untracked_count: 0
    }
  };

  const insideWorkTree = runGit(projectPath, ['rev-parse', '--is-inside-work-tree']);
  if (insideWorkTree.status !== 0 || insideWorkTree.stdout.toLowerCase() !== 'true') {
    return {
      mode: 'git-managed-gate',
      passed: false,
      reason: 'not-a-git-repository',
      violations: ['current directory is not a git repository'],
      warnings,
      details
    };
  }

  const remotesResult = runGit(projectPath, ['remote', '-v']);
  if (remotesResult.status !== 0) {
    violations.push(`failed to read git remotes: ${remotesResult.stderr || 'unknown error'}`);
    return {
      mode: 'git-managed-gate',
      passed: false,
      reason: 'remote-read-failed',
      violations,
      warnings,
      details
    };
  }

  const remoteInfo = parseRemotes(remotesResult.stdout, targetHosts);
  details.remotes = remoteInfo.allRemotes;
  details.target_remotes = remoteInfo.targetRemotes;

  if (remoteInfo.targetRemotes.length === 0) {
    if (allowNoRemote) {
      warnings.push('no GitHub/GitLab remote configured; gate bypassed by allow-no-remote policy');
      return {
        mode: 'git-managed-gate',
        passed: true,
        reason: 'no-target-remote-allowed',
        violations,
        warnings,
        details
      };
    }
    violations.push('no GitHub/GitLab remote configured');
    return {
      mode: 'git-managed-gate',
      passed: false,
      reason: 'no-target-remote',
      violations,
      warnings,
      details
    };
  }

  const statusResult = runGit(projectPath, ['status', '--porcelain']);
  if (statusResult.status !== 0) {
    violations.push(`failed to read git status: ${statusResult.stderr || 'unknown error'}`);
  } else {
    const statusSummary = parsePorcelainStatus(statusResult.stdout);
    details.worktree_changes = statusSummary;
    const hasTrackedChanges = statusSummary.tracked_count > 0;
    const hasUntrackedFiles = statusSummary.untracked_count > 0;
    details.clean_worktree = !hasTrackedChanges && (!hasUntrackedFiles || allowUntracked);

    if (hasTrackedChanges) {
      violations.push('working tree has uncommitted changes');
    }
    if (hasUntrackedFiles && !allowUntracked) {
      violations.push('working tree has untracked files');
    } else if (hasUntrackedFiles && allowUntracked) {
      warnings.push(`untracked files detected (${statusSummary.untracked_count}) but allowed by policy`);
    }
  }

  if (relaxForCi) {
    warnings.push('ci context detected; branch/upstream sync checks skipped');
  } else {
    const branchResult = runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branchResult.status !== 0) {
      violations.push(`failed to resolve branch: ${branchResult.stderr || 'unknown error'}`);
    } else {
      details.branch = branchResult.stdout;
      if (details.branch === 'HEAD') {
        violations.push('detached HEAD is not allowed for managed release');
      }
    }

    const upstreamResult = runGit(projectPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (upstreamResult.status !== 0) {
      violations.push('current branch has no upstream tracking branch');
    } else {
      details.upstream = upstreamResult.stdout;
      const upstreamRemote = normalizeText(upstreamResult.stdout.split('/')[0]);
      const upstreamIsTarget = remoteInfo.targetRemotes.some((item) => item.name === upstreamRemote);
      if (!upstreamIsTarget) {
        violations.push(`upstream remote "${upstreamRemote}" is not GitHub/GitLab target`);
      } else {
        const aheadBehindResult = runGit(projectPath, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
        if (aheadBehindResult.status !== 0) {
          violations.push(`failed to compare with upstream: ${aheadBehindResult.stderr || 'unknown error'}`);
        } else {
          const { ahead, behind } = parseAheadBehind(aheadBehindResult.stdout);
          details.ahead = ahead;
          details.behind = behind;
          if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
            violations.push('failed to parse ahead/behind status');
          } else {
            if (ahead > 0) {
              violations.push(`branch is ahead of upstream by ${ahead} commit(s); push required`);
            }
            if (behind > 0) {
              violations.push(`branch is behind upstream by ${behind} commit(s); sync required`);
            }
          }
        }
      }
    }
  }

  return {
    mode: 'git-managed-gate',
    passed: violations.length === 0,
    reason: violations.length === 0 ? 'managed-and-synced' : 'violations',
    violations,
    warnings,
    details
  };
}

async function runGitManagedGateScript(options = {}) {
  const payload = evaluateGitManagedGate(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (payload.passed) {
    process.stdout.write('[git-managed-gate] passed\n');
  } else {
    process.stdout.write('[git-managed-gate] blocked\n');
    payload.violations.forEach((item) => {
      process.stdout.write(`[git-managed-gate] violation=${item}\n`);
    });
  }

  return {
    ...payload,
    exit_code: options.failOnViolation && !payload.passed ? 2 : 0
  };
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2), process.env);
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  runGitManagedGateScript(options)
    .then((result) => {
      process.exitCode = result.exit_code;
    })
    .catch((error) => {
      const payload = {
        mode: 'git-managed-gate',
        passed: false,
        error: error.message
      };
      if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        process.stderr.write(`[git-managed-gate] error=${error.message}\n`);
      }
      process.exitCode = 1;
    });
}

module.exports = {
  parseArgs,
  parseRemotes,
  parsePorcelainStatus,
  evaluateGitManagedGate,
  runGitManagedGateScript
};
