/**
 * Capability Iteration Commands
 *
 * Extracts capability candidates from scene/spec/task history,
 * scores candidates, maps them to ontology scope, and exports
 * registry-ready capability template packages.
 */

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const TaskClaimer = require('../task/task-claimer');
const { runStudioSpecGovernance } = require('../studio/spec-intake-governor');
const { DOMAIN_CHAIN_RELATIVE_PATH } = require('../spec/domain-modeling');
const { SceStateStore } = require('../state/sce-state-store');
const TemplateManager = require('../templates/template-manager');
const { TemplateError } = require('../templates/template-error');
const packageJson = require('../../package.json');

const DEFAULT_ITERATION_DIR = '.sce/reports/capability-iteration';
const DEFAULT_EXPORT_ROOT = '.sce/templates/exports';

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => normalizeText(item)).filter(Boolean);
}

function normalizeTokenList(value) {
  if (Array.isArray(value)) {
    return normalizeStringArray(value).map((item) => item.toLowerCase());
  }
  const text = normalizeText(value);
  if (!text) {
    return [];
  }
  return text
    .split(/[^a-zA-Z0-9._-]+/g)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
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

function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(`${value}`, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function buildDefaultCandidatePath(sceneId) {
  const safeScene = normalizeText(sceneId).replace(/[^\w.-]+/g, '_') || 'scene';
  return path.join(DEFAULT_ITERATION_DIR, `${safeScene}.candidate.json`);
}

function buildDefaultScorePath(sceneId) {
  const safeScene = normalizeText(sceneId).replace(/[^\w.-]+/g, '_') || 'scene';
  return path.join(DEFAULT_ITERATION_DIR, `${safeScene}.score.json`);
}

function buildDefaultTemplatePath(sceneId) {
  const safeScene = normalizeText(sceneId).replace(/[^\w.-]+/g, '_') || 'scene';
  return path.join(DEFAULT_ITERATION_DIR, `${safeScene}.template.json`);
}

function buildDefaultUsePlanPath(specId, templateId) {
  const safeSpec = normalizeText(specId).replace(/[^\w.-]+/g, '_') || 'spec';
  const safeTemplate = normalizeText(templateId).replace(/[^\w.-]+/g, '_') || 'template';
  return path.join(DEFAULT_ITERATION_DIR, 'usage', `${safeSpec}.${safeTemplate}.plan.json`);
}

function buildDefaultExportDir(templateId) {
  const safeId = normalizeText(templateId).replace(/[^\w.-]+/g, '_') || 'capability';
  return path.join(DEFAULT_EXPORT_ROOT, `capability-${safeId}`);
}

function buildSceneIdFromCandidate(candidate) {
  return normalizeText(candidate && candidate.scene_id) || 'scene.unknown';
}

function parseTemplatePath(templatePath) {
  const normalized = normalizeText(templatePath);
  if (!normalized) {
    return { sourceName: 'official', templateId: '' };
  }
  if (normalized.includes(':')) {
    const [sourceName, templateId] = normalized.split(':', 2);
    return { sourceName: normalizeText(sourceName) || 'official', templateId: normalizeText(templateId) };
  }
  return { sourceName: 'official', templateId: normalized };
}

function buildOntologyScopeFromChain(domainChain) {
  const ontology = domainChain && domainChain.ontology ? domainChain.ontology : {};
  return {
    domains: normalizeStringArray(domainChain && domainChain.scene_id ? [domainChain.scene_id] : []),
    entities: normalizeStringArray(ontology.entity),
    relations: normalizeStringArray(ontology.relation),
    business_rules: normalizeStringArray(ontology.business_rule),
    decisions: normalizeStringArray(ontology.decision_policy)
  };
}

function buildOntologyOverlap(specScope, templateScope) {
  const fields = ['domains', 'entities', 'relations', 'business_rules', 'decisions'];
  const details = {};
  let weightedTotal = 0;
  let weightedMatched = 0;
  let bucketCount = 0;

  fields.forEach((field) => {
    const expected = normalizeTokenList(specScope && specScope[field]);
    const provided = normalizeTokenList(templateScope && templateScope[field]);
    const providedSet = new Set(provided);
    const matched = expected.filter((item) => providedSet.has(item));
    const expectedCount = expected.length;
    const matchedCount = matched.length;
    const coverage = expectedCount > 0 ? matchedCount / expectedCount : 0;
    if (expectedCount > 0) {
      weightedTotal += 1;
      weightedMatched += coverage;
      bucketCount += 1;
    }
    details[field] = {
      expected,
      provided,
      matched,
      expected_count: expectedCount,
      matched_count: matchedCount,
      coverage_ratio: Number(coverage.toFixed(3))
    };
  });

  const score = bucketCount > 0 ? weightedMatched / weightedTotal : 0;
  return {
    score,
    details
  };
}

function buildKeywordScore(template, queryTokens) {
  if (!queryTokens || queryTokens.length === 0) {
    return 0;
  }
  const haystack = [
    template.id,
    template.name,
    template.description,
    ...(template.tags || []),
    ...(template.applicable_scenarios || [])
  ].map((item) => `${item || ''}`.toLowerCase());
  const hits = queryTokens.filter((token) => haystack.some((value) => value.includes(token))).length;
  return hits / queryTokens.length;
}

function collectExistingTaskRegistry(tasksContent) {
  const taskPattern = /^-\s*\[[ x~-]\]\*?\s+(\d+(?:\.\d+)*)\s+(.+)$/;
  const lines = String(tasksContent || '').split('\n');
  const existingTitles = new Set();
  let maxTaskId = 0;

  for (const line of lines) {
    const match = line.match(taskPattern);
    if (!match) {
      continue;
    }

    const rawId = match[1];
    const rawTitle = match[2];
    const taskId = Number.parseInt(String(rawId).split('.')[0], 10);

    if (Number.isFinite(taskId)) {
      maxTaskId = Math.max(maxTaskId, taskId);
    }

    const normalizedTitle = String(rawTitle || '')
      .replace(/\s+\[[^\]]+\]$/, '')
      .trim()
      .toLowerCase();

    if (normalizedTitle) {
      existingTitles.add(normalizedTitle);
    }
  }

  return {
    maxTaskId,
    existingTitles
  };
}

function createCapabilityTaskLine(taskId, title, metadata = {}) {
  const suffixParts = [];
  if (metadata.templateId) {
    suffixParts.push(`capability_ref=${metadata.templateId}`);
  }
  if (metadata.templateSource) {
    suffixParts.push(`template_source=${metadata.templateSource}`);
  }
  const suffix = suffixParts.length > 0 ? ` [${suffixParts.join(' ')}]` : '';
  return `- [ ] ${taskId} ${title}${suffix}`;
}

async function appendCapabilityPlanToSpecTasks(options, plan, fileSystem = fs) {
  const projectPath = options.projectPath || process.cwd();
  const specId = normalizeText(options.spec || options.specId);
  if (!specId) {
    throw new Error('spec is required to apply capability plan');
  }
  const tasksPath = path.join(projectPath, '.sce', 'specs', specId, 'tasks.md');
  const tasksExists = await fileSystem.pathExists(tasksPath);
  if (!tasksExists) {
    throw new Error(`target spec tasks.md not found: ${tasksPath}`);
  }
  const currentContent = await fileSystem.readFile(tasksPath, 'utf8');
  const registry = collectExistingTaskRegistry(currentContent);
  const recommended = Array.isArray(plan.recommended_tasks) ? plan.recommended_tasks : [];
  const sectionTitle = normalizeText(options.sectionTitle)
    || `## Capability Template Tasks (${plan.template.id} - ${new Date().toISOString()})`;

  const lines = [];
  const addedTasks = [];
  const skippedTitles = [];
  let nextTaskId = registry.maxTaskId + 1;
  let duplicateCount = 0;

  for (const entry of recommended) {
    const title = normalizeText(entry && entry.title);
    if (!title) {
      continue;
    }
    const titleKey = title.toLowerCase();
    if (registry.existingTitles.has(titleKey)) {
      duplicateCount += 1;
      skippedTitles.push(title);
      continue;
    }
    registry.existingTitles.add(titleKey);

    lines.push(createCapabilityTaskLine(nextTaskId, title, {
      templateId: plan.template.id,
      templateSource: plan.template.source
    }));

    addedTasks.push({
      task_id: nextTaskId,
      title
    });

    nextTaskId += 1;
  }

  if (addedTasks.length === 0) {
    return {
      tasks_path: tasksPath,
      section_title: sectionTitle,
      added_count: 0,
      skipped_duplicates: duplicateCount,
      skipped_titles: skippedTitles,
      preview_lines: [],
      skipped_reason: recommended.length === 0
        ? 'no recommended tasks'
        : 'all recommended tasks already exist in tasks.md',
      added_tasks: []
    };
  }

  const prefix = currentContent.trimEnd();
  const chunks = [
    prefix,
    '',
    sectionTitle,
    '',
    ...lines,
    ''
  ];

  const nextContent = chunks.join('\n');
  await fileSystem.writeFile(tasksPath, nextContent, 'utf8');

  return {
    tasks_path: tasksPath,
    section_title: sectionTitle,
    added_count: addedTasks.length,
    skipped_duplicates: duplicateCount,
    skipped_titles: skippedTitles,
    preview_lines: lines,
    first_task_id: addedTasks[0].task_id,
    last_task_id: addedTasks[addedTasks.length - 1].task_id,
    added_tasks: addedTasks
  };
}

async function loadSpecDomainChain(projectPath, specId, fileSystem) {
  const specPath = path.join(projectPath, '.sce', 'specs', specId);
  const domainChainPath = path.join(specPath, DOMAIN_CHAIN_RELATIVE_PATH);
  if (!await fileSystem.pathExists(domainChainPath)) {
    return { exists: false, path: domainChainPath, payload: null };
  }
  try {
    const payload = await fileSystem.readJson(domainChainPath);
    return { exists: true, path: domainChainPath, payload };
  } catch (error) {
    return { exists: true, path: domainChainPath, payload: null, error: error.message };
  }
}

function createEmptyOntologyScope() {
  return {
    domains: [],
    entities: [],
    relations: [],
    business_rules: [],
    decisions: []
  };
}

function normalizeOntologyScope(scope) {
  const candidate = scope && typeof scope === 'object' ? scope : {};
  return {
    domains: normalizeStringArray(candidate.domains),
    entities: normalizeStringArray(candidate.entities),
    relations: normalizeStringArray(candidate.relations),
    business_rules: normalizeStringArray(candidate.business_rules),
    decisions: normalizeStringArray(candidate.decisions)
  };
}

function mergeOntologyScopes(scopes) {
  const merged = createEmptyOntologyScope();
  for (const scope of Array.isArray(scopes) ? scopes : []) {
    const normalized = normalizeOntologyScope(scope);
    for (const field of Object.keys(merged)) {
      const combined = new Set([...(merged[field] || []), ...(normalized[field] || [])]);
      merged[field] = Array.from(combined);
    }
  }
  return merged;
}

function buildCoreOntologySummary(scope) {
  const normalized = normalizeOntologyScope(scope);
  const triads = {
    entity_relation: {
      required_fields: ['entities', 'relations'],
      entity_count: normalized.entities.length,
      relation_count: normalized.relations.length,
      passed: normalized.entities.length > 0 && normalized.relations.length > 0
    },
    business_rules: {
      required_fields: ['business_rules'],
      count: normalized.business_rules.length,
      passed: normalized.business_rules.length > 0
    },
    decision_strategy: {
      required_fields: ['decisions'],
      count: normalized.decisions.length,
      passed: normalized.decisions.length > 0
    }
  };
  const passedCount = Object.values(triads).filter((item) => item.passed).length;
  return {
    ontology_scope: normalized,
    triads,
    passed_count: passedCount,
    total_count: 3,
    coverage_ratio: Number((passedCount / 3).toFixed(3)),
    ready: passedCount === 3,
    missing: Object.entries(triads)
      .filter(([, value]) => !value.passed)
      .map(([key]) => key)
  };
}

function assertCoreOntologySummary(summary, contextLabel = 'capability template') {
  const details = summary || buildCoreOntologySummary(createEmptyOntologyScope());
  if (details.ready) {
    return details;
  }
  throw new Error(
    `${contextLabel} missing required ontology triads: ${details.missing.join(', ')}`
  );
}

function buildOntologyCoreUiState(summary) {
  const details = summary || buildCoreOntologySummary(createEmptyOntologyScope());
  const labels = {
    entity_relation: 'entity_relation',
    business_rules: 'business_rules',
    decision_strategy: 'decision_strategy'
  };
  return {
    ready: details.ready === true,
    coverage_ratio: Number(details.coverage_ratio || 0),
    coverage_percent: Math.round(Number(details.coverage_ratio || 0) * 100),
    missing: Array.isArray(details.missing) ? details.missing : [],
    missing_labels: (Array.isArray(details.missing) ? details.missing : []).map((key) => labels[key] || key),
    triads: {
      entity_relation: Boolean(details.triads && details.triads.entity_relation && details.triads.entity_relation.passed),
      business_rules: Boolean(details.triads && details.triads.business_rules && details.triads.business_rules.passed),
      decision_strategy: Boolean(details.triads && details.triads.decision_strategy && details.triads.decision_strategy.passed)
    }
  };
}

function enrichCapabilityTemplateForUi(template) {
  const ontologyCore = template && template.ontology_core
    ? template.ontology_core
    : buildCoreOntologySummary(template && template.ontology_scope ? template.ontology_scope : createEmptyOntologyScope());
  const releaseReadiness = template && template.release_readiness
    ? template.release_readiness
    : {
        ready: ontologyCore.ready === true,
        blockers: ontologyCore.ready === true
          ? []
          : [{
              id: 'ontology-core-triads',
              severity: 'blocking',
              reason: 'missing required ontology triads',
              missing: Array.isArray(ontologyCore.missing) ? ontologyCore.missing : []
            }],
        ontology_core: ontologyCore,
        ontology_core_ui: buildOntologyCoreUiState(ontologyCore)
      };
  return {
    ...template,
    ontology_core: ontologyCore,
    ontology_core_ui: buildOntologyCoreUiState(ontologyCore),
    release_readiness: releaseReadiness,
    release_readiness_ui: buildCapabilityReleaseReadinessUi(releaseReadiness)
  };
}

function buildCapabilityReleaseReadiness(templateCandidate) {
  const enriched = enrichCapabilityTemplateForUi(templateCandidate || {});
  const blockers = [];
  if (!enriched.ontology_core.ready) {
    blockers.push({
      id: 'ontology-core-triads',
      severity: 'blocking',
      reason: 'missing required ontology triads',
      missing: enriched.ontology_core.missing,
      missing_labels: enriched.ontology_core_ui.missing_labels,
      remediation: [
        '补齐实体关系（entities + relations）',
        '补齐业务规则（business_rules）',
        '补齐决策策略（decisions）'
      ]
    });
  }
  return {
    ready: blockers.length === 0,
    blockers,
    ontology_core: enriched.ontology_core,
    ontology_core_ui: enriched.ontology_core_ui
  };
}

function buildCapabilityReleaseReadinessUi(readiness) {
  const details = readiness && typeof readiness === 'object'
    ? readiness
    : { ready: true, blockers: [] };
  const blockers = Array.isArray(details.blockers) ? details.blockers : [];
  return {
    publish_ready: details.ready === true,
    blocking_count: blockers.length,
    blocking_ids: blockers.map((item) => item && item.id).filter(Boolean),
    blocking_reasons: blockers.map((item) => item && item.reason).filter(Boolean),
    blocking_missing: blockers.flatMap((item) => Array.isArray(item && item.missing) ? item.missing : [])
  };
}

async function loadSceneIndexFromFile(projectPath, fileSystem) {
  const indexPath = path.join(projectPath, '.sce', 'spec-governance', 'scene-index.json');
  if (!await fileSystem.pathExists(indexPath)) {
    return null;
  }
  try {
    const data = await fileSystem.readJson(indexPath);
    return {
      source: indexPath,
      data
    };
  } catch (_error) {
    return null;
  }
}

async function loadSceneIndexFromState(projectPath, fileSystem, env) {
  try {
    const stateStore = new SceStateStore(projectPath, {
      fileSystem,
      env
    });
    const records = await stateStore.listGovernanceSceneIndexRecords({ limit: 500 });
    if (!Array.isArray(records)) {
      return null;
    }
    const scenes = {};
    for (const record of records) {
      if (!record || !record.scene_id) {
        continue;
      }
      scenes[record.scene_id] = {
        total_specs: record.total_specs,
        active_specs: record.active_specs,
        completed_specs: record.completed_specs,
        stale_specs: record.stale_specs,
        spec_ids: Array.isArray(record.spec_ids) ? record.spec_ids : [],
        active_spec_ids: Array.isArray(record.active_spec_ids) ? record.active_spec_ids : [],
        stale_spec_ids: Array.isArray(record.stale_spec_ids) ? record.stale_spec_ids : []
      };
    }
    return {
      source: 'sqlite:governance_scene_index_registry',
      data: {
        schema_version: '1.0',
        generated_at: new Date().toISOString(),
        scene_filter: null,
        scenes
      }
    };
  } catch (_error) {
    return null;
  }
}

async function resolveSceneSpecs(sceneId, options, dependencies) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;

  const explicitSpecs = normalizeStringArray(options && options.specs);
  if (explicitSpecs.length > 0) {
    return {
      scene_id: sceneId,
      spec_ids: explicitSpecs,
      source: 'options.specs'
    };
  }

  const indexFile = await loadSceneIndexFromFile(projectPath, fileSystem);
  if (indexFile && indexFile.data && indexFile.data.scenes && indexFile.data.scenes[sceneId]) {
    const record = indexFile.data.scenes[sceneId];
    return {
      scene_id: sceneId,
      spec_ids: Array.isArray(record.spec_ids) ? record.spec_ids : [],
      source: indexFile.source
    };
  }

  const indexState = await loadSceneIndexFromState(projectPath, fileSystem, env);
  if (indexState && indexState.data && indexState.data.scenes && indexState.data.scenes[sceneId]) {
    const record = indexState.data.scenes[sceneId];
    return {
      scene_id: sceneId,
      spec_ids: Array.isArray(record.spec_ids) ? record.spec_ids : [],
      source: indexState.source
    };
  }

  const governanceReport = await runStudioSpecGovernance({
    apply: false,
    scene: sceneId
  }, {
    projectPath,
    fileSystem
  });
  if (governanceReport && Array.isArray(governanceReport.scenes)) {
    const target = governanceReport.scenes.find((scene) => normalizeText(scene.scene_id) === sceneId);
    if (target) {
      return {
        scene_id: sceneId,
        spec_ids: Array.isArray(target.specs)
          ? target.specs.map((item) => normalizeText(item.spec_id)).filter(Boolean)
          : [],
        source: 'studio-spec-governance'
      };
    }
  }

  return {
    scene_id: sceneId,
    spec_ids: [],
    source: 'unknown'
  };
}

