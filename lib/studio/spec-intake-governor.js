const path = require('path');
const fs = require('fs-extra');
const { DraftGenerator } = require('../spec/bootstrap/draft-generator');
const { ensureSpecDomainArtifacts } = require('../spec/domain-modeling');
const {
  DEFAULT_SPEC_SCENE_OVERRIDE_PATH,
  loadSceneBindingOverrides,
  normalizeSceneBindingOverrides,
  resolveSceneIdFromOverrides
} = require('../spec/scene-binding-overrides');

const DEFAULT_STUDIO_INTAKE_POLICY_PATH = '.sce/config/studio-intake-policy.json';
const DEFAULT_STUDIO_GOVERNANCE_DIR = '.sce/spec-governance';
const DEFAULT_STUDIO_PORTFOLIO_REPORT = `${DEFAULT_STUDIO_GOVERNANCE_DIR}/scene-portfolio.latest.json`;
const DEFAULT_STUDIO_SCENE_INDEX = `${DEFAULT_STUDIO_GOVERNANCE_DIR}/scene-index.json`;
const DEFAULT_STUDIO_SCENE_OVERRIDE_PATH = DEFAULT_SPEC_SCENE_OVERRIDE_PATH;

const DEFAULT_STUDIO_SCENE_BACKFILL_RULES = Object.freeze([
  {
    id: 'moqui-core',
    scene_id: 'scene.moqui-core',
    keywords: ['moqui']
  },
  {
    id: 'orchestration',
    scene_id: 'scene.sce-orchestration',
    keywords: ['orchestrate', 'runtime', 'controller', 'batch', 'parallel']
  },
  {
    id: 'template-registry',
    scene_id: 'scene.sce-template-registry',
    keywords: ['template', 'scene-package', 'registry', 'catalog', 'scene-template']
  },
  {
    id: 'spec-governance',
    scene_id: 'scene.sce-spec-governance',
    keywords: ['spec', 'gate', 'ontology', 'governance', 'policy']
  },
  {
    id: 'quality',
    scene_id: 'scene.sce-quality',
    keywords: ['test', 'quality', 'stability', 'jest', 'coverage']
  },
  {
    id: 'docs',
    scene_id: 'scene.sce-docs',
    keywords: ['document', 'documentation', 'onboarding', 'guide']
  },
  {
    id: 'platform',
    scene_id: 'scene.sce-platform',
    keywords: ['adopt', 'upgrade', 'workspace', 'repo', 'environment', 'devops', 'release', 'github', 'npm']
  }
]);

const DEFAULT_STUDIO_INTAKE_POLICY = Object.freeze({
  schema_version: '1.0',
  enabled: true,
  auto_create_spec: true,
  force_spec_for_studio_plan: true,
  allow_manual_spec_override: false,
  prefer_existing_scene_spec: true,
  related_spec_min_score: 45,
  allow_new_spec_when_goal_diverges: true,
  divergence_similarity_threshold: 0.2,
  goal_missing_strategy: 'create_for_tracking',
  question_only_patterns: [
    'how', 'what', 'why', 'when', 'where', 'which', 'can', 'could', 'should', 'would',
    '是否', '怎么', '如何', '为什么', '吗', '么'
  ],
  change_intent_patterns: [
    'implement', 'build', 'create', 'add', 'update', 'upgrade', 'refactor', 'fix', 'stabilize',
    'optimize', 'deliver', 'release', 'bootstrap', 'repair', 'patch',
    '新增', '增加', '实现', '构建', '开发', '修复', '优化', '重构', '发布', '改造', '完善', '增强'
  ],
  spec_id: {
    prefix: 'auto',
    max_goal_slug_tokens: 6
  },
  governance: {
    auto_run_on_plan: true,
    require_auto_on_plan: true,
    max_active_specs_per_scene: 3,
    stale_days: 14,
    duplicate_similarity_threshold: 0.66
  },
  backfill: {
    enabled: true,
    active_only_default: true,
    default_scene_id: 'scene.sce-core',
    override_file: DEFAULT_STUDIO_SCENE_OVERRIDE_PATH,
    rules: DEFAULT_STUDIO_SCENE_BACKFILL_RULES
  }
});

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function normalizeInteger(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lowered)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(lowered)) {
      return false;
    }
  }
  return fallback;
}

function normalizeTextList(value = []) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeText(`${item}`))
    .filter(Boolean);
}

function normalizeBackfillRules(value = []) {
  if (!Array.isArray(value)) {
    return [];
  }
  const rules = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const id = normalizeText(item.id);
    const sceneId = normalizeText(item.scene_id || item.sceneId);
    const keywords = normalizeTextList(item.keywords || item.match_any_keywords || item.matchAnyKeywords);
    if (!id || !sceneId || keywords.length === 0) {
      continue;
    }
    rules.push({
      id,
      scene_id: sceneId,
      keywords
    });
  }
  return rules;
}

function toRelativePosix(projectPath, absolutePath) {
  return path.relative(projectPath, absolutePath).replace(/\\/g, '/');
}

function tokenizeText(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return [];
  }
  return Array.from(new Set(
    normalized
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2 || /[\u4e00-\u9fff]/.test(item))
  ));
}

function computeJaccard(leftTokens = [], rightTokens = []) {
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);
  if (left.size === 0 && right.size === 0) {
    return 1;
  }
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  if (union <= 0) {
    return 0;
  }
  return Number((intersection / union).toFixed(3));
}

function slugifyText(value, fallback = 'spec') {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  const slug = normalized
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || fallback;
}

