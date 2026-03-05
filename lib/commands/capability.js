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
  const valueScore = Math.round((stabilityScore * 0.5) + (reuseScore * 0.3) + ((100 - riskScore) * 0.2));

  return {
    completion_rate: Number(completionRate.toFixed(3)),
    reuse_score: reuseScore,
    stability_score: stabilityScore,
    risk_score: riskScore,
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
  const ontologyScope = (mapping && mapping.ontology_scope && typeof mapping.ontology_scope === 'object')
    ? mapping.ontology_scope
    : {
        domains: [],
        entities: [],
        relations: [],
        business_rules: [],
        decisions: []
      };

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
    tags,
    created_at: new Date().toISOString()
  };
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
  const env = dependencies.env || process.env;
  const sceneId = normalizeText(options.scene || options.sceneId || options.scene_id);
  const writeOutput = normalizeBoolean(options.write, true);

  if (!sceneId) {
    throw new Error('scene is required for capability extract');
  }

  const specResolution = await resolveSceneSpecs(sceneId, {
    specs: options.specs
  }, { projectPath, fileSystem, env });
  const specIds = Array.isArray(specResolution.spec_ids) ? specResolution.spec_ids : [];

  const taskClaimer = new TaskClaimer();
  const specs = [];

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
      task_error: taskError
    });
  }

  const payload = {
    mode: 'capability-extract',
    scene_id: sceneId,
    generated_at: new Date().toISOString(),
    source: {
      scene_index_source: specResolution.source || 'unknown',
      spec_count: specIds.length
    },
    specs,
    summary: buildCandidateSummary(specs)
  };

  const outputPath = normalizeText(options.out) || buildDefaultCandidatePath(sceneId);
  if (writeOutput) {
    await fileSystem.ensureDir(path.dirname(path.join(projectPath, outputPath)));
    await fileSystem.writeJson(path.join(projectPath, outputPath), payload, { spaces: 2 });
    payload.output_file = outputPath;
  }

  if (!normalizeBoolean(options.json, false)) {
    console.log(chalk.green('✅ Capability candidate extracted'));
    console.log(chalk.gray(`  Scene: ${sceneId}`));
    console.log(chalk.gray(`  Specs: ${payload.summary.spec_count}`));
    console.log(chalk.gray(`  Tasks: ${payload.summary.task_total}`));
    if (payload.output_file) {
      console.log(chalk.gray(`  Output: ${payload.output_file}`));
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
    template: templateCandidate
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
  templates.forEach((template) => {
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
  const templates = await manager.listTemplates({
    category: options.category,
    source: options.source,
    templateType: 'capability-template',
    compatibleWith: options.compatibleWith,
    riskLevel: options.risk
  });
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
  const templates = await manager.searchTemplates(keyword, {
    category: options.category,
    source: options.source,
    templateType: 'capability-template',
    compatibleWith: options.compatibleWith,
    riskLevel: options.risk
  });
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
  const template = await manager.showTemplate(templatePath);
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
      ontology_scope: template.ontology_scope || {}
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
    .option('--json', 'Output JSON to stdout')
    .action(async (options) => {
      try {
        const payload = await listCapabilityCatalog({
          source: options.source,
          category: options.category,
          compatibleWith: options.compatibleWith,
          risk: options.risk,
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
    .option('--json', 'Output JSON to stdout')
    .action(async (keyword, options) => {
      try {
        const payload = await searchCapabilityCatalog(keyword, {
          source: options.source,
          category: options.category,
          compatibleWith: options.compatibleWith,
          risk: options.risk,
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
  runCapabilityRegisterCommand
};