function summarizeTasks(tasks) {
  const summary = {
    total: 0,
    completed: 0,
    in_progress: 0,
    queued: 0,
    not_started: 0,
    unknown: 0
  };

  if (!Array.isArray(tasks)) {
    return summary;
  }

  summary.total = tasks.length;
  tasks.forEach((task) => {
    const status = normalizeText(task && task.status);
    if (status === 'completed') {
      summary.completed += 1;
    } else if (status === 'in-progress') {
      summary.in_progress += 1;
    } else if (status === 'queued') {
      summary.queued += 1;
    } else if (status === 'not-started') {
      summary.not_started += 1;
    } else {
      summary.unknown += 1;
    }
  });

  return summary;
}

function buildCandidateSummary(specs) {
  const summary = {
    spec_count: specs.length,
    task_total: 0,
    task_completed: 0,
    task_pending: 0
  };
  specs.forEach((spec) => {
    const taskSummary = spec.task_summary || {};
    summary.task_total += Number(taskSummary.total || 0);
    summary.task_completed += Number(taskSummary.completed || 0);
  });
  summary.task_pending = Math.max(0, summary.task_total - summary.task_completed);
  return summary;
}

function buildScoreFromCandidate(candidate) {
  const summary = candidate && candidate.summary ? candidate.summary : {};
  const taskTotal = Number(summary.task_total || 0);
  const taskCompleted = Number(summary.task_completed || 0);
  const specCount = Number(summary.spec_count || 0);
  const completionRate = taskTotal > 0 ? taskCompleted / taskTotal : 0;
  const reuseScore = Math.min(100, Math.round((specCount / 3) * 100));
  const stabilityScore = Math.round(completionRate * 100);
  const riskScore = Math.min(100, Math.round((1 - completionRate) * 100));
  const ontologySummary = buildCoreOntologySummary(candidate && candidate.ontology_scope);
  const ontologyCoreScore = Math.round(ontologySummary.coverage_ratio * 100);
  const valueScore = Math.round(
    (stabilityScore * 0.4) +
    (reuseScore * 0.2) +
    ((100 - riskScore) * 0.1) +
    (ontologyCoreScore * 0.3)
  );

  return {
    completion_rate: Number(completionRate.toFixed(3)),
    reuse_score: reuseScore,
    stability_score: stabilityScore,
    risk_score: riskScore,
    ontology_core_score: ontologyCoreScore,
    ontology_core: ontologySummary,
    value_score: valueScore
  };
}

