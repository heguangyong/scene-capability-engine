const path = require('path');
const fs = require('fs-extra');
const { DOMAIN_CHAIN_RELATIVE_PATH } = require('./domain-modeling');
const {
  loadSceneBindingOverrides,
  resolveSceneIdFromOverrides
} = require('./scene-binding-overrides');

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function clampPositiveInteger(value, fallback, max = 100) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
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

function extractSceneIdFromSceneSpec(markdown) {
  const content = normalizeText(markdown);
  if (!content) {
    return null;
  }
  const match = content.match(/Scene ID:\s*`([^`]+)`/i);
  if (!match || !match[1]) {
    return null;
  }
  return match[1].trim() || null;
}

async function safeReadJson(filePath, fileSystem = fs) {
  if (!await fileSystem.pathExists(filePath)) {
    return null;
  }
  try {
    return await fileSystem.readJson(filePath);
  } catch (_error) {
    return null;
  }
}

async function safeReadFile(filePath, fileSystem = fs) {
  if (!await fileSystem.pathExists(filePath)) {
    return '';
  }
  try {
    return await fileSystem.readFile(filePath, 'utf8');
  } catch (_error) {
    return '';
  }
}

async function resolveSpecSearchEntries(projectPath, fileSystem = fs) {
  const specsRoot = path.join(projectPath, '.sce', 'specs');
  if (!await fileSystem.pathExists(specsRoot)) {
    return [];
  }

  const overrideContext = await loadSceneBindingOverrides(projectPath, {}, fileSystem);
  const overrides = overrideContext.overrides;
  const names = await fileSystem.readdir(specsRoot);
  const entries = [];

  for (const specId of names) {
    const specRoot = path.join(specsRoot, specId);
    let stat = null;
    try {
      stat = await fileSystem.stat(specRoot);
    } catch (_error) {
      continue;
    }
    if (!stat || !stat.isDirectory()) {
      continue;
    }

    const domainChainPath = path.join(specRoot, DOMAIN_CHAIN_RELATIVE_PATH);
    const sceneSpecPath = path.join(specRoot, 'custom', 'scene-spec.md');
    const domainMapPath = path.join(specRoot, 'custom', 'problem-domain-map.md');
    const requirementsPath = path.join(specRoot, 'requirements.md');
    const designPath = path.join(specRoot, 'design.md');

    const [
      domainChain,
      sceneSpecContent,
      domainMapContent,
      requirementsContent,
      designContent
    ] = await Promise.all([
      safeReadJson(domainChainPath, fileSystem),
      safeReadFile(sceneSpecPath, fileSystem),
      safeReadFile(domainMapPath, fileSystem),
      safeReadFile(requirementsPath, fileSystem),
      safeReadFile(designPath, fileSystem)
    ]);

    const sceneId = normalizeText(
      (domainChain && domainChain.scene_id)
      || extractSceneIdFromSceneSpec(sceneSpecContent)
      || resolveSceneIdFromOverrides(specId, overrides)
      || ''
    ) || null;
    const problemStatement = normalizeText(
      (domainChain && domainChain.problem && domainChain.problem.statement) || ''
    ) || null;

    const ontologyText = domainChain && domainChain.ontology
      ? [
        ...(Array.isArray(domainChain.ontology.entity) ? domainChain.ontology.entity : []),
        ...(Array.isArray(domainChain.ontology.relation) ? domainChain.ontology.relation : []),
        ...(Array.isArray(domainChain.ontology.business_rule) ? domainChain.ontology.business_rule : []),
        ...(Array.isArray(domainChain.ontology.decision_policy) ? domainChain.ontology.decision_policy : []),
        ...(Array.isArray(domainChain.ontology.execution_flow) ? domainChain.ontology.execution_flow : [])
      ].join(' ')
      : '';

    const searchableText = [
      specId,
      sceneId || '',
      problemStatement || '',
      ontologyText,
      sceneSpecContent.slice(0, 4000),
      domainMapContent.slice(0, 3000),
      requirementsContent.slice(0, 3000),
      designContent.slice(0, 3000)
    ].join('\n');

    entries.push({
      spec_id: specId,
      scene_id: sceneId,
      problem_statement: problemStatement,
      updated_at: stat.mtime ? stat.mtime.toISOString() : null,
      searchable_text: searchableText.toLowerCase()
    });
  }

  return entries;
}

function calculateSpecRelevance(entry, queryTokens = [], sceneId = '') {
  let score = 0;
  const reasons = [];
  const matchedTokens = [];
  const normalizedSceneId = normalizeText(sceneId).toLowerCase();
  const entrySceneId = normalizeText(entry.scene_id).toLowerCase();
  const haystack = entry.searchable_text || '';

  if (normalizedSceneId && entrySceneId) {
    if (entrySceneId === normalizedSceneId) {
      score += 90;
      reasons.push('scene_exact');
    } else if (entrySceneId.includes(normalizedSceneId) || normalizedSceneId.includes(entrySceneId)) {
      score += 35;
      reasons.push('scene_partial');
    }
  }

  for (const token of queryTokens) {
    if (!token || token.length < 2) {
      continue;
    }
    if (haystack.includes(token)) {
      score += 9;
      matchedTokens.push(token);
    }
  }

  if (matchedTokens.length > 0) {
    reasons.push('query_overlap');
  }

  return {
    score,
    reasons,
    matched_tokens: Array.from(new Set(matchedTokens)).slice(0, 20)
  };
}

async function buildDerivedQueryFromSpec(projectPath, specId, fileSystem = fs) {
  const specs = await resolveSpecSearchEntries(projectPath, fileSystem);
  const selected = specs.find((item) => item.spec_id === specId);
  if (!selected) {
    return '';
  }
  return [
    selected.problem_statement || '',
    selected.scene_id || '',
    selected.spec_id || ''
  ].join(' ').trim();
}

async function findRelatedSpecs(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const limit = clampPositiveInteger(options.limit, 5, 50);
  const sceneId = normalizeText(options.sceneId || options.scene);
  const excludeSpecId = normalizeText(options.excludeSpecId);
  const sourceSpecId = normalizeText(options.sourceSpecId || options.spec);

  let query = normalizeText(options.query);
  if (!query && sourceSpecId) {
    query = await buildDerivedQueryFromSpec(projectPath, sourceSpecId, fileSystem);
  }

  const queryTokens = tokenizeText(query);
  const entries = await resolveSpecSearchEntries(projectPath, fileSystem);
  const ranked = [];

  for (const entry of entries) {
    if (excludeSpecId && entry.spec_id === excludeSpecId) {
      continue;
    }
    const relevance = calculateSpecRelevance(entry, queryTokens, sceneId);
    if (relevance.score <= 0) {
      continue;
    }
    ranked.push({
      spec_id: entry.spec_id,
      scene_id: entry.scene_id,
      problem_statement: entry.problem_statement,
      updated_at: entry.updated_at,
      score: relevance.score,
      reasons: relevance.reasons,
      matched_tokens: relevance.matched_tokens
    });
  }

  ranked.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return String(right.updated_at || '').localeCompare(String(left.updated_at || ''));
  });

  return {
    mode: 'spec-related',
    success: true,
    query: query || '',
    scene_id: sceneId || null,
    source_spec_id: sourceSpecId || null,
    total_candidates: ranked.length,
    related_specs: ranked.slice(0, limit)
  };
}

module.exports = {
  tokenizeText,
  resolveSpecSearchEntries,
  calculateSpecRelevance,
  findRelatedSpecs
};
