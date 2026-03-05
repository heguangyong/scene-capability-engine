const path = require('path');
const chalk = require('chalk');
const fs = require('fs-extra');
const {
  COMPONENT_DEFINITIONS,
  buildStateMigrationPlan,
  runStateMigration,
  runStateDoctor,
  runStateExport
} = require('../state/state-migration-manager');
const { getSceStateStore } = require('../state/sce-state-store');

function normalizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function collectOptionValue(value, previous = []) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return previous;
  }
  return [...previous, normalized];
}

function normalizeComponentInput(value = []) {
  if (!Array.isArray(value)) {
    return [];
  }
  const items = [];
  for (const entry of value) {
    const normalized = normalizeString(entry);
    if (!normalized) {
      continue;
    }
    for (const token of normalized.split(/[,\s]+/g)) {
      const cleaned = normalizeString(token);
      if (cleaned) {
        items.push(cleaned);
      }
    }
  }
  return Array.from(new Set(items));
}

function printPayload(payload, options = {}, title = 'State') {
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(chalk.blue(title));
  if (payload.mode) {
    console.log(`  Mode: ${payload.mode}`);
  }
  if (payload.store_path) {
    console.log(`  Store: ${payload.store_path}`);
  }
  if (payload.sqlite) {
    console.log(`  SQLite: configured=${payload.sqlite.configured ? 'yes' : 'no'} available=${payload.sqlite.available ? 'yes' : 'no'}`);
  }
  if (payload.summary && typeof payload.summary === 'object') {
    for (const [key, value] of Object.entries(payload.summary)) {
      console.log(`  ${key}: ${value}`);
    }
  }
  if (Array.isArray(payload.components)) {
    for (const item of payload.components) {
      console.log(`  - ${item.id} | source=${item.source_record_count} | status=${item.status}`);
    }
  }
  if (Array.isArray(payload.operations)) {
    for (const item of payload.operations) {
      console.log(`  - ${item.component_id} | ${item.status} | source=${item.source_record_count}`);
    }
  }
  if (payload.out_file) {
    console.log(`  Export: ${payload.out_file}`);
  }
}

async function runStatePlanCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;
  const components = normalizeComponentInput(options.component);

  const payload = await buildStateMigrationPlan({
    componentIds: components
  }, {
    projectPath,
    fileSystem,
    env
  });
  printPayload(payload, options, 'State Plan');
  return payload;
}

async function runStateDoctorCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;

  const payload = await runStateDoctor({}, {
    projectPath,
    fileSystem,
    env
  });
  printPayload(payload, options, 'State Doctor');
  return payload;
}

async function runStateMigrateCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;
  const components = normalizeComponentInput(options.component);
  const componentIds = options.all === true ? [] : components;

  const payload = await runStateMigration({
    apply: options.apply === true,
    all: options.all === true,
    componentIds
  }, {
    projectPath,
    fileSystem,
    env
  });
  printPayload(payload, options, 'State Migrate');
  return payload;
}

async function runStateExportCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;

  const payload = await runStateExport({
    out: normalizeString(options.out)
  }, {
    projectPath,
    fileSystem,
    env
  });
  printPayload(payload, options, 'State Export');
  return payload;
}