function buildTemplateCandidate(candidate, mapping, options) {
  const sceneId = buildSceneIdFromCandidate(candidate);
  const templateId = normalizeText(options && options.template_id)
    || normalizeText(options && options.id)
    || sceneId.replace(/[^\w.-]+/g, '_');
  const name = normalizeText(options && options.name)
    || `Capability template: ${sceneId}`;
  const description = normalizeText(options && options.description)
    || `Capability template derived from ${sceneId}`;
  const category = normalizeText(options && options.category) || 'capability';
  const tags = normalizeStringArray(options && options.tags);
  const ontologyScope = normalizeOntologyScope(
    (mapping && mapping.ontology_scope && typeof mapping.ontology_scope === 'object')
      ? mapping.ontology_scope
      : candidate && candidate.ontology_scope
  );
  const ontologyCore = buildCoreOntologySummary(ontologyScope);

  return {
    mode: 'capability-template',
    template_id: templateId,
    name,
    description,
    category,
    template_type: 'capability-template',
    scene_id: sceneId,
    source_candidate: candidate,
    ontology_scope: ontologyScope,
    ontology_core: ontologyCore,
    tags,
    created_at: new Date().toISOString()
  };
}

async function buildCapabilityCandidatePayload(sceneId, options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;

  const specResolution = await resolveSceneSpecs(sceneId, {
    specs: options.specs
  }, { projectPath, fileSystem, env });
  const specIds = Array.isArray(specResolution.spec_ids) ? specResolution.spec_ids : [];

  const taskClaimer = new TaskClaimer();
  const specs = [];
  const ontologyScopes = [];
  const ontologyEvidence = [];

  for (const specId of specIds) {
    const tasksPath = path.join(projectPath, '.sce', 'specs', specId, 'tasks.md');
    let tasks = [];
    let taskError = null;
    if (await fileSystem.pathExists(tasksPath)) {
      try {
        tasks = await taskClaimer.parseTasks(tasksPath, { preferStatusMarkers: true });
      } catch (error) {
        taskError = error.message;
      }
    } else {
      taskError = 'tasks.md missing';
    }
    const domainChain = await loadSpecDomainChain(projectPath, specId, fileSystem);
    const specOntologyScope = domainChain.payload ? buildOntologyScopeFromChain(domainChain.payload) : createEmptyOntologyScope();
    if (domainChain.payload) {
      ontologyScopes.push(specOntologyScope);
      ontologyEvidence.push({
        spec_id: specId,
        source: path.relative(projectPath, domainChain.path),
        triads: buildCoreOntologySummary(specOntologyScope)
      });
    }
    const taskSummary = summarizeTasks(tasks);
    specs.push({
      spec_id: specId,
      tasks_path: path.relative(projectPath, tasksPath),
      task_summary: taskSummary,
      task_sample: tasks.slice(0, toPositiveInteger(options.sample_limit, 5)).map((task) => ({
        id: task.taskId,
        title: task.title,
        status: task.status
      })),
      ontology_scope: specOntologyScope,
      ontology_source: domainChain.exists ? path.relative(projectPath, domainChain.path) : null,
      ontology_error: domainChain.error || null,
      task_error: taskError
    });
  }

  const ontologyScope = mergeOntologyScopes(ontologyScopes);
  const ontologyCore = buildCoreOntologySummary(ontologyScope);
  return {
    mode: 'capability-extract',
    scene_id: sceneId,
    generated_at: new Date().toISOString(),
    source: {
      scene_index_source: specResolution.source || 'unknown',
      spec_count: specIds.length
    },
    specs,
    ontology_scope: ontologyScope,
    ontology_core: ontologyCore,
    ontology_evidence: ontologyEvidence,
    summary: {
      ...buildCandidateSummary(specs),
      ontology_triads_ready: ontologyCore.ready,
      ontology_triads_coverage_ratio: ontologyCore.coverage_ratio,
      ontology_missing_triads: ontologyCore.missing
    }
  };
}

