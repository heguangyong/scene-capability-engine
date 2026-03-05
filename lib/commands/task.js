/**
 * Task command group
 *
 * Supports task claiming plus hierarchical task reference operations.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs-extra');
const chalk = require('chalk');
const TaskClaimer = require('../task/task-claimer');
const WorkspaceManager = require('../workspace/workspace-manager');
const { TaskRefRegistry } = require('../task/task-ref-registry');
const { ensureWriteAuthorization } = require('../security/write-authorization');
const {
  buildDraft,
  scoreDraft,
  appendDraft,
  updateDraft,
  consolidateDrafts,
  loadDraftStore,
  promoteDraftToTasks
} = require('../task/task-quality');

function normalizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function toRelativePosix(projectPath, absolutePath) {
  return path.relative(projectPath, absolutePath).replace(/\\/g, '/');
}

function resolveStudioStageFromTaskKey(taskKey) {
  const normalized = normalizeString(taskKey);
  if (!normalized.startsWith('studio:')) {
    return '';
  }
  return normalizeString(normalized.slice('studio:'.length));
}

async function runTaskDraftCommand(options = {}) {
  const projectPath = process.cwd();
  const sceneId = normalizeString(options.scene);
  const specId = normalizeString(options.spec);
  const inputText = normalizeString(options.input);
  const inputFile = normalizeString(options.inputFile);

  if (!sceneId) {
    throw new Error('scene is required');
  }

  let rawRequest = inputText;
  if (!rawRequest && inputFile) {
    rawRequest = await fs.readFile(inputFile, 'utf8');
  }
  if (!rawRequest) {
    throw new Error('input text is required (use --input or --input-file)');
  }

  const draft = buildDraft(rawRequest, {
    scene_id: sceneId,
    spec_id: specId,
    acceptance_criteria: options.acceptance ? String(options.acceptance).split('|') : [],
    confidence: options.confidence
  });
  const quality = scoreDraft(draft);
  draft.quality_score = quality.score;
  draft.quality_breakdown = quality.breakdown;
  draft.quality_issues = quality.issues;
  draft.quality_passed = quality.passed;

  const result = await appendDraft(projectPath, draft, fs);
  const payload = {
    mode: 'task-draft',
    draft: draft,
    store_path: result.store_path
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  console.log(chalk.green('✅ Draft created'));
  console.log(chalk.gray(`  id: ${draft.draft_id}`));
  console.log(chalk.gray(`  score: ${draft.quality_score}`));
}

async function runTaskConsolidateCommand(options = {}) {
  const projectPath = process.cwd();
  const sceneId = normalizeString(options.scene);
  const specId = normalizeString(options.spec);
  if (!sceneId) {
    throw new Error('scene is required');
  }
  const result = await consolidateDrafts(projectPath, {
    scene_id: sceneId,
    spec_id: specId
  }, fs);

  const payload = {
    mode: 'task-consolidate',
    scene_id: sceneId,
    spec_id: specId || null,
    merged: result.merged,
    drafts: result.drafts,
    store_path: result.store_path
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  console.log(chalk.green('✅ Drafts consolidated'));
  console.log(chalk.gray(`  merged: ${result.merged.length}`));
}

async function runTaskScoreCommand(options = {}) {
  const projectPath = process.cwd();
  const draftId = normalizeString(options.draft);
  const all = Boolean(options.all);
  const store = await loadDraftStore(projectPath, fs);
  const drafts = Array.isArray(store.payload.drafts) ? store.payload.drafts : [];

  const targets = all
    ? drafts
    : drafts.filter((draft) => draft.draft_id === draftId);

  if (!all && targets.length === 0) {
    throw new Error(`draft not found: ${draftId}`);
  }

  const scored = [];
  for (const draft of targets) {
    const quality = scoreDraft(draft);
    const updated = await updateDraft(projectPath, draft.draft_id, (current) => ({
      ...current,
      quality_score: quality.score,
      quality_breakdown: quality.breakdown,
      quality_issues: quality.issues,
      quality_passed: quality.passed
    }), fs);
    if (updated) {
      scored.push(updated);
    }
  }

  const payload = {
    mode: 'task-score',
    draft_id: draftId || null,
    total: scored.length,
    drafts: scored
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  console.log(chalk.green('✅ Draft scoring complete'));
  console.log(chalk.gray(`  scored: ${scored.length}`));
}

async function runTaskPromoteCommand(options = {}) {
  const projectPath = process.cwd();
  const draftId = normalizeString(options.draft);
  const specId = normalizeString(options.spec);
  if (!draftId) {
    throw new Error('draft id is required');
  }
  if (!specId) {
    throw new Error('spec is required to promote draft');
  }

  const store = await loadDraftStore(projectPath, fs);
  const drafts = Array.isArray(store.payload.drafts) ? store.payload.drafts : [];
  const draft = drafts.find((item) => item.draft_id === draftId);
  if (!draft) {
    throw new Error(`draft not found: ${draftId}`);
  }
  const quality = scoreDraft(draft);
  if (!quality.passed && !options.force) {
    throw new Error('draft quality gate failed; use --force to override');
  }

  const promoted = await promoteDraftToTasks(projectPath, {
    ...draft,
    spec_id: specId
  }, fs);

  const updated = await updateDraft(projectPath, draftId, (current) => ({
    ...current,
    spec_id: specId,
    status: 'promoted',
    quality_score: quality.score,
    quality_breakdown: quality.breakdown,
    quality_issues: quality.issues,
    quality_passed: quality.passed,
    promoted_at: new Date().toISOString(),
    promoted_task_id: promoted.task_id,
    promoted_tasks_path: promoted.tasks_path
  }), fs);

  const payload = {
    mode: 'task-promote',
    draft_id: draftId,
    spec_id: specId,
    task_id: promoted.task_id,
    tasks_path: toRelativePosix(projectPath, promoted.tasks_path),
    draft: updated
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  console.log(chalk.green('✅ Draft promoted to tasks.md'));
  console.log(chalk.gray(`  task: ${promoted.task_id}`));
}

function isStudioTaskRef(lookup = {}) {
  const source = normalizeString(lookup.source);
  if (source === 'studio-stage') {
    return true;
  }
  return Boolean(resolveStudioStageFromTaskKey(lookup.task_key));
}

async function loadTaskFromSpec(projectPath, specId, taskId, fileSystem = fs) {
  const tasksPath = path.join(projectPath, '.sce', 'specs', specId, 'tasks.md');
  const exists = await fileSystem.pathExists(tasksPath);
  if (!exists) {
    return null;
  }

  const claimer = new TaskClaimer();
  const tasks = await claimer.parseTasks(tasksPath);
  const task = tasks.find((item) => item.taskId === taskId);
  if (!task) {
    return null;
  }

  return {
    task,
    tasksPath
  };
}

async function resetTaskInSpec(projectPath, specId, taskId, fileSystem = fs) {
  const loaded = await loadTaskFromSpec(projectPath, specId, taskId, fileSystem);
  if (!loaded) {
    return {
      success: false,
      error: `Task not found: ${taskId}`
    };
  }

  const { task, tasksPath } = loaded;
  const content = await fileSystem.readFile(tasksPath, 'utf8');
  const lines = content.split(/\r?\n/);
  if (lines[task.lineNumber] !== task.originalLine) {
    return {
      success: false,
      error: 'Task line changed during rerun reset; retry after reload'
    };
  }

  const optionalMarker = task.isOptional ? '*' : '';
  const linePrefix = task.linePrefix || '- ';
  const nextLine = `${linePrefix}[ ]${optionalMarker} ${taskId} ${task.title}`;
  lines[task.lineNumber] = nextLine;
  await fileSystem.writeFile(tasksPath, lines.join('\n'), 'utf8');

  return {
    success: true,
    spec_id: specId,
    task_id: taskId,
    title: task.title,
    previous_status: task.status,
    tasks_path: toRelativePosix(projectPath, tasksPath)
  };
}

async function loadStudioJob(projectPath, jobId, fileSystem = fs) {
  if (!jobId) {
    return null;
  }

  const jobPath = path.join(projectPath, '.sce', 'studio', 'jobs', `${jobId}.json`);
  if (!await fileSystem.pathExists(jobPath)) {
    return null;
  }

  try {
    return await fileSystem.readJson(jobPath);
  } catch (_error) {
    return null;
  }
}

async function readLatestStudioJobId(projectPath, fileSystem = fs) {
  const latestPath = path.join(projectPath, '.sce', 'studio', 'latest-job.json');
  if (!await fileSystem.pathExists(latestPath)) {
    return '';
  }

  try {
    const latest = await fileSystem.readJson(latestPath);
    return normalizeString(latest && latest.job_id);
  } catch (_error) {
    return '';
  }
}

async function findLatestStudioJob(projectPath, sceneId, specId, fileSystem = fs) {
  const latestJobId = await readLatestStudioJobId(projectPath, fileSystem);
  if (latestJobId) {
    const latestJob = await loadStudioJob(projectPath, latestJobId, fileSystem);
    if (latestJob) {
      const latestScene = normalizeString(latestJob?.scene?.id);
      const latestSpec = normalizeString(latestJob?.scene?.spec_id) || normalizeString(latestJob?.source?.spec_id);
      if (latestScene === normalizeString(sceneId) && latestSpec === normalizeString(specId)) {
        return latestJob;
      }
    }
  }

  const jobsDir = path.join(projectPath, '.sce', 'studio', 'jobs');
  if (!await fileSystem.pathExists(jobsDir)) {
    return null;
  }

  const entries = await fileSystem.readdir(jobsDir);
  const jobs = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }

    const absolutePath = path.join(jobsDir, entry);
    try {
      const payload = await fileSystem.readJson(absolutePath);
      const payloadScene = normalizeString(payload?.scene?.id);
      const payloadSpec = normalizeString(payload?.scene?.spec_id) || normalizeString(payload?.source?.spec_id);
      if (payloadScene !== normalizeString(sceneId) || payloadSpec !== normalizeString(specId)) {
        continue;
      }

      const stat = await fileSystem.stat(absolutePath);
      jobs.push({
        payload,
        mtime: stat.mtimeMs
      });
    } catch (_error) {
      // Ignore malformed job files.
    }
  }

  if (jobs.length === 0) {
    return null;
  }

  jobs.sort((a, b) => b.mtime - a.mtime);
  return jobs[0].payload;
}

async function resolveStudioJobForRef(projectPath, lookup, options = {}, fileSystem = fs) {
  const explicitJobId = normalizeString(options.job) || normalizeString(options.jobId);
  if (explicitJobId) {
    const explicitJob = await loadStudioJob(projectPath, explicitJobId, fileSystem);
    if (!explicitJob) {
      throw new Error(`Studio job not found: ${explicitJobId}`);
    }
    return explicitJob;
  }

  const metaJobId = normalizeString(lookup?.metadata?.job_id);
  if (metaJobId) {
    const metaJob = await loadStudioJob(projectPath, metaJobId, fileSystem);
    if (metaJob) {
      return metaJob;
    }
  }

  const fallback = await findLatestStudioJob(projectPath, lookup.scene_id, lookup.spec_id, fileSystem);
  return fallback;
}

function buildStudioRerunArgs(stage, lookup, job, options = {}) {
  const normalizedStage = normalizeString(stage);
  const sceneId = normalizeString(lookup.scene_id);
  const specId = normalizeString(lookup.spec_id);

  if (normalizedStage === 'plan') {
    const fromChat = normalizeString(options.fromChat)
      || normalizeString(job?.source?.from_chat)
      || normalizeString(job?.source?.chat_session)
      || normalizeString(job?.session?.scene_session_id);

    if (!fromChat) {
      return {
        ok: false,
        error: 'studio plan rerun requires from-chat context; provide --from-chat'
      };
    }

    const args = ['studio', 'plan', '--scene', sceneId, '--from-chat', fromChat];
    if (specId) {
      args.push('--spec', specId);
    }
    const goal = normalizeString(options.goal) || normalizeString(job?.source?.goal);
    if (goal) {
      args.push('--goal', goal);
    }
    args.push('--json');
    return { ok: true, args };
  }

  const stageRequiresJob = new Set(['generate', 'apply', 'verify', 'release', 'rollback']);
  if (!stageRequiresJob.has(normalizedStage)) {
    return {
      ok: false,
      error: `Unsupported studio stage for rerun: ${normalizedStage}`
    };
  }

  const jobId = normalizeString(options.job)
    || normalizeString(options.jobId)
    || normalizeString(job?.job_id)
    || normalizeString(lookup?.metadata?.job_id);

  if (!jobId) {
    return {
      ok: false,
      error: 'studio rerun requires a job id; provide --job or run studio plan first'
    };
  }

  const args = ['studio', normalizedStage, '--job', jobId];
  if (normalizedStage === 'verify') {
    const profile = normalizeString(options.profile) || 'standard';
    args.push('--profile', profile);
  }
  if (normalizedStage === 'release') {
    const profile = normalizeString(options.profile) || 'standard';
    const channel = normalizeString(options.channel) || 'dev';
    args.push('--profile', profile, '--channel', channel);
  }
  args.push('--json');
  return { ok: true, args };
}

function stringifySceArgs(args = []) {
  return ['sce', ...args].join(' ').trim();
}

function printTaskRefPayload(payload, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(chalk.blue(`Task reference: ${payload.task_ref}`));
  console.log(`  Scene: ${payload.scene_id}`);
  console.log(`  Spec: ${payload.spec_id}`);
  console.log(`  Task: ${payload.task_key}`);
  console.log(`  Source: ${payload.source}`);
}

function printTaskShowPayload(payload, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(chalk.blue(`Task show: ${payload.task_ref}`));
  console.log(`  Scene: ${payload.target.scene_id}`);
  console.log(`  Spec: ${payload.target.spec_id}`);
  console.log(`  Task key: ${payload.target.task_key}`);
  console.log(`  Source: ${payload.target.source}`);
  if (payload.task) {
    console.log(`  Status: ${payload.task.status}`);
    console.log(`  Title: ${payload.task.title}`);
  }
  if (payload.rerun_command) {
    console.log(`  Rerun: ${payload.rerun_command}`);
  }
}

function printTaskRerunPayload(payload, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(chalk.blue(`Task rerun: ${payload.task_ref}`));
  console.log(`  Type: ${payload.rerun_type}`);
  console.log(`  Dry run: ${payload.dry_run ? 'yes' : 'no'}`);
  if (payload.command) {
    console.log(`  Command: ${payload.command}`);
  }
  if (payload.reset) {
    console.log(`  Reset status: ${payload.reset.previous_status} -> not-started`);
    console.log(`  File: ${payload.reset.tasks_path}`);
  }
  if (payload.exit_code != null) {
    console.log(`  Exit code: ${payload.exit_code}`);
  }
}

async function runTaskRefCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const sceneId = normalizeString(options.scene);
  const specId = normalizeString(options.spec);
  const taskId = normalizeString(options.task || options.taskId);

  if (!sceneId || !specId || !taskId) {
    throw new Error('--scene, --spec, and --task are required');
  }

  const registry = dependencies.taskRefRegistry || new TaskRefRegistry(projectPath, { fileSystem });
  const resolved = await registry.resolveOrCreateRef({
    sceneId,
    specId,
    taskKey: taskId,
    source: 'spec-task',
    metadata: {
      task_id: taskId
    }
  });

  const payload = {
    mode: 'task-ref',
    success: true,
    ...resolved
  };

  printTaskRefPayload(payload, options);
  return payload;
}

async function runTaskShowCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const taskRef = normalizeString(options.ref);
  if (!taskRef) {
    throw new Error('--ref is required');
  }

  const registry = dependencies.taskRefRegistry || new TaskRefRegistry(projectPath, { fileSystem });
  const lookup = await registry.lookupByRef(taskRef);
  if (!lookup) {
    throw new Error(`Task ref not found: ${taskRef}`);
  }

  const payload = {
    mode: 'task-show',
    success: true,
    task_ref: lookup.task_ref,
    target: {
      scene_id: lookup.scene_id,
      spec_id: lookup.spec_id,
      task_key: lookup.task_key,
      source: lookup.source,
      metadata: lookup.metadata || {}
    },
    registry_path: lookup.registry_path,
    task: null,
    rerun_command: null
  };

  if (isStudioTaskRef(lookup)) {
    const stage = resolveStudioStageFromTaskKey(lookup.task_key);
    const job = await resolveStudioJobForRef(projectPath, lookup, options, fileSystem);
    const rerunPlan = buildStudioRerunArgs(stage, lookup, job, options);
    payload.task = {
      kind: 'studio-stage',
      stage,
      job_id: normalizeString(job?.job_id) || normalizeString(lookup?.metadata?.job_id) || null
    };
    if (rerunPlan.ok) {
      payload.rerun_command = stringifySceArgs(rerunPlan.args);
    }
  } else {
    const loaded = await loadTaskFromSpec(projectPath, lookup.spec_id, lookup.task_key, fileSystem);
    if (loaded) {
      payload.task = {
        kind: 'spec-task',
        task_id: loaded.task.taskId,
        title: loaded.task.title,
        status: loaded.task.status,
        claimed_by: loaded.task.claimedBy || null,
        claimed_at: loaded.task.claimedAt || null,
        is_optional: loaded.task.isOptional === true,
        tasks_path: toRelativePosix(projectPath, loaded.tasksPath)
      };
    } else {
      payload.task = {
        kind: 'spec-task',
        task_id: lookup.task_key,
        status: 'unknown'
      };
    }
    payload.rerun_command = `sce task rerun --ref ${lookup.task_ref}`;
  }

  printTaskShowPayload(payload, options);
  return payload;
}

async function runTaskRerunCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const taskRef = normalizeString(options.ref);
  if (!taskRef) {
    throw new Error('--ref is required');
  }

  const dryRun = options.dryRun === true;
  const registry = dependencies.taskRefRegistry || new TaskRefRegistry(projectPath, { fileSystem });
  const lookup = await registry.lookupByRef(taskRef);
  if (!lookup) {
    throw new Error(`Task ref not found: ${taskRef}`);
  }
  const writeAuthResult = dryRun
    ? {
      required: false,
      passed: true
    }
    : await ensureWriteAuthorization('task:rerun', options, {
      projectPath,
      fileSystem,
      env: dependencies.env,
      authSecret: dependencies.authSecret
    });

  if (isStudioTaskRef(lookup)) {
    const stage = resolveStudioStageFromTaskKey(lookup.task_key);
    const job = await resolveStudioJobForRef(projectPath, lookup, options, fileSystem);
    const rerunPlan = buildStudioRerunArgs(stage, lookup, job, options);
    if (!rerunPlan.ok) {
      throw new Error(rerunPlan.error || 'Failed to build studio rerun command');
    }

    const payload = {
      mode: 'task-rerun',
      success: true,
      task_ref: lookup.task_ref,
      rerun_type: 'studio-stage',
      stage,
      job_id: normalizeString(job?.job_id) || null,
      dry_run: dryRun,
      command: stringifySceArgs(rerunPlan.args),
      authorization: {
        required: writeAuthResult.required === true,
        lease_id: writeAuthResult.lease_id || null,
        lease_expires_at: writeAuthResult.lease_expires_at || null
      }
    };

    if (!dryRun) {
      const cliEntry = path.resolve(__dirname, '..', '..', 'bin', 'sce.js');
      const execution = spawnSync(process.execPath, [cliEntry, ...rerunPlan.args], {
        cwd: projectPath,
        env: process.env,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 20
      });

      payload.exit_code = Number.isInteger(execution.status) ? execution.status : 1;
      payload.stdout = `${execution.stdout || ''}`;
      payload.stderr = `${execution.stderr || ''}`;
      payload.success = payload.exit_code === 0;

      if (!payload.success) {
        throw new Error(`studio rerun command failed (exit=${payload.exit_code})`);
      }
    }

    printTaskRerunPayload(payload, options);
    return payload;
  }

  const payload = {
    mode: 'task-rerun',
    success: true,
    task_ref: lookup.task_ref,
    rerun_type: 'spec-task',
    dry_run: dryRun,
    command: `sce task claim ${lookup.spec_id} ${lookup.task_key}`,
    authorization: {
      required: writeAuthResult.required === true,
      lease_id: writeAuthResult.lease_id || null,
      lease_expires_at: writeAuthResult.lease_expires_at || null
    }
  };

  if (!dryRun) {
    const reset = await resetTaskInSpec(projectPath, lookup.spec_id, lookup.task_key, fileSystem);
    if (!reset.success) {
      throw new Error(reset.error || 'Failed to reset task status for rerun');
    }
    payload.reset = reset;
  }

  printTaskRerunPayload(payload, options);
  return payload;
}

/**
 * Claim a task.
 */
