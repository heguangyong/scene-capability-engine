const chalk = require('chalk');
const fs = require('fs-extra');
const {
  grantWriteAuthorizationLease,
  revokeWriteAuthorizationLease,
  collectWriteAuthorizationStatus,
  getWriteAuthorizationLease
} = require('../security/write-authorization');

function normalizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(`${value}`, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeScopeInput(value) {
  if (Array.isArray(value)) {
    return value;
  }
  const text = normalizeString(value);
  if (!text) {
    return [];
  }
  return text.split(/[,\s]+/g).map((item) => normalizeString(item)).filter(Boolean);
}

function printAuthPayload(payload, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const mode = normalizeString(payload.mode);
  if (mode === 'auth-grant') {
    console.log(chalk.blue(`Auth lease granted: ${payload.lease.lease_id}`));
    console.log(`  Subject: ${payload.lease.subject}`);
    console.log(`  Role: ${payload.lease.role}`);
    console.log(`  Scope: ${(payload.lease.scope || []).join(', ') || 'n/a'}`);
    console.log(`  Expires: ${payload.lease.expires_at || 'n/a'}`);
    console.log(`  Store: ${payload.store_path || 'n/a'}`);
    return;
  }

  if (mode === 'auth-revoke') {
    console.log(chalk.blue(`Auth lease revoked: ${payload.lease.lease_id}`));
    console.log(`  Subject: ${payload.lease.subject}`);
    console.log(`  Revoked at: ${payload.lease.revoked_at || 'n/a'}`);
    console.log(`  Store: ${payload.store_path || 'n/a'}`);
    return;
  }

  if (mode === 'auth-status') {
    if (payload.lease) {
      console.log(chalk.blue(`Auth lease: ${payload.lease.lease_id}`));
      console.log(`  Subject: ${payload.lease.subject}`);
      console.log(`  Role: ${payload.lease.role}`);
      console.log(`  Scope: ${(payload.lease.scope || []).join(', ') || 'n/a'}`);
      console.log(`  Expires: ${payload.lease.expires_at || 'n/a'}`);
      console.log(`  Revoked: ${payload.lease.revoked_at || 'no'}`);
    } else {
      console.log(chalk.blue('Auth lease status'));
      console.log(`  Active leases: ${payload.summary.active_lease_count}`);
      console.log(`  Events: ${payload.summary.event_count}`);
    }
    console.log(`  Store: ${payload.store_path || 'n/a'}`);
  }
}

async function runAuthGrantCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;

  const granted = await grantWriteAuthorizationLease({
    subject: options.subject,
    role: options.role,
    scope: normalizeScopeInput(options.scope),
    ttlMinutes: normalizeInteger(options.ttlMinutes, 15),
    reason: options.reason,
    authPassword: options.authPassword,
    actor: options.actor,
    metadata: {
      source: 'sce auth grant'
    }
  }, {
    projectPath,
    fileSystem,
    env,
    authSecret: dependencies.authSecret
  });

  const payload = {
    mode: 'auth-grant',
    success: true,
    policy: granted.policy,
    policy_path: granted.policy_path,
    lease: granted.lease,
    store_path: granted.store_path
  };

  printAuthPayload(payload, options);
  return payload;
}