async function listCapabilityInventorySceneIds(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;
  const explicitScene = normalizeText(options.scene || options.sceneId || options.scene_id);
  if (explicitScene) {
    return [explicitScene];
  }
  const fromFile = await loadSceneIndexFromFile(projectPath, fileSystem);
  if (fromFile && fromFile.data && fromFile.data.scenes) {
    return Object.keys(fromFile.data.scenes).sort();
  }
  const fromState = await loadSceneIndexFromState(projectPath, fileSystem, env);
  if (fromState && fromState.data && fromState.data.scenes) {
    return Object.keys(fromState.data.scenes).sort();
  }
  return [];
}

function resolveCapabilityTriadPriority(entry) {
  const missing = Array.isArray(entry && entry.release_readiness_ui && entry.release_readiness_ui.blocking_missing)
    ? entry.release_readiness_ui.blocking_missing
    : [];
  if (missing.includes('decision_strategy')) {
    return 0;
  }
  if (missing.includes('business_rules')) {
    return 1;
  }
  if (missing.includes('entity_relation')) {
    return 2;
  }
  return 3;
}

function buildCapabilityInventorySummaryStats(entries) {
  const items = Array.isArray(entries) ? entries : [];
  const summary = {
    publish_ready_count: 0,
    blocked_count: 0,
    missing_triads: {
      decision_strategy: 0,
      business_rules: 0,
      entity_relation: 0
    }
  };

  for (const entry of items) {
    const ready = Boolean(entry && entry.release_readiness_ui && entry.release_readiness_ui.publish_ready);
    if (ready) {
      summary.publish_ready_count += 1;
    } else {
      summary.blocked_count += 1;
    }

    const missing = Array.isArray(entry && entry.release_readiness_ui && entry.release_readiness_ui.blocking_missing)
      ? entry.release_readiness_ui.blocking_missing
      : [];
    for (const triad of Object.keys(summary.missing_triads)) {
      if (missing.includes(triad)) {
        summary.missing_triads[triad] += 1;
      }
    }
  }

  return summary;
}

function sortCapabilityInventoryEntries(entries) {
  return [...(Array.isArray(entries) ? entries : [])].sort((left, right) => {
    const leftReady = Boolean(left && left.release_readiness_ui && left.release_readiness_ui.publish_ready);
    const rightReady = Boolean(right && right.release_readiness_ui && right.release_readiness_ui.publish_ready);
    if (leftReady !== rightReady) {
      return leftReady ? 1 : -1;
    }

    const triadDelta = resolveCapabilityTriadPriority(left) - resolveCapabilityTriadPriority(right);
    if (triadDelta !== 0) {
      return triadDelta;
    }

    const leftValue = Number(left && left.score_preview && left.score_preview.value_score || 0);
    const rightValue = Number(right && right.score_preview && right.score_preview.value_score || 0);
    if (leftValue !== rightValue) {
      return rightValue - leftValue;
    }

    return String(left && left.scene_id || '').localeCompare(String(right && right.scene_id || ''));
  });
}

function filterCapabilityInventoryEntries(entries, options = {}) {
  const normalizedMissingTriad = normalizeText(options.missingTriad || options.missing_triad).toLowerCase();
  const releaseReadyFilter = normalizeText(options.releaseReady || options.release_ready).toLowerCase();
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    if (releaseReadyFilter) {
      const expected = ['1', 'true', 'yes', 'ready'].includes(releaseReadyFilter);
      if (Boolean(entry.release_readiness_ui && entry.release_readiness_ui.publish_ready) !== expected) {
        return false;
      }
    }
    if (normalizedMissingTriad) {
      const missing = Array.isArray(entry.release_readiness_ui && entry.release_readiness_ui.blocking_missing)
        ? entry.release_readiness_ui.blocking_missing
        : [];
      if (!missing.includes(normalizedMissingTriad)) {
        return false;
      }
    }
    return true;
  });
}

