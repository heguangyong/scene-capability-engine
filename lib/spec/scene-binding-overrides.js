const path = require('path');
const fs = require('fs-extra');

const DEFAULT_SPEC_SCENE_OVERRIDE_PATH = '.sce/spec-governance/spec-scene-overrides.json';

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeOverrideEntry(specId, payload = {}) {
  const normalizedSpecId = normalizeText(specId);
  if (!normalizedSpecId) {
    return null;
  }

  if (typeof payload === 'string') {
    const sceneId = normalizeText(payload);
    if (!sceneId) {
      return null;
    }
    return {
      spec_id: normalizedSpecId,
      scene_id: sceneId,
      source: 'override',
      rule_id: null,
      updated_at: null
    };
  }

  const sceneId = normalizeText(payload && payload.scene_id);
  if (!sceneId) {
    return null;
  }
  return {
    spec_id: normalizedSpecId,
    scene_id: sceneId,
    source: normalizeText(payload.source) || 'override',
    rule_id: normalizeText(payload.rule_id) || null,
    updated_at: normalizeText(payload.updated_at) || null
  };
}

function normalizeSceneBindingOverrides(raw = {}) {
  const payload = raw && typeof raw === 'object' ? raw : {};
  const mappingsRaw = payload.mappings && typeof payload.mappings === 'object'
    ? payload.mappings
    : {};
  const mappings = {};
  for (const [specId, entry] of Object.entries(mappingsRaw)) {
    const normalized = normalizeOverrideEntry(specId, entry);
    if (!normalized) {
      continue;
    }
    mappings[normalized.spec_id] = {
      scene_id: normalized.scene_id,
      source: normalized.source,
      rule_id: normalized.rule_id,
      updated_at: normalized.updated_at
    };
  }
  return {
    schema_version: normalizeText(payload.schema_version) || '1.0',
    generated_at: normalizeText(payload.generated_at) || null,
    updated_at: normalizeText(payload.updated_at) || null,
    mappings
  };
}

async function loadSceneBindingOverrides(projectPath = process.cwd(), options = {}, fileSystem = fs) {
  const overridePath = normalizeText(options.override_path || options.overridePath)
    || DEFAULT_SPEC_SCENE_OVERRIDE_PATH;
  const absolutePath = path.join(projectPath, overridePath);
  let payload = {};
  let loadedFrom = 'default';
  if (await fileSystem.pathExists(absolutePath)) {
    try {
      payload = await fileSystem.readJson(absolutePath);
      loadedFrom = 'file';
    } catch (_error) {
      payload = {};
      loadedFrom = 'default';
    }
  }
  return {
    override_path: overridePath,
    absolute_path: absolutePath,
    loaded_from: loadedFrom,
    overrides: normalizeSceneBindingOverrides(payload)
  };
}

function resolveSceneIdFromOverrides(specId, overrides = {}) {
  const normalizedSpecId = normalizeText(specId);
  if (!normalizedSpecId) {
    return null;
  }
  const mappings = overrides && typeof overrides === 'object' && overrides.mappings
    ? overrides.mappings
    : {};
  const entry = mappings[normalizedSpecId];
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  return normalizeText(entry.scene_id) || null;
}

module.exports = {
  DEFAULT_SPEC_SCENE_OVERRIDE_PATH,
  normalizeSceneBindingOverrides,
  loadSceneBindingOverrides,
  resolveSceneIdFromOverrides
};