async function runAuthStatusCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;
  const leaseId = normalizeString(options.lease);

  if (leaseId) {
    const [status, lease] = await Promise.all([
      collectWriteAuthorizationStatus({
        activeOnly: options.all !== true,
        limit: normalizeInteger(options.limit, 20),
        eventsLimit: normalizeInteger(options.eventsLimit, 20)
      }, {
        projectPath,
        fileSystem,
        env
      }),
      getWriteAuthorizationLease(leaseId, {
        projectPath,
        fileSystem,
        env
      })
    ]);

    const payload = {
      mode: 'auth-status',
      success: true,
      policy: status.policy,
      policy_path: status.policy_path,
      lease: lease || null,
      summary: {
        active_lease_count: Array.isArray(status.leases) ? status.leases.length : 0,
        event_count: Array.isArray(status.events) ? status.events.length : 0
      },
      events: Array.isArray(status.events) ? status.events : [],
      store_path: status.store_path
    };
    printAuthPayload(payload, options);
    return payload;
  }

  const status = await collectWriteAuthorizationStatus({
    activeOnly: options.all !== true,
    limit: normalizeInteger(options.limit, 20),
    eventsLimit: normalizeInteger(options.eventsLimit, 20)
  }, {
    projectPath,
    fileSystem,
    env
  });

  const payload = {
    mode: 'auth-status',
    success: true,
    policy: status.policy,
    policy_path: status.policy_path,
    leases: Array.isArray(status.leases) ? status.leases : [],
    events: Array.isArray(status.events) ? status.events : [],
    summary: {
      active_lease_count: Array.isArray(status.leases) ? status.leases.length : 0,
      event_count: Array.isArray(status.events) ? status.events.length : 0
    },
    store_path: status.store_path
  };

  printAuthPayload(payload, options);
  return payload;
}

async function runAuthRevokeCommand(options = {}, dependencies = {}) {
  const leaseId = normalizeString(options.lease);
  if (!leaseId) {
    throw new Error('--lease is required');
  }

  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;

  const revoked = await revokeWriteAuthorizationLease(leaseId, {
    authPassword: options.authPassword,
    reason: options.reason,
    actor: options.actor
  }, {
    projectPath,
    fileSystem,
    env,
    authSecret: dependencies.authSecret
  });

  const payload = {
    mode: 'auth-revoke',
    success: true,
    policy: revoked.policy,
    policy_path: revoked.policy_path,
    lease: revoked.lease,
    store_path: revoked.store_path
  };

  printAuthPayload(payload, options);
  return payload;
}

function runAuthCommand(handler, options = {}, context = 'auth') {
  Promise.resolve(handler(options))
    .catch((error) => {
      console.error(chalk.red(`${context} failed: ${error.message}`));
      process.exitCode = 1;
    });
}

function registerAuthCommands(program) {
  const auth = program
    .command('auth')
    .description('Manage temporary write authorization leases');

  auth
    .command('grant')
    .description('Grant a write authorization lease (persisted in sqlite)')
    .option('--subject <subject>', 'Lease subject (default: current user)')
    .option('--role <role>', 'Subject role', 'maintainer')
    .option('--scope <scope>', 'Scope list, comma-separated (example: studio:*,task:rerun)')
    .option('--ttl-minutes <minutes>', 'Lease TTL in minutes', '15')
    .option('--reason <reason>', 'Grant reason')
    .option('--actor <actor>', 'Audit actor override')
    .option('--auth-password <password>', 'Authorization password for grant policy')
    .option('--json', 'Print machine-readable JSON output')
    .action((options) => runAuthCommand(runAuthGrantCommand, options, 'auth grant'));

  auth
    .command('status')
    .description('Show current authorization lease and event status from sqlite')
    .option('--lease <lease-id>', 'Inspect one lease id')
    .option('--all', 'Include inactive/revoked leases')
    .option('--limit <n>', 'Lease result limit', '20')
    .option('--events-limit <n>', 'Auth event result limit', '20')
    .option('--json', 'Print machine-readable JSON output')
    .action((options) => runAuthCommand(runAuthStatusCommand, options, 'auth status'));

  auth
    .command('revoke')
    .description('Revoke a write authorization lease')
    .requiredOption('--lease <lease-id>', 'Lease id')
    .option('--reason <reason>', 'Revoke reason')
    .option('--actor <actor>', 'Audit actor override')
    .option('--auth-password <password>', 'Authorization password for revoke policy')
    .option('--json', 'Print machine-readable JSON output')
    .action((options) => runAuthCommand(runAuthRevokeCommand, options, 'auth revoke'));
}

module.exports = {
  runAuthGrantCommand,
  runAuthStatusCommand,
  runAuthRevokeCommand,
  registerAuthCommands
};