function buildGoalSlug(goal, maxTokens = 6) {
  const tokens = tokenizeText(goal).slice(0, Math.max(1, maxTokens));
  if (tokens.length === 0) {
    return 'work';
  }
  return slugifyText(tokens.join('-'), 'work');
}

function normalizeSceneSlug(sceneId) {
  const normalized = normalizeText(sceneId).replace(/^scene[._-]?/i, '');
  return slugifyText(normalized, 'scene');
}

function parseTasksProgress(tasksContent) {
  const content = typeof tasksContent === 'string' ? tasksContent : '';
  const taskLines = content.match(/^- \[[ xX]\] .+$/gm) || [];
  const doneLines = content.match(/^- \[[xX]\] .+$/gm) || [];
  const total = taskLines.length;
  const done = doneLines.length;
  const ratio = total > 0 ? Number((done / total).toFixed(3)) : 0;
  return {
    total,
    done,
    ratio
  };
}

function normalizeStudioIntakePolicy(raw = {}) {
  const payload = raw && typeof raw === 'object' ? raw : {};
  const specId = payload.spec_id && typeof payload.spec_id === 'object' ? payload.spec_id : {};
  const governance = payload.governance && typeof payload.governance === 'object' ? payload.governance : {};
  const backfill = payload.backfill && typeof payload.backfill === 'object' ? payload.backfill : {};
  const normalizedBackfillRules = normalizeBackfillRules(backfill.rules);

  return {
    schema_version: normalizeText(payload.schema_version) || DEFAULT_STUDIO_INTAKE_POLICY.schema_version,
    enabled: normalizeBoolean(payload.enabled, DEFAULT_STUDIO_INTAKE_POLICY.enabled),
    auto_create_spec: normalizeBoolean(payload.auto_create_spec, DEFAULT_STUDIO_INTAKE_POLICY.auto_create_spec),
    force_spec_for_studio_plan: normalizeBoolean(
      payload.force_spec_for_studio_plan,
      DEFAULT_STUDIO_INTAKE_POLICY.force_spec_for_studio_plan
    ),
    allow_manual_spec_override: normalizeBoolean(
      payload.allow_manual_spec_override,
      DEFAULT_STUDIO_INTAKE_POLICY.allow_manual_spec_override
    ),
    prefer_existing_scene_spec: normalizeBoolean(
      payload.prefer_existing_scene_spec,
      DEFAULT_STUDIO_INTAKE_POLICY.prefer_existing_scene_spec
    ),
    related_spec_min_score: normalizeInteger(
      payload.related_spec_min_score,
      DEFAULT_STUDIO_INTAKE_POLICY.related_spec_min_score,
      0,
      1000
    ),
    allow_new_spec_when_goal_diverges: normalizeBoolean(
      payload.allow_new_spec_when_goal_diverges,
      DEFAULT_STUDIO_INTAKE_POLICY.allow_new_spec_when_goal_diverges
    ),
    divergence_similarity_threshold: Math.max(
      0,
      Math.min(1, normalizeNumber(
        payload.divergence_similarity_threshold,
        DEFAULT_STUDIO_INTAKE_POLICY.divergence_similarity_threshold
      ))
    ),
    goal_missing_strategy: ['create_for_tracking', 'bind_existing', 'skip'].includes(normalizeText(payload.goal_missing_strategy))
      ? normalizeText(payload.goal_missing_strategy)
      : DEFAULT_STUDIO_INTAKE_POLICY.goal_missing_strategy,
    question_only_patterns: (() => {
      const values = normalizeTextList(payload.question_only_patterns);
      return values.length > 0 ? values : [...DEFAULT_STUDIO_INTAKE_POLICY.question_only_patterns];
    })(),
    change_intent_patterns: (() => {
      const values = normalizeTextList(payload.change_intent_patterns);
      return values.length > 0 ? values : [...DEFAULT_STUDIO_INTAKE_POLICY.change_intent_patterns];
    })(),
    spec_id: {
      prefix: normalizeText(specId.prefix) || DEFAULT_STUDIO_INTAKE_POLICY.spec_id.prefix,
      max_goal_slug_tokens: normalizeInteger(
        specId.max_goal_slug_tokens,
        DEFAULT_STUDIO_INTAKE_POLICY.spec_id.max_goal_slug_tokens,
        1,
        12
      )
    },
    governance: {
      auto_run_on_plan: normalizeBoolean(
        governance.auto_run_on_plan,
        DEFAULT_STUDIO_INTAKE_POLICY.governance.auto_run_on_plan
      ),
      require_auto_on_plan: normalizeBoolean(
        governance.require_auto_on_plan,
        DEFAULT_STUDIO_INTAKE_POLICY.governance.require_auto_on_plan
      ),
      max_active_specs_per_scene: normalizeInteger(
        governance.max_active_specs_per_scene,
        DEFAULT_STUDIO_INTAKE_POLICY.governance.max_active_specs_per_scene,
        1,
        200
      ),
      stale_days: normalizeInteger(
        governance.stale_days,
        DEFAULT_STUDIO_INTAKE_POLICY.governance.stale_days,
        1,
        3650
      ),
      duplicate_similarity_threshold: Math.max(
        0,
        Math.min(1, normalizeNumber(
          governance.duplicate_similarity_threshold,
          DEFAULT_STUDIO_INTAKE_POLICY.governance.duplicate_similarity_threshold
        ))
      )
    },
    backfill: {
      enabled: normalizeBoolean(
        backfill.enabled,
        DEFAULT_STUDIO_INTAKE_POLICY.backfill.enabled
      ),
      active_only_default: normalizeBoolean(
        backfill.active_only_default,
        DEFAULT_STUDIO_INTAKE_POLICY.backfill.active_only_default
      ),
      default_scene_id: normalizeText(backfill.default_scene_id)
        || DEFAULT_STUDIO_INTAKE_POLICY.backfill.default_scene_id,
      override_file: normalizeText(backfill.override_file)
        || DEFAULT_STUDIO_INTAKE_POLICY.backfill.override_file,
      rules: normalizedBackfillRules.length > 0
        ? normalizedBackfillRules
        : normalizeBackfillRules(DEFAULT_STUDIO_INTAKE_POLICY.backfill.rules)
    }
  };
}