async function claimTask(specName, taskId, options = {}) {
  const projectPath = process.cwd();
  const taskClaimer = new TaskClaimer();
  const workspaceManager = new WorkspaceManager();

  console.log(chalk.blue('Task claim'));
  console.log();

  try {
    const username = options.user || await workspaceManager.detectUsername();

    if (!username) {
      console.log(chalk.red('Could not detect username'));
      console.log();
      console.log('Please configure git or use --user flag');
      return;
    }

    console.log(`Spec: ${chalk.cyan(specName)}`);
    console.log(`Task: ${chalk.cyan(taskId)}`);
    console.log(`User: ${chalk.cyan(username)}`);
    console.log();

    const result = await taskClaimer.claimTask(
      projectPath,
      specName,
      taskId,
      username,
      options.force
    );

    if (result.success) {
      console.log(chalk.green('Task claimed successfully'));
      console.log();
      console.log(`Task: ${result.taskTitle || taskId}`);
      console.log(`Claimed by: ${chalk.cyan(username)}`);
      console.log(`Claimed at: ${chalk.gray(result.claimedAt)}`);

      if (result.previousClaim) {
        console.log();
        console.log(chalk.yellow('Previous claim overridden:'));
        console.log(`  User: ${result.previousClaim.username}`);
        console.log(`  Time: ${result.previousClaim.timestamp || result.previousClaim.claimedAt}`);
      }
    } else {
      console.log(chalk.red('Failed to claim task'));
      console.log();
      console.log(`Error: ${result.error}`);

      const currentClaim = result.currentClaim || result.existingClaim;
      if (currentClaim) {
        console.log();
        console.log('Task is already claimed by:');
        console.log(`  User: ${chalk.cyan(currentClaim.username)}`);
        console.log(`  Time: ${chalk.gray(currentClaim.claimedAt || currentClaim.timestamp || 'n/a')}`);
        console.log();
        console.log('Use ' + chalk.cyan('--force') + ' to override the claim');
      }
    }
  } catch (error) {
    console.log(chalk.red('Error:'), error.message);
  }
}