async function runStateReconcileCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;
  const components = normalizeComponentInput(options.component);
  const componentIds = options.all === true ? [] : components;
  const apply = options.apply === true;
  const stateStore = dependencies.stateStore || getSceStateStore(projectPath, {
    fileSystem,
    env
  });

  const before = await runStateDoctor({}, {
    projectPath,
    fileSystem,
    env,
    stateStore
  });

  const migration = await runStateMigration({
    apply,
    all: options.all === true,
    componentIds
  }, {
    projectPath,
    fileSystem,
    env,
    stateStore
  });

  const after = await runStateDoctor({}, {
    projectPath,
    fileSystem,
    env,
    stateStore
  });

  const beforePending = Number(before && before.summary && before.summary.pending_components) || 0;
  const afterPending = Number(after && after.summary && after.summary.pending_components) || 0;
  const beforeBlocking = Number(before && before.summary && before.summary.blocking_count) || 0;
  const afterBlocking = Number(after && after.summary && after.summary.blocking_count) || 0;
  const pendingReduced = Math.max(0, beforePending - afterPending);
  const blockingReduced = Math.max(0, beforeBlocking - afterBlocking);

  const payload = {
    mode: 'state-reconcile',
    success: Boolean(migration && migration.success) && afterBlocking === 0,
    apply,
    generated_at: new Date().toISOString(),
    store_path: after && after.store_path ? after.store_path : null,
    sqlite: after && after.sqlite ? after.sqlite : null,
    migration,
    before: {
      summary: before && before.summary ? before.summary : null,
      blocking: Array.isArray(before && before.blocking) ? before.blocking : [],
      alerts: Array.isArray(before && before.alerts) ? before.alerts : []
    },
    after: {
      summary: after && after.summary ? after.summary : null,
      blocking: Array.isArray(after && after.blocking) ? after.blocking : [],
      alerts: Array.isArray(after && after.alerts) ? after.alerts : []
    },
    summary: {
      apply,
      migrated_components: Number(migration && migration.summary && migration.summary.migrated_components) || 0,
      migrated_records: Number(migration && migration.summary && migration.summary.migrated_records) || 0,
      before_pending_components: beforePending,
      after_pending_components: afterPending,
      pending_components_reduced: pendingReduced,
      before_blocking_count: beforeBlocking,
      after_blocking_count: afterBlocking,
      blocking_reduced: blockingReduced
    }
  };

  printPayload(payload, options, 'State Reconcile');
  return payload;
}

async function safeRun(handler, options = {}, dependencies = {}, title = 'state command') {
  try {
    await handler(options, dependencies);
  } catch (error) {
    if (options && options.json) {
      console.log(JSON.stringify({
        success: false,
        mode: title.replace(/\s+/g, '-'),
        error: error.message
      }, null, 2));
    } else {
      console.error(chalk.red(`${title} failed:`), error.message);
    }
    process.exitCode = 1;
  }
}

function registerStateCommands(program) {
  const state = program
    .command('state')
    .description('Manage gradual migration from file registries to sqlite indexes');

  const knownIds = COMPONENT_DEFINITIONS.map((item) => item.id).join(', ');

  state
    .command('plan')
    .description('Inspect migratable file-based registries and produce migration plan')
    .option('--component <id>', `Component id (repeatable): ${knownIds}`, collectOptionValue, [])
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => safeRun(runStatePlanCommand, options, {}, 'state plan'));

  state
    .command('doctor')
    .description('Check sqlite readiness and file/sqlite index consistency')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => safeRun(runStateDoctorCommand, options, {}, 'state doctor'));

  state
    .command('migrate')
    .description('Migrate selected components to sqlite indexes (dry-run by default)')
    .option('--component <id>', `Component id (repeatable): ${knownIds}`, collectOptionValue, [])
    .option('--all', 'Migrate all known components')
    .option('--apply', 'Apply migration writes (default is dry-run)')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => safeRun(runStateMigrateCommand, options, {}, 'state migrate'));

  state
    .command('export')
    .description('Export sqlite state migration tables as JSON snapshot')
    .option('--out <path>', 'Output file path', '.sce/reports/state-migration/state-export.latest.json')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => safeRun(runStateExportCommand, options, {}, 'state export'));

  state
    .command('reconcile')
    .description('Run doctor + migrate + doctor in one flow (dry-run by default)')
    .option('--component <id>', `Component id (repeatable): ${knownIds}`, collectOptionValue, [])
    .option('--all', 'Reconcile all known components')
    .option('--apply', 'Apply migration writes (default is dry-run)')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => safeRun(runStateReconcileCommand, options, {}, 'state reconcile'));
}

module.exports = {
  runStatePlanCommand,
  runStateDoctorCommand,
  runStateMigrateCommand,
  runStateExportCommand,
  runStateReconcileCommand,
  registerStateCommands
};