async function runCapabilityInventoryCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;
  const sceneIds = await listCapabilityInventorySceneIds(options, { projectPath, fileSystem, env });
  const limit = toPositiveInteger(options.limit, sceneIds.length || 20);
  const scenes = [];

  for (const sceneId of sceneIds.slice(0, limit)) {
    const candidate = await buildCapabilityCandidatePayload(sceneId, {
      specs: options.specs,
      sample_limit: options.sample_limit
    }, dependencies);
    const score = buildScoreFromCandidate(candidate);
    const releaseReadiness = buildCapabilityReleaseReadiness({
      scene_id: sceneId,
      ontology_scope: candidate.ontology_scope,
      ontology_core: candidate.ontology_core
    });
    scenes.push({
      scene_id: sceneId,
      summary: candidate.summary,
      source: candidate.source,
      ontology_scope: candidate.ontology_scope,
      ontology_core: candidate.ontology_core,
      ontology_core_ui: buildOntologyCoreUiState(candidate.ontology_core),
      release_readiness: releaseReadiness,
      release_readiness_ui: buildCapabilityReleaseReadinessUi(releaseReadiness),
      score_preview: score
    });
  }

  const filteredScenes = sortCapabilityInventoryEntries(filterCapabilityInventoryEntries(scenes, options));
  const releaseReadyFilterRaw = normalizeText(options.releaseReady || options.release_ready).toLowerCase();
  const payload = {
    mode: 'capability-inventory',
    generated_at: new Date().toISOString(),
    query: {
      protocol_version: '1.0',
      scene_id: normalizeText(options.scene || options.sceneId || options.scene_id) || null,
      limit: limit,
      sample_limit: toPositiveInteger(options.sample_limit, 5),
      filters: {
        release_ready: releaseReadyFilterRaw ? ['1', 'true', 'yes', 'ready'].includes(releaseReadyFilterRaw) : null,
        missing_triad: normalizeText(options.missingTriad || options.missing_triad) || null
      }
    },
    scene_total: scenes.length,
    scene_count: filteredScenes.length,
    summary_stats: buildCapabilityInventorySummaryStats(filteredScenes),
    sort: {
      strategy: 'publish_ready -> missing_triad_priority -> value_score_desc -> scene_id',
      triad_priority: ['decision_strategy', 'business_rules', 'entity_relation']
    },
    scenes: filteredScenes
  };

  if (normalizeBoolean(options.json, false)) {
    return payload;
  }
  console.log(chalk.green('✅ Capability inventory generated'));
  console.log(chalk.gray('  Scenes: ' + filteredScenes.length));
  return payload;
}

function buildRegistryEntry(templateCandidate, options) {
  const riskLevel = normalizeText(options && options.risk_level) || 'medium';
  const difficulty = normalizeText(options && options.difficulty) || 'intermediate';
  const applicable = normalizeStringArray(options && options.applicable_scenarios);
  const tags = normalizeStringArray(options && options.tags);
  const sceneId = buildSceneIdFromCandidate(templateCandidate);
  const safeTags = tags.length > 0 ? tags : ['capability', sceneId];
  const safeApplicable = applicable.length > 0 ? applicable : [sceneId];

  return {
    id: templateCandidate.template_id,
    name: templateCandidate.name,
    category: templateCandidate.category,
    description: templateCandidate.description,
    difficulty,
    tags: safeTags,
    applicable_scenarios: safeApplicable,
    files: ['capability-template.json'],
    template_type: 'capability-template',
    min_sce_version: packageJson.version,
    max_sce_version: null,
    risk_level: riskLevel,
    rollback_contract: {
      supported: false,
      strategy: 'n/a'
    },
    ontology_scope: templateCandidate.ontology_scope
  };
}

async function runCapabilityExtractCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const sceneId = normalizeText(options.scene || options.sceneId || options.scene_id);
  const writeOutput = normalizeBoolean(options.write, true);

  if (!sceneId) {
    throw new Error('scene is required for capability extract');
  }

  const payload = await buildCapabilityCandidatePayload(sceneId, options, dependencies);
  const outputPath = normalizeText(options.out) || buildDefaultCandidatePath(sceneId);
  if (writeOutput) {
    await fileSystem.ensureDir(path.dirname(path.join(projectPath, outputPath)));
    await fileSystem.writeJson(path.join(projectPath, outputPath), payload, { spaces: 2 });
    payload.output_file = outputPath;
  }

  if (!normalizeBoolean(options.json, false)) {
    console.log(chalk.green('✅ Capability candidate extracted'));
    console.log(chalk.gray('  Scene: ' + sceneId));
    console.log(chalk.gray('  Specs: ' + payload.summary.spec_count));
    console.log(chalk.gray('  Tasks: ' + payload.summary.task_total));
    if (payload.output_file) {
      console.log(chalk.gray('  Output: ' + payload.output_file));
    }
  }

  return payload;
}
async function runCapabilityScoreCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const inputPath = normalizeText(options.input || options.file);
  if (!inputPath) {
    throw new Error('input candidate file is required for capability score');
  }

  const candidate = await fileSystem.readJson(path.join(projectPath, inputPath));
  const sceneId = buildSceneIdFromCandidate(candidate);
  const scores = buildScoreFromCandidate(candidate);
  const payload = {
    mode: 'capability-score',
    scene_id: sceneId,
    generated_at: new Date().toISOString(),
    input: inputPath,
    scores,
    summary: candidate && candidate.summary ? candidate.summary : null
  };

  const outputPath = normalizeText(options.out) || buildDefaultScorePath(sceneId);
  if (normalizeBoolean(options.write, true)) {
    await fileSystem.ensureDir(path.dirname(path.join(projectPath, outputPath)));
    await fileSystem.writeJson(path.join(projectPath, outputPath), payload, { spaces: 2 });
    payload.output_file = outputPath;
  }

  if (!normalizeBoolean(options.json, false)) {
    console.log(chalk.green('✅ Capability score generated'));
    console.log(chalk.gray(`  Scene: ${sceneId}`));
    console.log(chalk.gray(`  Value score: ${scores.value_score}`));
    if (payload.output_file) {
      console.log(chalk.gray(`  Output: ${payload.output_file}`));
    }
  }

  return payload;
}

async function runCapabilityMapCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const inputPath = normalizeText(options.input || options.file);
  if (!inputPath) {
    throw new Error('input candidate file is required for capability map');
  }

  const mappingPath = normalizeText(options.mapping);
  const candidate = await fileSystem.readJson(path.join(projectPath, inputPath));
  const mapping = mappingPath
    ? await fileSystem.readJson(path.join(projectPath, mappingPath))
    : { ontology_scope: { domains: [], entities: [], relations: [], business_rules: [], decisions: [] } };

  const templateCandidate = buildTemplateCandidate(candidate, mapping, options);
  const sceneId = buildSceneIdFromCandidate(candidate);
  const payload = {
    mode: 'capability-map',
    scene_id: sceneId,
    generated_at: new Date().toISOString(),
    input: inputPath,
    mapping: mappingPath || null,
    template: templateCandidate,
    release_readiness: buildCapabilityReleaseReadiness(templateCandidate)
  };

  const outputPath = normalizeText(options.out) || buildDefaultTemplatePath(sceneId);
  if (normalizeBoolean(options.write, true)) {
    await fileSystem.ensureDir(path.dirname(path.join(projectPath, outputPath)));
    await fileSystem.writeJson(path.join(projectPath, outputPath), payload, { spaces: 2 });
    payload.output_file = outputPath;
  }

  if (!normalizeBoolean(options.json, false)) {
    console.log(chalk.green('✅ Capability ontology mapping prepared'));
    console.log(chalk.gray(`  Scene: ${sceneId}`));
    if (payload.output_file) {
      console.log(chalk.gray(`  Output: ${payload.output_file}`));
    }
  }

  return payload;
}