/**
 * Unclaim a task.
 */
async function unclaimTask(specName, taskId, options = {}) {
  const projectPath = process.cwd();
  const taskClaimer = new TaskClaimer();
  const workspaceManager = new WorkspaceManager();

  console.log(chalk.blue('Task unclaim'));
  console.log();

  try {
    const username = options.user || await workspaceManager.detectUsername();

    if (!username) {
      console.log(chalk.red('Could not detect username'));
      return;
    }

    console.log(`Spec: ${chalk.cyan(specName)}`);
    console.log(`Task: ${chalk.cyan(taskId)}`);
    console.log(`User: ${chalk.cyan(username)}`);
    console.log();

    const result = await taskClaimer.unclaimTask(
      projectPath,
      specName,
      taskId,
      username
    );

    if (result.success) {
      console.log(chalk.green('Task unclaimed successfully'));
      console.log();
      console.log(`Task: ${result.taskTitle || taskId}`);
    } else {
      console.log(chalk.red('Failed to unclaim task'));
      console.log();
      console.log(`Error: ${result.error}`);
    }
  } catch (error) {
    console.log(chalk.red('Error:'), error.message);
  }
}

/**
 * List claimed tasks.
 */
async function listClaimedTasks(specName, options = {}) {
  const projectPath = process.cwd();
  const taskClaimer = new TaskClaimer();

  console.log(chalk.blue('Claimed tasks'));
  console.log();

  try {
    if (specName) {
      const tasks = await taskClaimer.getClaimedTasks(projectPath, specName);

      if (tasks.length === 0) {
        console.log(chalk.gray('No claimed tasks found'));
        return;
      }

      console.log(`Spec: ${chalk.cyan(specName)}`);
      console.log();

      const byUser = {};
      for (const task of tasks) {
        if (!byUser[task.claimedBy]) {
          byUser[task.claimedBy] = [];
        }
        byUser[task.claimedBy].push(task);
      }

      for (const [user, userTasks] of Object.entries(byUser)) {
        if (options.user && user !== options.user) {
          continue;
        }

        console.log(chalk.cyan(`${user} (${userTasks.length} task(s))`));
        for (const task of userTasks) {
          const staleMarker = task.isStale ? chalk.yellow(' [STALE]') : '';
          console.log(`  ${chalk.gray('•')} ${task.taskId} ${task.taskTitle}${staleMarker}`);
          console.log(`    ${chalk.gray(task.claimedAt)}`);
        }
        console.log();
      }
    } else {
      console.log(chalk.gray('Please specify a spec name'));
      console.log();
      console.log('Usage: ' + chalk.cyan('sce task list <spec-name>'));
    }
  } catch (error) {
    console.log(chalk.red('Error:'), error.message);
  }
}