async function loadStudioIntakePolicy(projectPath = process.cwd(), fileSystem = fs) {
  const policyPath = path.join(projectPath, DEFAULT_STUDIO_INTAKE_POLICY_PATH);
  let policyPayload = {};
  let loadedFrom = 'default';
  if (await fileSystem.pathExists(policyPath)) {
    try {
      policyPayload = await fileSystem.readJson(policyPath);
      loadedFrom = 'file';
    } catch (_error) {
      policyPayload = {};
      loadedFrom = 'default';
    }
  }
  const policy = normalizeStudioIntakePolicy(policyPayload);
  return {
    policy,
    policy_path: DEFAULT_STUDIO_INTAKE_POLICY_PATH,
    loaded_from: loadedFrom
  };
}

function classifyStudioGoalIntent(goal = '', policy = DEFAULT_STUDIO_INTAKE_POLICY) {
  const normalizedGoal = normalizeText(goal);
  const loweredGoal = normalizedGoal.toLowerCase();
  const changePatterns = Array.isArray(policy.change_intent_patterns) ? policy.change_intent_patterns : [];
  const questionPatterns = Array.isArray(policy.question_only_patterns) ? policy.question_only_patterns : [];

  let changeHits = 0;
  for (const pattern of changePatterns) {
    const keyword = normalizeText(pattern).toLowerCase();
    if (keyword && loweredGoal.includes(keyword)) {
      changeHits += 1;
    }
  }

  let questionHits = 0;
  for (const pattern of questionPatterns) {
    const keyword = normalizeText(pattern).toLowerCase();
    if (keyword && loweredGoal.includes(keyword)) {
      questionHits += 1;
    }
  }

  if (/[?？]\s*$/.test(normalizedGoal)) {
    questionHits += 1;
  }

  if (!normalizedGoal) {
    return {
      intent_type: 'unknown',
      requires_spec: false,
      confidence: 'low',
      signals: {
        change_hits: 0,
        question_hits: 0,
        goal_missing: true
      }
    };
  }

  if (changeHits > 0 && changeHits >= questionHits) {
    return {
      intent_type: 'change_request',
      requires_spec: true,
      confidence: changeHits >= 2 ? 'high' : 'medium',
      signals: {
        change_hits: changeHits,
        question_hits: questionHits,
        goal_missing: false
      }
    };
  }

  if (questionHits > 0 && changeHits === 0) {
    return {
      intent_type: 'analysis_only',
      requires_spec: false,
      confidence: 'medium',
      signals: {
        change_hits: changeHits,
        question_hits: questionHits,
        goal_missing: false
      }
    };
  }

  return {
    intent_type: 'ambiguous',
    requires_spec: false,
    confidence: 'low',
    signals: {
      change_hits: changeHits,
      question_hits: questionHits,
      goal_missing: false
    }
  };
}

async function listExistingSpecIds(projectPath, fileSystem = fs) {
  const specsRoot = path.join(projectPath, '.sce', 'specs');
  if (!await fileSystem.pathExists(specsRoot)) {
    return [];
  }
  const entries = await fileSystem.readdir(specsRoot);
  const specIds = [];
  for (const entry of entries) {
    const candidatePath = path.join(specsRoot, entry);
    try {
      const stat = await fileSystem.stat(candidatePath);
      if (stat && stat.isDirectory()) {
        specIds.push(entry);
      }
    } catch (_error) {
      // ignore unreadable entry
    }
  }
  specIds.sort();
  return specIds;
}