async function runCapabilityRegisterCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const inputPath = normalizeText(options.input || options.file);
  if (!inputPath) {
    throw new Error('input template file is required for capability register');
  }

  const payload = await fileSystem.readJson(path.join(projectPath, inputPath));
  const templateCandidate = payload.template || payload;
  if (!templateCandidate || !templateCandidate.template_id) {
    throw new Error('template_id missing in capability template candidate');
  }
  const releaseReadiness = buildCapabilityReleaseReadiness(templateCandidate);
  if (!releaseReadiness.ready) {
    const error = new Error(`capability register blocked: ${releaseReadiness.blockers.map((item) => item.reason).join('; ')}`);
    error.code = 'CAPABILITY_REGISTER_BLOCKED';
    error.details = {
      release_readiness: releaseReadiness
    };
    throw error;
  }
  const ontologySummary = assertCoreOntologySummary(
    buildCoreOntologySummary(templateCandidate.ontology_scope),
    'capability template'
  );
  templateCandidate.ontology_scope = ontologySummary.ontology_scope;

  const exportDir = normalizeText(options.out) || buildDefaultExportDir(templateCandidate.template_id);
  const outputDirAbs = path.join(projectPath, exportDir);
  await fileSystem.ensureDir(outputDirAbs);

  const registryEntry = buildRegistryEntry(templateCandidate, options);
  const registryPayload = {
    version: '1.0',
    templates: [registryEntry]
  };

  await fileSystem.writeJson(path.join(outputDirAbs, 'capability-template.json'), templateCandidate, { spaces: 2 });
  await fileSystem.writeJson(path.join(outputDirAbs, 'template-registry.json'), registryPayload, { spaces: 2 });

  const result = {
    mode: 'capability-register',
    template_id: templateCandidate.template_id,
    output_dir: exportDir,
    ontology_core: ontologySummary,
    release_readiness: releaseReadiness,
    files: [
      path.join(exportDir, 'capability-template.json'),
      path.join(exportDir, 'template-registry.json')
    ]
  };

  if (!normalizeBoolean(options.json, false)) {
    console.log(chalk.green('✅ Capability template package exported'));
    console.log(chalk.gray(`  Template: ${templateCandidate.template_id}`));
    console.log(chalk.gray(`  Output: ${exportDir}`));
  }

  return result;
}

function filterCapabilityCatalogEntries(templates, options = {}) {
  const entries = Array.isArray(templates) ? templates : [];
  const normalizedMissingTriad = normalizeText(options.missingTriad || options.missing_triad).toLowerCase();
  const releaseReadyFilter = normalizeText(options.releaseReady || options.release_ready).toLowerCase();

  return entries.filter((entry) => {
    const template = enrichCapabilityTemplateForUi(entry);

    if (releaseReadyFilter) {
      const expected = ['1', 'true', 'yes', 'ready'].includes(releaseReadyFilter);
      if (template.release_readiness_ui.publish_ready !== expected) {
        return false;
      }
    }

    if (normalizedMissingTriad) {
      const missing = Array.isArray(template.release_readiness_ui.blocking_missing)
        ? template.release_readiness_ui.blocking_missing
        : [];
      if (!missing.includes(normalizedMissingTriad)) {
        return false;
      }
    }

    return true;
  });
}

function displayCapabilityCatalog(templates, options = {}) {
  const total = Array.isArray(templates) ? templates.length : 0;
  console.log(chalk.red('🔥') + ' Capability Library');
  if (total === 0) {
    console.log(chalk.yellow('No capability templates found.'));
    if (options.source) {
      console.log(chalk.gray(`Try removing filters or run ${chalk.cyan('sce templates update')}.`));
    }
    return;
  }
  templates.forEach((rawTemplate) => {
    const template = enrichCapabilityTemplateForUi(rawTemplate);
    const sourcePrefix = template.source && template.source !== 'official'
      ? chalk.gray(`[${template.source}] `)
      : '';
    console.log(`${sourcePrefix}${chalk.cyan(template.id)} ${chalk.gray(`(${template.category})`)}`);
    console.log(`  ${template.name}`);
    console.log(`  ${chalk.gray(template.description)}`);
    console.log();
  });
  console.log(chalk.gray(`Total: ${total} capability template(s)`));
}

async function listCapabilityCatalog(options = {}) {
  const manager = new TemplateManager();
  const templates = filterCapabilityCatalogEntries((await manager.listTemplates({
    category: options.category,
    source: options.source,
    templateType: 'capability-template',
    compatibleWith: options.compatibleWith,
    riskLevel: options.risk
  })).map((template) => enrichCapabilityTemplateForUi(template)), options);
  if (normalizeBoolean(options.json, false)) {
    return {
      mode: 'capability-catalog-list',
      templates
    };
  }
  displayCapabilityCatalog(templates, options);
  return { templates };
}

async function searchCapabilityCatalog(keyword, options = {}) {
  const manager = new TemplateManager();
  const templates = filterCapabilityCatalogEntries((await manager.searchTemplates(keyword, {
    category: options.category,
    source: options.source,
    templateType: 'capability-template',
    compatibleWith: options.compatibleWith,
    riskLevel: options.risk
  })).map((template) => enrichCapabilityTemplateForUi(template)), options);
  if (normalizeBoolean(options.json, false)) {
    return {
      mode: 'capability-catalog-search',
      keyword,
      templates
    };
  }
  displayCapabilityCatalog(templates, options);
  return { templates };
}

async function showCapabilityTemplate(templatePath, options = {}) {
  const manager = new TemplateManager();
  const template = enrichCapabilityTemplateForUi(await manager.showTemplate(templatePath));
  const { sourceName, templateId } = parseTemplatePath(templatePath);
  await manager.ensureCached(sourceName);
  const sourcePath = manager.cacheManager.getSourceCachePath(sourceName);
  const templateDir = path.join(sourcePath, templateId);
  const capabilityFile = path.join(templateDir, 'capability-template.json');
  let templatePayload = null;
  if (await fs.pathExists(capabilityFile)) {
    try {
      templatePayload = await fs.readJson(capabilityFile);
    } catch (_error) {
      templatePayload = null;
    }
  }
  const result = {
    mode: 'capability-catalog-show',
    template,
    template_file: await fs.pathExists(capabilityFile) ? capabilityFile : null,
    payload: templatePayload
  };
  if (normalizeBoolean(options.json, false)) {
    return result;
  }
  console.log(chalk.green('✅ Capability template loaded'));
  console.log(chalk.gray(`  ID: ${template.id}`));
  console.log(chalk.gray(`  Name: ${template.name}`));
  if (templatePayload) {
    console.log(chalk.gray('  Payload: capability-template.json loaded'));
  }
  return result;
}