function registerTaskCommands(program) {
  const task = program
    .command('task')
    .description('Manage task claims, references, and reruns');

  task
    .command('claim <spec-name> <task-id>')
    .description('Claim a task for current user')
    .option('--user <username>', 'Override current username')
    .option('--force', 'Force claim when already claimed')
    .action(async (specName, taskId, options) => {
      await claimTask(specName, taskId, options);
    });

  task
    .command('unclaim <spec-name> <task-id>')
    .description('Release a claimed task')
    .option('--user <username>', 'Override current username')
    .action(async (specName, taskId, options) => {
      await unclaimTask(specName, taskId, options);
    });

  task
    .command('list <spec-name>')
    .alias('status')
    .description('List claimed tasks for a spec')
    .option('--user <username>', 'Filter by username')
    .action(async (specName, options) => {
      await listClaimedTasks(specName, options);
    });

  task
    .command('ref')
    .description('Resolve or create hierarchical task reference (SS.PP.TT)')
    .requiredOption('--scene <scene-id>', 'Scene identifier')
    .requiredOption('--spec <spec-id>', 'Spec identifier')
    .requiredOption('--task <task-id>', 'Task identifier')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => {
      try {
        await runTaskRefCommand(options);
      } catch (error) {
        console.error(chalk.red(`Task ref failed: ${error.message}`));
        process.exitCode = 1;
      }
    });

  task
    .command('show')
    .description('Show task target by hierarchical task reference')
    .requiredOption('--ref <task-ref>', 'Task reference (SS.PP.TT)')
    .option('--from-chat <session>', 'Override session for studio plan rerun hints')
    .option('--job <job-id>', 'Override studio job id for rerun hints')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => {
      try {
        await runTaskShowCommand(options);
      } catch (error) {
        console.error(chalk.red(`Task show failed: ${error.message}`));
        process.exitCode = 1;
      }
    });

  task
    .command('rerun')
    .description('Rerun task by hierarchical reference')
    .requiredOption('--ref <task-ref>', 'Task reference (SS.PP.TT)')
    .option('--dry-run', 'Preview rerun command without executing')
    .option('--auth-lease <lease-id>', 'Write authorization lease id (sce auth grant)')
    .option('--from-chat <session>', 'Override session for studio plan rerun')
    .option('--job <job-id>', 'Override studio job id')
    .option('--profile <profile>', 'Override profile for studio verify/release rerun')
    .option('--channel <channel>', 'Override channel for studio release rerun')
    .option('--goal <goal>', 'Override goal for studio plan rerun')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => {
      try {
        await runTaskRerunCommand(options);
      } catch (error) {
        console.error(chalk.red(`Task rerun failed: ${error.message}`));
        process.exitCode = 1;
      }
    });

  task
    .command('draft')
    .description('Create a task draft from dialogue input')
    .requiredOption('--scene <scene-id>', 'Scene identifier')
    .option('--spec <spec-id>', 'Spec identifier')
    .option('--input <text>', 'Raw task input text')
    .option('--input-file <path>', 'File containing raw task input')
    .option('--acceptance <items>', 'Pipe-delimited acceptance criteria')
    .option('--confidence <score>', 'Manual confidence (0-1)')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => {
      try {
        await runTaskDraftCommand(options);
      } catch (error) {
        console.error(chalk.red(`Task draft failed: ${error.message}`));
        process.exitCode = 1;
      }
    });

  task
    .command('consolidate')
    .description('Consolidate task drafts by scene/spec')
    .requiredOption('--scene <scene-id>', 'Scene identifier')
    .option('--spec <spec-id>', 'Spec identifier')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => {
      try {
        await runTaskConsolidateCommand(options);
      } catch (error) {
        console.error(chalk.red(`Task consolidate failed: ${error.message}`));
        process.exitCode = 1;
      }
    });

  task
    .command('score')
    .description('Score task draft quality')
    .option('--draft <draft-id>', 'Draft identifier')
    .option('--all', 'Score all drafts')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => {
      try {
        await runTaskScoreCommand(options);
      } catch (error) {
        console.error(chalk.red(`Task score failed: ${error.message}`));
        process.exitCode = 1;
      }
    });

  task
    .command('promote')
    .description('Promote a task draft into spec tasks.md')
    .requiredOption('--draft <draft-id>', 'Draft identifier')
    .requiredOption('--spec <spec-id>', 'Spec identifier')
    .option('--force', 'Override quality gate')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => {
      try {
        await runTaskPromoteCommand(options);
      } catch (error) {
        console.error(chalk.red(`Task promote failed: ${error.message}`));
        process.exitCode = 1;
      }
    });
}

module.exports = {
  claimTask,
  unclaimTask,
  listClaimedTasks,
  runTaskRefCommand,
  runTaskShowCommand,
  runTaskRerunCommand,
  runTaskDraftCommand,
  runTaskConsolidateCommand,
  runTaskScoreCommand,
  runTaskPromoteCommand,
  registerTaskCommands
};