function createAutoSpecId(sceneId, goal, existingSpecIds = [], policy = DEFAULT_STUDIO_INTAKE_POLICY) {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(2, 14);
  const sceneSlug = normalizeSceneSlug(sceneId);
  const goalSlug = buildGoalSlug(goal, policy?.spec_id?.max_goal_slug_tokens || 6);
  const prefix = slugifyText(normalizeText(policy?.spec_id?.prefix) || 'auto', 'auto');
  const base = `${prefix}-${sceneSlug}-${goalSlug}-${timestamp}`.slice(0, 96);
  const existing = new Set(existingSpecIds);
  if (!existing.has(base)) {
    return base;
  }
  for (let index = 2; index <= 99; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}

async function materializeIntakeSpec(projectPath, payload = {}, dependencies = {}) {
  const fileSystem = dependencies.fileSystem || fs;
  const sceneId = normalizeText(payload.scene_id);
  const goal = normalizeText(payload.goal);
  const fromChat = normalizeText(payload.from_chat);
  const specId = normalizeText(payload.spec_id);
  if (!specId) {
    throw new Error('spec_id is required for intake spec creation');
  }

  const specRoot = path.join(projectPath, '.sce', 'specs', specId);
  if (await fileSystem.pathExists(specRoot)) {
    return {
      created: false,
      spec_id: specId,
      reason: 'already_exists',
      spec_path: toRelativePosix(projectPath, specRoot)
    };
  }

  const allSpecs = await listExistingSpecIds(projectPath, fileSystem);
  const draftGenerator = dependencies.draftGenerator || new DraftGenerator();
  const problemStatement = goal || `Studio intake request from ${fromChat || 'chat-session'}`;
  const draft = draftGenerator.generate({
    specName: specId,
    profile: 'studio-intake',
    template: 'default',
    context: {
      projectPath,
      totalSpecs: allSpecs.length
    },
    answers: {
      problemStatement,
      primaryFlow: `Scene ${sceneId || 'unknown'} iterative capability evolution`,
      verificationPlan: 'Run spec gate + studio verify/release with closure gates'
    }
  });

  const requirementsPath = path.join(specRoot, 'requirements.md');
  const designPath = path.join(specRoot, 'design.md');
  const tasksPath = path.join(specRoot, 'tasks.md');
  await fileSystem.ensureDir(specRoot);
  await fileSystem.writeFile(requirementsPath, draft.requirements, 'utf8');
  await fileSystem.writeFile(designPath, draft.design, 'utf8');
  await fileSystem.writeFile(tasksPath, draft.tasks, 'utf8');
  const domainArtifacts = await ensureSpecDomainArtifacts(projectPath, specId, {
    fileSystem,
    force: true,
    sceneId,
    problemStatement,
    primaryFlow: `Scene ${sceneId || 'unknown'} delivery`,
    verificationPlan: 'spec gate + studio verify + problem-closure gate'
  });

  return {
    created: true,
    spec_id: specId,
    spec_path: toRelativePosix(projectPath, specRoot),
    files: {
      requirements: toRelativePosix(projectPath, requirementsPath),
      design: toRelativePosix(projectPath, designPath),
      tasks: toRelativePosix(projectPath, tasksPath),
      domain_map: toRelativePosix(projectPath, domainArtifacts.paths.domain_map),
      scene_spec: toRelativePosix(projectPath, domainArtifacts.paths.scene_spec),
      domain_chain: toRelativePosix(projectPath, domainArtifacts.paths.domain_chain),
      problem_contract: toRelativePosix(projectPath, domainArtifacts.paths.problem_contract)
    }
  };
}

function normalizeRelatedCandidates(relatedSpecLookup = {}) {
  const items = Array.isArray(relatedSpecLookup.related_specs)
    ? relatedSpecLookup.related_specs
    : [];
  return items
    .map((item) => ({
      spec_id: normalizeText(item.spec_id),
      score: normalizeNumber(item.score, 0),
      scene_id: normalizeText(item.scene_id) || null,
      problem_statement: normalizeText(item.problem_statement) || '',
      reasons: Array.isArray(item.reasons) ? item.reasons : []
    }))
    .filter((item) => item.spec_id);
}

function resolveStudioSpecIntakeDecision(context = {}, policy = DEFAULT_STUDIO_INTAKE_POLICY) {
  const goal = normalizeText(context.goal);
  const explicitSpecId = normalizeText(context.explicit_spec_id);
  const domainChainBinding = context.domain_chain_binding && typeof context.domain_chain_binding === 'object'
    ? context.domain_chain_binding
    : {};
  const relatedCandidates = normalizeRelatedCandidates(context.related_specs);
  const intent = context.intent && typeof context.intent === 'object'
    ? context.intent
    : classifyStudioGoalIntent(goal, policy);

  if (!policy.enabled) {
    return {
      action: 'disabled',
      reason: 'policy_disabled',
      confidence: 'high',
      spec_id: explicitSpecId || null,
      source: explicitSpecId ? 'explicit-spec' : 'none',
      intent
    };
  }

  if (explicitSpecId) {
    return {
      action: 'bind_existing',
      reason: 'explicit_spec',
      confidence: 'high',
      spec_id: explicitSpecId,
      source: 'explicit-spec',
      intent
    };
  }

  const preferredRelated = relatedCandidates.find((item) => item.score >= policy.related_spec_min_score) || null;
  const hasBoundDomainSpec = domainChainBinding.resolved === true && normalizeText(domainChainBinding.spec_id).length > 0;
  const domainSpecId = hasBoundDomainSpec ? normalizeText(domainChainBinding.spec_id) : '';
  const domainProblem = normalizeText(domainChainBinding?.summary?.problem_statement);
  const goalSimilarityToDomain = computeJaccard(tokenizeText(goal), tokenizeText(domainProblem));

  if (hasBoundDomainSpec && policy.prefer_existing_scene_spec) {
    const shouldDivergeCreate = Boolean(
      policy.allow_new_spec_when_goal_diverges
      && intent.requires_spec
      && goal
      && goalSimilarityToDomain < policy.divergence_similarity_threshold
    );
    if (!shouldDivergeCreate) {
      return {
        action: 'bind_existing',
        reason: 'prefer_existing_scene_spec',
        confidence: 'high',
        spec_id: domainSpecId,
        source: 'scene-domain-chain',
        similarity: goalSimilarityToDomain,
        intent
      };
    }
  }

  if (preferredRelated) {
    return {
      action: 'bind_existing',
      reason: 'related_spec_match',
      confidence: preferredRelated.score >= (policy.related_spec_min_score + 20) ? 'high' : 'medium',
      spec_id: preferredRelated.spec_id,
      source: 'related-spec',
      matched_score: preferredRelated.score,
      intent
    };
  }

  const goalMissing = normalizeText(goal).length === 0;
  const shouldCreateByMissingGoal = goalMissing && policy.goal_missing_strategy === 'create_for_tracking';
  const shouldCreateByIntent = intent.requires_spec || policy.force_spec_for_studio_plan;
  const shouldCreate = policy.auto_create_spec && (shouldCreateByIntent || shouldCreateByMissingGoal);

  if (shouldCreate) {
    return {
      action: 'create_spec',
      reason: goalMissing ? 'goal_missing_tracking' : 'intent_requires_spec',
      confidence: intent.requires_spec ? intent.confidence : 'medium',
      spec_id: null,
      source: 'auto-create',
      intent
    };
  }

  return {
    action: 'none',
    reason: 'no_spec_required',
    confidence: 'low',
    spec_id: null,
    source: 'none',
    intent
  };
}

async function runStudioAutoIntake(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const sceneId = normalizeText(options.scene_id || options.sceneId);
  const goal = normalizeText(options.goal);
  const fromChat = normalizeText(options.from_chat || options.fromChat);
  const explicitSpecId = normalizeText(options.explicit_spec_id || options.spec_id || options.specId);
  const apply = options.apply === true;
  const skip = options.skip === true;

  const loadedPolicy = options.policy && typeof options.policy === 'object'
    ? { policy: normalizeStudioIntakePolicy(options.policy), policy_path: '(inline)', loaded_from: 'inline' }
    : await loadStudioIntakePolicy(projectPath, fileSystem);

  const policy = loadedPolicy.policy;
  const intent = classifyStudioGoalIntent(goal, policy);
  const decision = resolveStudioSpecIntakeDecision({
    goal,
    explicit_spec_id: explicitSpecId,
    domain_chain_binding: options.domain_chain_binding || {},
    related_specs: options.related_specs || {},
    intent
  }, policy);

  const payload = {
    mode: 'studio-auto-intake',
    success: true,
    enabled: policy.enabled === true && !skip,
    policy_path: loadedPolicy.policy_path,
    policy_loaded_from: loadedPolicy.loaded_from,
    policy,
    scene_id: sceneId || null,
    from_chat: fromChat || null,
    goal: goal || null,
    intent,
    decision: {
      ...decision
    },
    selected_spec_id: decision.spec_id || null,
    created_spec: null
  };

  if (skip && policy.allow_manual_spec_override !== true) {
    throw new Error(
      'manual spec override is disabled by studio intake policy (allow_manual_spec_override=false)'
    );
  }

  if (skip) {
    payload.enabled = false;
    payload.decision = {
      action: 'disabled',
      reason: 'manual_override',
      confidence: 'high',
      spec_id: explicitSpecId || null,
      source: explicitSpecId ? 'explicit-spec' : 'none',
      intent
    };
    payload.selected_spec_id = payload.decision.spec_id || null;
    return payload;
  }

  if (decision.action === 'create_spec') {
    const existingSpecIds = await listExistingSpecIds(projectPath, fileSystem);
    const autoSpecId = createAutoSpecId(sceneId, goal, existingSpecIds, policy);
    payload.decision.spec_id = autoSpecId;
    payload.selected_spec_id = autoSpecId;
    if (apply) {
      const createdSpec = await materializeIntakeSpec(projectPath, {
        scene_id: sceneId,
        from_chat: fromChat,
        goal,
        spec_id: autoSpecId
      }, {
        fileSystem
      });
      payload.created_spec = createdSpec;
      payload.decision.created = createdSpec.created === true;
    } else {
      payload.decision.created = false;
    }
    return payload;
  }

  payload.selected_spec_id = decision.spec_id || null;
  return payload;
}

async function readJsonSafe(filePath, fileSystem = fs) {
  if (!await fileSystem.pathExists(filePath)) {
    return null;
  }
  try {
    return await fileSystem.readJson(filePath);
  } catch (_error) {
    return null;
  }
}

async function readFileSafe(filePath, fileSystem = fs) {
  if (!await fileSystem.pathExists(filePath)) {
    return '';
  }
  try {
    return await fileSystem.readFile(filePath, 'utf8');
  } catch (_error) {
    return '';
  }
}

function classifySpecLifecycleState(record = {}, staleDays = 14) {
  const nowMs = Date.now();
  const updatedMs = Date.parse(record.updated_at || 0);
  const ageDays = Number.isFinite(updatedMs)
    ? Number(((nowMs - updatedMs) / (1000 * 60 * 60 * 24)).toFixed(2))
    : null;

  if (record.tasks_total > 0 && record.tasks_done >= record.tasks_total) {
    return {
      state: 'completed',
      age_days: ageDays
    };
  }
  if (ageDays !== null && ageDays > staleDays) {
    return {
      state: 'stale',
      age_days: ageDays
    };
  }
  return {
    state: 'active',
    age_days: ageDays
  };
}

async function scanSpecPortfolio(projectPath = process.cwd(), options = {}, dependencies = {}) {
  const fileSystem = dependencies.fileSystem || fs;
  const specsRoot = path.join(projectPath, '.sce', 'specs');
  if (!await fileSystem.pathExists(specsRoot)) {
    return [];
  }
  const staleDays = normalizeInteger(options.stale_days, 14, 1, 3650);
  const overrideContext = await loadSceneBindingOverrides(projectPath, {
    overridePath: options.override_file || DEFAULT_STUDIO_SCENE_OVERRIDE_PATH
  }, fileSystem);
  const sceneOverrides = normalizeSceneBindingOverrides(overrideContext.overrides || {});
  const entries = await fileSystem.readdir(specsRoot);
  const records = [];

  for (const entry of entries) {
    const specRoot = path.join(specsRoot, entry);
    let stat = null;
    try {
      stat = await fileSystem.stat(specRoot);
    } catch (_error) {
      continue;
    }
    if (!stat || !stat.isDirectory()) {
      continue;
    }

    const domainChainPath = path.join(specRoot, 'custom', 'problem-domain-chain.json');
    const problemContractPath = path.join(specRoot, 'custom', 'problem-contract.json');
    const requirementsPath = path.join(specRoot, 'requirements.md');
    const designPath = path.join(specRoot, 'design.md');
    const tasksPath = path.join(specRoot, 'tasks.md');
    const [chain, contract, requirements, design, tasks] = await Promise.all([
      readJsonSafe(domainChainPath, fileSystem),
      readJsonSafe(problemContractPath, fileSystem),
      readFileSafe(requirementsPath, fileSystem),
      readFileSafe(designPath, fileSystem),
      readFileSafe(tasksPath, fileSystem)
    ]);

    const sceneFromChain = normalizeText(chain && chain.scene_id ? chain.scene_id : '');
    const sceneFromOverride = resolveSceneIdFromOverrides(entry, sceneOverrides);
    const sceneId = sceneFromChain || sceneFromOverride || 'scene.unassigned';
    const sceneSource = sceneFromChain
      ? 'domain-chain'
      : (sceneFromOverride ? 'override' : 'unassigned');
    const problemStatement = normalizeText(
      (chain && chain.problem && chain.problem.statement)
      || (contract && contract.issue_statement)
      || ''
    );
    const taskProgress = parseTasksProgress(tasks);
    const lifecycle = classifySpecLifecycleState({
      updated_at: stat && stat.mtime ? stat.mtime.toISOString() : null,
      tasks_total: taskProgress.total,
      tasks_done: taskProgress.done
    }, staleDays);
    const searchSeed = [
      entry,
      sceneId,
      problemStatement,
      normalizeText(requirements).slice(0, 1600),
      normalizeText(design).slice(0, 1600),
      normalizeText(tasks).slice(0, 1000)
    ].join('\n');
    const tokens = tokenizeText(searchSeed);

    records.push({
      spec_id: entry,
      scene_id: sceneId,
      problem_statement: problemStatement || null,
      updated_at: stat && stat.mtime ? stat.mtime.toISOString() : null,
      tasks_total: taskProgress.total,
      tasks_done: taskProgress.done,
      tasks_progress: taskProgress.ratio,
      lifecycle_state: lifecycle.state,
      age_days: lifecycle.age_days,
      scene_source: sceneSource,
      tokens
    });
  }

  records.sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')));
  return records;
}

function buildSceneGovernanceReport(records = [], policy = DEFAULT_STUDIO_INTAKE_POLICY) {
  const governance = policy.governance || DEFAULT_STUDIO_INTAKE_POLICY.governance;
  const threshold = normalizeNumber(governance.duplicate_similarity_threshold, 0.66);
  const maxActive = normalizeInteger(governance.max_active_specs_per_scene, 3, 1, 200);

  const sceneMap = new Map();
  for (const record of records) {
    const sceneId = normalizeText(record.scene_id) || 'scene.unassigned';
    if (!sceneMap.has(sceneId)) {
      sceneMap.set(sceneId, []);
    }
    sceneMap.get(sceneId).push(record);
  }

  const scenes = [];
  const mergeCandidates = [];
  const archiveCandidates = [];
  let duplicatePairs = 0;

  for (const [sceneId, sceneSpecs] of sceneMap.entries()) {
    const sortedSpecs = [...sceneSpecs].sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')));
    const activeSpecs = sortedSpecs.filter((item) => item.lifecycle_state === 'active');
    const staleSpecs = sortedSpecs.filter((item) => item.lifecycle_state === 'stale');
    const completedSpecs = sortedSpecs.filter((item) => item.lifecycle_state === 'completed');

    const duplicates = [];
    for (let i = 0; i < sortedSpecs.length; i += 1) {
      for (let j = i + 1; j < sortedSpecs.length; j += 1) {
        const left = sortedSpecs[i];
        const right = sortedSpecs[j];
        const similarity = computeJaccard(left.tokens, right.tokens);
        if (similarity >= threshold) {
          duplicatePairs += 1;
          duplicates.push({
            spec_a: left.spec_id,
            spec_b: right.spec_id,
            similarity
          });
          mergeCandidates.push({
            scene_id: sceneId,
            spec_primary: left.spec_id,
            spec_secondary: right.spec_id,
            similarity
          });
        }
      }
    }

    const overflow = activeSpecs.length > maxActive
      ? activeSpecs.slice(maxActive).map((item) => item.spec_id)
      : [];
    for (const specId of overflow) {
      archiveCandidates.push({
        scene_id: sceneId,
        spec_id: specId,
        reason: `active spec count exceeds limit ${maxActive}`
      });
    }

    scenes.push({
      scene_id: sceneId,
      total_specs: sortedSpecs.length,
      active_specs: activeSpecs.length,
      completed_specs: completedSpecs.length,
      stale_specs: staleSpecs.length,
      active_limit: maxActive,
      active_overflow_count: overflow.length,
      active_overflow_specs: overflow,
      duplicate_pairs: duplicates,
      specs: sortedSpecs.map((item) => ({
        spec_id: item.spec_id,
        lifecycle_state: item.lifecycle_state,
        updated_at: item.updated_at,
        age_days: item.age_days,
        tasks_total: item.tasks_total,
        tasks_done: item.tasks_done,
        tasks_progress: item.tasks_progress,
        problem_statement: item.problem_statement
      }))
    });
  }

  scenes.sort((left, right) => {
    if (right.total_specs !== left.total_specs) {
      return right.total_specs - left.total_specs;
    }
    return String(left.scene_id).localeCompare(String(right.scene_id));
  });

  const totalSpecs = records.length;
  const activeTotal = records.filter((item) => item.lifecycle_state === 'active').length;
  const staleTotal = records.filter((item) => item.lifecycle_state === 'stale').length;
  const completedTotal = records.filter((item) => item.lifecycle_state === 'completed').length;
  const overflowScenes = scenes.filter((item) => item.active_overflow_count > 0).length;
  const alertCount = duplicatePairs + overflowScenes + staleTotal;

  return {
    scene_count: scenes.length,
    total_specs: totalSpecs,
    active_specs: activeTotal,
    completed_specs: completedTotal,
    stale_specs: staleTotal,
    duplicate_pairs: duplicatePairs,
    overflow_scenes: overflowScenes,
    alert_count: alertCount,
    status: alertCount > 0 ? 'attention' : 'healthy',
    scenes,
    actions: {
      merge_candidates: mergeCandidates,
      archive_candidates: archiveCandidates
    }
  };
}

function classifyBackfillRule(record = {}, backfillPolicy = {}) {
  const rules = Array.isArray(backfillPolicy.rules) ? backfillPolicy.rules : [];
  const defaultSceneId = normalizeText(backfillPolicy.default_scene_id) || 'scene.sce-core';
  const searchText = [
    normalizeText(record.spec_id).toLowerCase(),
    normalizeText(record.problem_statement).toLowerCase()
  ].join(' ');
  const searchTokens = new Set(tokenizeText(searchText));
  let bestMatch = null;

  for (const rule of rules) {
    const ruleId = normalizeText(rule.id);
    const sceneId = normalizeText(rule.scene_id);
    const keywords = normalizeTextList(rule.keywords).map((item) => item.toLowerCase());
    if (!ruleId || !sceneId || keywords.length === 0) {
      continue;
    }

    const matchedKeywords = [];
    for (const keyword of keywords) {
      if (!keyword) {
        continue;
      }
      if (searchText.includes(keyword) || searchTokens.has(keyword)) {
        matchedKeywords.push(keyword);
      }
    }
    if (matchedKeywords.length === 0) {
      continue;
    }

    const score = matchedKeywords.length;
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = {
        rule_id: ruleId,
        scene_id: sceneId,
        matched_keywords: matchedKeywords,
        score
      };
    }
  }

  if (!bestMatch) {
    return {
      scene_id: defaultSceneId,
      rule_id: 'default',
      matched_keywords: [],
      confidence: 'low',
      source: 'default'
    };
  }

  return {
    scene_id: bestMatch.scene_id,
    rule_id: bestMatch.rule_id,
    matched_keywords: bestMatch.matched_keywords,
    confidence: bestMatch.score >= 2 ? 'high' : 'medium',
    source: 'rule'
  };
}

