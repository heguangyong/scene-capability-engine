#!/usr/bin/env node
'use strict';

const path = require('path');
const { evaluateErrorbookReleaseGate } = require('../lib/commands/errorbook');

function parseArgs(argv = []) {
  const options = {
    minRisk: 'high',
    minQuality: 70,
    includeVerified: false,
    failOnBlock: false,
    json: false,
    projectPath: process.cwd()
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    if (token === '--min-risk' && next) {
      options.minRisk = `${next}`.trim().toLowerCase();
      index += 1;
    } else if (token === '--min-quality' && next) {
      const parsed = Number.parseInt(`${next}`, 10);
      if (Number.isFinite(parsed)) {
        options.minQuality = Math.max(0, Math.min(100, parsed));
      }
      index += 1;
    } else if (token === '--include-verified') {
      options.includeVerified = true;
    } else if (token === '--fail-on-block') {
      options.failOnBlock = true;
    } else if (token === '--json') {
      options.json = true;
    } else if (token === '--project-path' && next) {
      options.projectPath = path.resolve(next);
      index += 1;
    } else if (token === '--help' || token === '-h') {
      options.help = true;
    }
  }

  return options;
}

function printHelp() {
  const lines = [
    'Usage: node scripts/errorbook-release-gate.js [options]',
    '',
    'Options:',
    '  --min-risk <level>      Risk threshold to block release (low|medium|high, default: high)',
    '  --min-quality <0-100>   Minimum curation quality for unresolved entries (default: 70)',
    '  --include-verified      Also inspect verified (non-promoted) entries for risk threshold',
    '                          (temporary mitigation policy is always enforced for active entries)',
    '  --fail-on-block         Exit with code 2 when gate is blocked',
    '  --project-path <path>   Override project path (default: cwd)',
    '  --json                  Print JSON payload',
    '  -h, --help              Show this help'
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function runErrorbookReleaseGateScript(options = {}) {
  const payload = await evaluateErrorbookReleaseGate({
    minRisk: options.minRisk,
    minQuality: options.minQuality,
    includeVerified: options.includeVerified
  }, {
    projectPath: options.projectPath
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (payload.passed) {
    process.stdout.write('[errorbook-release-gate] passed\n');
    process.stdout.write(`[errorbook-release-gate] inspected=${payload.inspected_count} blocked=0\n`);
  } else {
    process.stdout.write('[errorbook-release-gate] blocked\n');
    process.stdout.write(
      `[errorbook-release-gate] inspected=${payload.inspected_count} blocked=${payload.blocked_count} min-risk=${payload.gate.min_risk} min-quality=${payload.gate.min_quality}\n`
    );
    process.stdout.write(
      `[errorbook-release-gate] risk-blocked=${payload.risk_blocked_count || 0} curation-blocked=${payload.curation_blocked_count || 0} mitigation-blocked=${payload.mitigation_blocked_count || 0}\n`
    );
    payload.blocked_entries.slice(0, 20).forEach((item) => {
      const policy = Array.isArray(item.policy_violations) && item.policy_violations.length > 0
        ? ` policy=${item.policy_violations.join('|')}`
        : '';
      process.stdout.write(
        `[errorbook-release-gate] entry=${item.id} risk=${item.risk} status=${item.status} quality=${item.quality_score}${policy}\n`
      );
    });
  }

  const exitCode = options.failOnBlock && !payload.passed ? 2 : 0;
  return {
    ...payload,
    exit_code: exitCode
  };
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  runErrorbookReleaseGateScript(options)
    .then((result) => {
      process.exitCode = result.exit_code;
    })
    .catch((error) => {
      const payload = {
        mode: 'errorbook-release-gate',
        passed: false,
        error: error.message
      };
      if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        process.stderr.write(`[errorbook-release-gate] error=${error.message}\n`);
      }
      process.exitCode = 1;
    });
}

module.exports = {
  parseArgs,
  runErrorbookReleaseGateScript
};