async function matchCapabilityTemplates(options = {}) {
  const projectPath = options.projectPath || process.cwd();
  const fileSystem = options.fileSystem || fs;
  const specId = normalizeText(options.spec || options.specId);
  if (!specId) {
    throw new Error('spec is required for capability match');
  }
  const chain = await loadSpecDomainChain(projectPath, specId, fileSystem);
  if (!chain.exists && normalizeBoolean(options.strict, false)) {
    throw new Error(`problem-domain-chain missing for spec ${specId}`);
  }
  if (chain.error && normalizeBoolean(options.strict, false)) {
    throw new Error(`problem-domain-chain invalid: ${chain.error}`);
  }
  const domainChain = chain.payload || {};
  const specScope = buildOntologyScopeFromChain(domainChain);
  const queryTokens = normalizeTokenList(options.query)
    .concat(normalizeTokenList(domainChain.problem && domainChain.problem.statement))
    .concat(normalizeTokenList(domainChain.scene_id));
  const manager = new TemplateManager();
  const templates = await manager.listTemplates({
    source: options.source,
    templateType: 'capability-template',
    compatibleWith: options.compatibleWith,
    riskLevel: options.risk
  });
  const matches = templates.map((template) => {
    const overlap = buildOntologyOverlap(specScope, template.ontology_scope || {});
    const scenarioScore = template.applicable_scenarios && domainChain.scene_id
      ? (template.applicable_scenarios.includes(domainChain.scene_id) ? 1 : 0)
      : 0;
    const keywordScore = buildKeywordScore(template, queryTokens);
    const totalScore = (overlap.score * 0.6) + (scenarioScore * 0.2) + (keywordScore * 0.2);
    return {
      template_id: template.id,
      source: template.source,
      name: template.name,
      description: template.description,
      category: template.category,
      risk_level: template.risk_level,
      ontology_core: template.ontology_core || buildCoreOntologySummary(template.ontology_scope || {}),
      ontology_core_ui: buildOntologyCoreUiState(template.ontology_core || buildCoreOntologySummary(template.ontology_scope || {})),
      score: Math.round(totalScore * 100),
      score_components: {
        ontology: Number(overlap.score.toFixed(3)),
        scenario: scenarioScore,
        keyword: Number(keywordScore.toFixed(3))
      },
      overlap
    };
  }).sort((a, b) => b.score - a.score);

  const limit = toPositiveInteger(options.limit, 10);
  const payload = {
    mode: 'capability-match',
    spec_id: specId,
    scene_id: domainChain.scene_id || null,
    query: normalizeText(options.query) || null,
    ontology_source: chain.exists ? chain.path : null,
    match_count: matches.length,
    matches: matches.slice(0, limit),
    warnings: chain.exists ? [] : ['problem-domain-chain missing; ontology-based match unavailable']
  };
  if (normalizeBoolean(options.json, false)) {
    return payload;
  }
  console.log(chalk.green('✅ Capability match completed'));
  console.log(chalk.gray(`  Spec: ${specId}`));
  console.log(chalk.gray(`  Matches: ${payload.matches.length}`));
  return payload;
}

async function useCapabilityTemplate(options = {}) {
  const projectPath = options.projectPath || process.cwd();
  const fileSystem = options.fileSystem || fs;
  const templateId = normalizeText(options.template || options.id);
  if (!templateId) {
    throw new Error('template is required for capability use');
  }
  if (normalizeBoolean(options.apply, false) && normalizeBoolean(options.write, true) === false) {
    throw new Error('cannot use --apply with --no-write');
  }
  const specId = normalizeText(options.spec || options.specId) || null;
  const manager = new TemplateManager();
  const template = await manager.showTemplate(templateId);
  const { sourceName, templateId: parsedTemplateId } = parseTemplatePath(templateId);
  await manager.ensureCached(sourceName);
  const sourcePath = manager.cacheManager.getSourceCachePath(sourceName);
  const templateDir = path.join(sourcePath, parsedTemplateId);
  const capabilityFile = path.join(templateDir, 'capability-template.json');
  let templatePayload = null;
  if (await fileSystem.pathExists(capabilityFile)) {
    try {
      templatePayload = await fileSystem.readJson(capabilityFile);
    } catch (_error) {
      templatePayload = null;
    }
  }

  const recommendedTasks = [];
  if (templatePayload && templatePayload.source_candidate && Array.isArray(templatePayload.source_candidate.specs)) {
    templatePayload.source_candidate.specs.forEach((spec) => {
      const sample = Array.isArray(spec.task_sample) ? spec.task_sample : [];
      sample.forEach((task) => {
        if (task && task.title) {
          recommendedTasks.push({
            title: task.title,
            source_spec_id: spec.spec_id || null,
            source_task_id: task.id || null
          });
        }
      });
    });
  }
  if (recommendedTasks.length === 0) {
    recommendedTasks.push({ title: `Implement capability scope: ${template.name || parsedTemplateId}` });
  }

  const plan = {
    mode: 'capability-use-plan',
    generated_at: new Date().toISOString(),
    template: {
      id: template.id,
      name: template.name,
      source: template.source,
      description: template.description,
      ontology_scope: template.ontology_scope || {},
      ontology_core: template.ontology_core || buildCoreOntologySummary(template.ontology_scope || {}),
      ontology_core_ui: buildOntologyCoreUiState(template.ontology_core || buildCoreOntologySummary(template.ontology_scope || {}))
    },
    spec_id: specId,
    recommended_tasks: recommendedTasks
  };

  const outputPath = normalizeText(options.out) || buildDefaultUsePlanPath(specId || 'spec', template.id);
  if (normalizeBoolean(options.write, true)) {
    await fileSystem.ensureDir(path.dirname(path.join(projectPath, outputPath)));
    await fileSystem.writeJson(path.join(projectPath, outputPath), plan, { spaces: 2 });
    plan.output_file = outputPath;
  }

  if (normalizeBoolean(options.apply, false)) {
    if (!specId) {
      throw new Error('spec is required for --apply');
    }
    plan.apply = await appendCapabilityPlanToSpecTasks({
      projectPath,
      spec: specId,
      sectionTitle: options.sectionTitle
    }, plan, fileSystem);
  }

  if (!normalizeBoolean(options.json, false)) {
    console.log(chalk.green('✅ Capability use plan generated'));
    console.log(chalk.gray(`  Template: ${template.id}`));
    if (specId) {
      console.log(chalk.gray(`  Spec: ${specId}`));
    }
    if (plan.output_file) {
      console.log(chalk.gray(`  Output: ${plan.output_file}`));
    }
  }

  return plan;
}