function clampBackfillLimit(value, fallback = 0, max = 1000) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

async function runStudioSceneBackfill(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const loaded = options.policy && typeof options.policy === 'object'
    ? { policy: normalizeStudioIntakePolicy(options.policy), policy_path: '(inline)', loaded_from: 'inline' }
    : await loadStudioIntakePolicy(projectPath, fileSystem);
  const policy = loaded.policy;
  const backfillPolicy = policy.backfill || DEFAULT_STUDIO_INTAKE_POLICY.backfill;
  const apply = options.apply === true;
  const refreshGovernance = options.refresh_governance !== false && options.refreshGovernance !== false;
  const sourceScene = normalizeText(options.source_scene || options.sourceScene || options.scene) || 'scene.unassigned';
  const includeAll = options.all === true || options.active_only === false || options.activeOnly === false;
  const activeOnly = includeAll ? false : (options.active_only === true || options.activeOnly === true || backfillPolicy.active_only_default !== false);
  const limit = clampBackfillLimit(options.limit, 0, 2000);
  const overrideFile = normalizeText(backfillPolicy.override_file) || DEFAULT_STUDIO_SCENE_OVERRIDE_PATH;

  const records = await scanSpecPortfolio(projectPath, {
    stale_days: policy.governance && policy.governance.stale_days,
    override_file: overrideFile
  }, {
    fileSystem
  });

  let candidates = records.filter((item) => normalizeText(item.scene_id) === sourceScene);
  if (activeOnly) {
    candidates = candidates.filter((item) => item.lifecycle_state === 'active');
  }
  if (limit > 0) {
    candidates = candidates.slice(0, limit);
  }

  const assignmentPlan = candidates.map((record) => {
    const decision = classifyBackfillRule(record, backfillPolicy);
    return {
      spec_id: record.spec_id,
      from_scene_id: sourceScene,
      to_scene_id: decision.scene_id,
      lifecycle_state: record.lifecycle_state,
      rule_id: decision.rule_id,
      source: decision.source,
      confidence: decision.confidence,
      matched_keywords: decision.matched_keywords
    };
  });

  const overrideContext = await loadSceneBindingOverrides(projectPath, {
    overridePath: overrideFile
  }, fileSystem);
  const existingOverrides = normalizeSceneBindingOverrides(overrideContext.overrides || {});
  const nextOverrides = normalizeSceneBindingOverrides(existingOverrides);
  const now = new Date().toISOString();
  let changedCount = 0;

  for (const item of assignmentPlan) {
    const existing = existingOverrides.mappings[item.spec_id];
    const currentScene = normalizeText(existing && existing.scene_id);
    if (currentScene === item.to_scene_id) {
      continue;
    }
    nextOverrides.mappings[item.spec_id] = {
      scene_id: item.to_scene_id,
      source: 'scene-backfill',
      rule_id: item.rule_id,
      updated_at: now
    };
    changedCount += 1;
  }

  const totalsByTargetScene = {};
  for (const item of assignmentPlan) {
    totalsByTargetScene[item.to_scene_id] = (totalsByTargetScene[item.to_scene_id] || 0) + 1;
  }

  const payload = {
    mode: 'studio-scene-backfill',
    success: true,
    generated_at: now,
    policy_path: loaded.policy_path,
    policy_loaded_from: loaded.loaded_from,
    source_scene: sourceScene,
    active_only: activeOnly,
    apply,
    refresh_governance: refreshGovernance,
    override_file: overrideFile,
    summary: {
      candidate_count: assignmentPlan.length,
      changed_count: changedCount,
      target_scene_count: Object.keys(totalsByTargetScene).length
    },
    targets: totalsByTargetScene,
    assignments: assignmentPlan
  };

  if (apply) {
    const overrideAbsolutePath = path.join(projectPath, overrideFile);
    await fileSystem.ensureDir(path.dirname(overrideAbsolutePath));
    const serialized = {
      schema_version: '1.0',
      generated_at: nextOverrides.generated_at || now,
      updated_at: now,
      source: 'studio-scene-backfill',
      mappings: nextOverrides.mappings
    };
    await fileSystem.writeJson(overrideAbsolutePath, serialized, { spaces: 2 });
    payload.override_written = overrideFile;
    if (refreshGovernance) {
      const refreshed = await runStudioSpecGovernance({
        apply: true
      }, {
        projectPath,
        fileSystem
      });
      payload.governance = {
        status: refreshed.summary ? refreshed.summary.status : null,
        alert_count: refreshed.summary ? Number(refreshed.summary.alert_count || 0) : 0,
        report_file: refreshed.report_file || null,
        scene_index_file: refreshed.scene_index_file || null
      };
    }
  }

  return payload;
}