function registerCapabilityCommands(program) {
  const capabilityCmd = program
    .command('capability')
    .description('Extract and manage capability templates from scene/spec/task history');

  capabilityCmd
    .command('extract')
    .description('Extract capability candidate from a scene')
    .requiredOption('--scene <scene-id>', 'Scene identifier')
    .option('--specs <spec-ids>', 'Comma-separated spec identifiers')
    .option('--out <path>', 'Output JSON path')
    .option('--sample-limit <n>', 'Max tasks per spec in sample', '5')
    .option('--no-write', 'Skip writing output file')
    .option('--json', 'Output JSON to stdout')
    .action(async (options) => {
      const specs = normalizeText(options.specs)
        ? normalizeText(options.specs).split(',').map((item) => normalizeText(item)).filter(Boolean)
        : [];
      await runCapabilityExtractCommand({
        scene: options.scene,
        specs,
        out: options.out,
        sample_limit: options.sampleLimit,
        write: options.write,
        json: options.json
      });
    });

  capabilityCmd
    .command('inventory')
    .description('Build scene-level capability inventory for homepage views')
    .option('--scene <scene-id>', 'Single scene identifier')
    .option('--sample-limit <n>', 'Max tasks per spec in sample', '5')
    .option('--limit <n>', 'Max scenes to include')
    .option('--release-ready <bool>', 'Filter by publish readiness')
    .option('--missing-triad <name>', 'Filter by missing triad (entity_relation|business_rules|decision_strategy)')
    .option('--json', 'Output JSON to stdout')
    .action(async (options) => {
      try {
        const payload = await runCapabilityInventoryCommand({
          scene: options.scene,
          sample_limit: options.sampleLimit,
          limit: options.limit,
          releaseReady: options.releaseReady,
          missingTriad: options.missingTriad,
          json: options.json
        });
        if (options.json) {
          console.log(JSON.stringify(payload, null, 2));
        }
      } catch (error) {
        console.log();
        console.log(chalk.red('❌ Error:'), error.message);
        process.exit(1);
      }
    });
  capabilityCmd
    .command('score')
    .description('Score a capability candidate')
    .requiredOption('--input <path>', 'Input candidate JSON')
    .option('--out <path>', 'Output JSON path')
    .option('--no-write', 'Skip writing output file')
    .option('--json', 'Output JSON to stdout')
    .action(async (options) => {
      await runCapabilityScoreCommand(options);
    });

  capabilityCmd
    .command('map')
    .description('Attach ontology mapping to a capability candidate')
    .requiredOption('--input <path>', 'Input candidate JSON')
    .option('--mapping <path>', 'Ontology mapping JSON')
    .option('--template-id <id>', 'Template identifier')
    .option('--name <name>', 'Template name')
    .option('--description <desc>', 'Template description')
    .option('--category <category>', 'Template category')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--out <path>', 'Output JSON path')
    .option('--no-write', 'Skip writing output file')
    .option('--json', 'Output JSON to stdout')
    .action(async (options) => {
      const tags = normalizeText(options.tags)
        ? normalizeText(options.tags).split(',').map((item) => normalizeText(item)).filter(Boolean)
        : [];
      await runCapabilityMapCommand({
        ...options,
        tags
      });
    });

  capabilityCmd
    .command('register')
    .description('Export a registry-ready capability template package')
    .requiredOption('--input <path>', 'Input template JSON (output of capability map)')
    .option('--out <path>', 'Output directory')
    .option('--difficulty <level>', 'Difficulty (beginner|intermediate|advanced)')
    .option('--risk-level <level>', 'Risk level (low|medium|high|critical)')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--applicable-scenarios <scenes>', 'Comma-separated applicable scenarios')
    .option('--json', 'Output JSON to stdout')
    .action(async (options) => {
      const tags = normalizeText(options.tags)
        ? normalizeText(options.tags).split(',').map((item) => normalizeText(item)).filter(Boolean)
        : [];
      const applicable = normalizeText(options.applicableScenarios)
        ? normalizeText(options.applicableScenarios).split(',').map((item) => normalizeText(item)).filter(Boolean)
        : [];
      await runCapabilityRegisterCommand({
        ...options,
        risk_level: options.riskLevel,
        applicable_scenarios: applicable,
        tags
      });
    });

  const catalogCmd = capabilityCmd
    .command('catalog')
    .description('Browse and reuse capability templates');

  catalogCmd
    .command('list')
    .description('List capability templates')
    .option('--source <name>', 'Template source name')
    .option('--category <name>', 'Template category filter')
    .option('--compatible-with <semver>', 'SCE version compatibility')
    .option('--risk <level>', 'Risk level filter')
    .option('--release-ready <bool>', 'Filter by publish readiness')
    .option('--missing-triad <name>', 'Filter by missing triad (entity_relation|business_rules|decision_strategy)')
    .option('--json', 'Output JSON to stdout')
    .action(async (options) => {
      try {
        const payload = await listCapabilityCatalog({
          source: options.source,
          category: options.category,
          compatibleWith: options.compatibleWith,
          risk: options.risk,
          releaseReady: options.releaseReady,
          missingTriad: options.missingTriad,
          json: options.json
        });
        if (options.json) {
          console.log(JSON.stringify(payload, null, 2));
        }
      } catch (error) {
        console.log();
        console.log(chalk.red('❌ Error:'), error.message);
        if (error instanceof TemplateError && error.suggestions) {
          console.log();
          console.log(chalk.yellow('💡 Suggestions:'));
          error.suggestions.forEach((suggestion) => console.log(`  • ${suggestion}`));
        }
        process.exit(1);
      }
    });

  catalogCmd
    .command('search <keyword>')
    .description('Search capability templates')
    .option('--source <name>', 'Template source name')
    .option('--category <name>', 'Template category filter')
    .option('--compatible-with <semver>', 'SCE version compatibility')
    .option('--risk <level>', 'Risk level filter')
    .option('--release-ready <bool>', 'Filter by publish readiness')
    .option('--missing-triad <name>', 'Filter by missing triad (entity_relation|business_rules|decision_strategy)')
    .option('--json', 'Output JSON to stdout')
    .action(async (keyword, options) => {
      try {
        const payload = await searchCapabilityCatalog(keyword, {
          source: options.source,
          category: options.category,
          compatibleWith: options.compatibleWith,
          risk: options.risk,
          releaseReady: options.releaseReady,
          missingTriad: options.missingTriad,
          json: options.json
        });
        if (options.json) {
          console.log(JSON.stringify(payload, null, 2));
        }
      } catch (error) {
        console.log();
        console.log(chalk.red('❌ Error:'), error.message);
        if (error instanceof TemplateError && error.suggestions) {
          console.log();
          console.log(chalk.yellow('💡 Suggestions:'));
          error.suggestions.forEach((suggestion) => console.log(`  • ${suggestion}`));
        }
        process.exit(1);
      }
    });

  catalogCmd
    .command('show <template-id>')
    .description('Show capability template details')
    .option('--json', 'Output JSON to stdout')
    .action(async (templateId, options) => {
      try {
        const payload = await showCapabilityTemplate(templateId, { json: options.json });
        if (options.json) {
          console.log(JSON.stringify(payload, null, 2));
        }
      } catch (error) {
        console.log();
        console.log(chalk.red('❌ Error:'), error.message);
        if (error instanceof TemplateError && error.suggestions) {
          console.log();
          console.log(chalk.yellow('💡 Suggestions:'));
          error.suggestions.forEach((suggestion) => console.log(`  • ${suggestion}`));
        }
        process.exit(1);
      }
    });

  capabilityCmd
    .command('match')
    .description('Match capability templates to a spec using ontology scope')
    .requiredOption('--spec <spec-id>', 'Spec identifier')
    .option('--query <text>', 'Additional keyword query')
    .option('--source <name>', 'Template source name')
    .option('--compatible-with <semver>', 'SCE version compatibility')
    .option('--risk <level>', 'Risk level filter')
    .option('--limit <n>', 'Max match results', '10')
    .option('--strict', 'Fail if domain-chain missing or invalid')
    .option('--json', 'Output JSON to stdout')
    .action(async (options) => {
      try {
        const payload = await matchCapabilityTemplates(options);
        if (options.json) {
          console.log(JSON.stringify(payload, null, 2));
        }
      } catch (error) {
        console.log();
        console.log(chalk.red('❌ Error:'), error.message);
        process.exit(1);
      }
    });

  capabilityCmd
    .command('use')
    .description('Generate a capability usage plan for a spec')
    .requiredOption('--template <template-id>', 'Capability template identifier')
    .option('--spec <spec-id>', 'Spec identifier')
    .option('--out <path>', 'Output JSON path')
    .option('--apply', 'Append recommended tasks to spec tasks.md')
    .option('--section-title <title>', 'Custom section title for tasks.md')
    .option('--no-write', 'Skip writing output file')
    .option('--json', 'Output JSON to stdout')
    .action(async (options) => {
      try {
        const payload = await useCapabilityTemplate(options);
        if (options.json) {
          console.log(JSON.stringify(payload, null, 2));
        }
      } catch (error) {
        console.log();
        console.log(chalk.red('❌ Error:'), error.message);
        process.exit(1);
      }
    });
}

module.exports = {
  registerCapabilityCommands,
  runCapabilityExtractCommand,
  runCapabilityScoreCommand,
  runCapabilityMapCommand,
  runCapabilityRegisterCommand,
  runCapabilityInventoryCommand,
  listCapabilityCatalog,
  searchCapabilityCatalog,
  showCapabilityTemplate,
  matchCapabilityTemplates,
  useCapabilityTemplate,
  enrichCapabilityTemplateForUi,
  buildCapabilityReleaseReadinessUi,
  filterCapabilityCatalogEntries,
  filterCapabilityInventoryEntries,
  sortCapabilityInventoryEntries,
  buildCapabilityInventorySummaryStats
};