async function runStudioSpecGovernance(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const loaded = options.policy && typeof options.policy === 'object'
    ? { policy: normalizeStudioIntakePolicy(options.policy), policy_path: '(inline)', loaded_from: 'inline' }
    : await loadStudioIntakePolicy(projectPath, fileSystem);
  const policy = loaded.policy;
  const governance = policy.governance || DEFAULT_STUDIO_INTAKE_POLICY.governance;
  const backfill = policy.backfill || DEFAULT_STUDIO_INTAKE_POLICY.backfill;
  const apply = options.apply !== false;
  const sceneFilter = normalizeText(options.scene_id || options.sceneId || options.scene);
  const overrideFile = normalizeText(backfill.override_file) || DEFAULT_STUDIO_SCENE_OVERRIDE_PATH;

  const records = await scanSpecPortfolio(projectPath, {
    stale_days: governance.stale_days,
    override_file: overrideFile
  }, {
    fileSystem
  });

  const filteredRecords = sceneFilter
    ? records.filter((item) => normalizeText(item.scene_id) === sceneFilter)
    : records;

  const summary = buildSceneGovernanceReport(filteredRecords, policy);
  const generatedAt = new Date().toISOString();
  const reportPayload = {
    mode: 'studio-spec-governance',
    success: true,
    generated_at: generatedAt,
    scene_filter: sceneFilter || null,
    policy_path: loaded.policy_path,
    policy_loaded_from: loaded.loaded_from,
    policy: {
      governance,
      backfill: {
        override_file: overrideFile
      }
    },
    summary: {
      scene_count: summary.scene_count,
      total_specs: summary.total_specs,
      active_specs: summary.active_specs,
      completed_specs: summary.completed_specs,
      stale_specs: summary.stale_specs,
      duplicate_pairs: summary.duplicate_pairs,
      overflow_scenes: summary.overflow_scenes,
      alert_count: summary.alert_count,
      status: summary.status
    },
    scenes: summary.scenes,
    actions: summary.actions
  };

  if (apply) {
    const reportPath = path.join(projectPath, DEFAULT_STUDIO_PORTFOLIO_REPORT);
    const indexPath = path.join(projectPath, DEFAULT_STUDIO_SCENE_INDEX);
    await fileSystem.ensureDir(path.dirname(reportPath));
    await fileSystem.writeJson(reportPath, reportPayload, { spaces: 2 });
    const sceneIndex = {
      schema_version: '1.0',
      generated_at: generatedAt,
      scene_filter: sceneFilter || null,
      scenes: {}
    };
    for (const scene of summary.scenes) {
      sceneIndex.scenes[scene.scene_id] = {
        total_specs: scene.total_specs,
        active_specs: scene.active_specs,
        completed_specs: scene.completed_specs,
        stale_specs: scene.stale_specs,
        spec_ids: scene.specs.map((item) => item.spec_id),
        active_spec_ids: scene.specs
          .filter((item) => item.lifecycle_state === 'active')
          .map((item) => item.spec_id),
        stale_spec_ids: scene.specs
          .filter((item) => item.lifecycle_state === 'stale')
          .map((item) => item.spec_id)
      };
    }
    await fileSystem.writeJson(indexPath, sceneIndex, { spaces: 2 });
    reportPayload.report_file = DEFAULT_STUDIO_PORTFOLIO_REPORT;
    reportPayload.scene_index_file = DEFAULT_STUDIO_SCENE_INDEX;
  }

  return reportPayload;
}

module.exports = {
  DEFAULT_STUDIO_INTAKE_POLICY_PATH,
  DEFAULT_STUDIO_INTAKE_POLICY,
  DEFAULT_STUDIO_SCENE_OVERRIDE_PATH,
  DEFAULT_STUDIO_PORTFOLIO_REPORT,
  DEFAULT_STUDIO_SCENE_INDEX,
  normalizeStudioIntakePolicy,
  loadStudioIntakePolicy,
  classifyStudioGoalIntent,
  resolveStudioSpecIntakeDecision,
  createAutoSpecId,
  materializeIntakeSpec,
  runStudioAutoIntake,
  parseTasksProgress,
  scanSpecPortfolio,
  buildSceneGovernanceReport,
  runStudioSceneBackfill,
  runStudioSpecGovernance,
  tokenizeText,
  computeJaccard
};
