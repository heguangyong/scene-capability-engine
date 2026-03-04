const path = require('path');
const fs = require('fs-extra');
const {
  DEFAULT_DB_RELATIVE_PATH,
  getSceStateStore,
  buildTaskRef,
  formatSegment
} = require('../state/sce-state-store');

const TASK_REF_PATTERN = /^\d{2,}\.\d{2,}\.\d{2,}$/;

function normalizeId(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function parseTaskRef(taskRef) {
  const normalized = normalizeId(taskRef);
  if (!TASK_REF_PATTERN.test(normalized)) {
    return null;
  }

  const [sceneSegment, specSegment, taskSegment] = normalized.split('.');
  return {
    task_ref: normalized,
    scene_no: Number.parseInt(sceneSegment, 10),
    spec_no: Number.parseInt(specSegment, 10),
    task_no: Number.parseInt(taskSegment, 10)
  };
}

class TaskRefRegistry {
  constructor(projectPath = process.cwd(), options = {}) {
    this.projectPath = projectPath;
    this.fileSystem = options.fileSystem || fs;
    this.stateStore = options.stateStore || getSceStateStore(projectPath, {
      fileSystem: this.fileSystem,
      env: options.env,
      backend: options.backend
    });
  }

  getRegistryPath() {
    return this.stateStore.dbPath || path.join(this.projectPath, DEFAULT_DB_RELATIVE_PATH);
  }

  getRegistryRelativePath() {
    const storeRelativePath = this.stateStore.getStoreRelativePath
      ? this.stateStore.getStoreRelativePath()
      : null;
    if (storeRelativePath) {
      return storeRelativePath;
    }
    return DEFAULT_DB_RELATIVE_PATH.replace(/\\/g, '/');
  }

  async resolveOrCreateRef(options = {}) {
    const sceneId = normalizeId(options.sceneId);
    const specId = normalizeId(options.specId);
    const taskKey = normalizeId(options.taskKey);
    if (!sceneId || !specId || !taskKey) {
      throw new Error('sceneId/specId/taskKey are required for task reference assignment');
    }

    const source = normalizeId(options.source) || 'unknown';
    const metadata = options.metadata && typeof options.metadata === 'object'
      ? { ...options.metadata }
      : {};

    const result = await this.stateStore.resolveOrCreateTaskRef({
      sceneId,
      specId,
      taskKey,
      source,
      metadata
    });

    if (!result) {
      throw new Error('SQLite state backend is unavailable. task_ref assignment requires sqlite support.');
    }

    return {
      ...result,
      registry_path: this.getRegistryRelativePath()
    };
  }

  async lookupByRef(taskRef) {
    const parsed = parseTaskRef(taskRef);
    if (!parsed) {
      return null;
    }

    const result = await this.stateStore.lookupTaskRef(parsed.task_ref);
    if (!result) {
      return null;
    }

    return {
      ...result,
      registry_path: this.getRegistryRelativePath()
    };
  }

  async lookupByTuple(options = {}) {
    const sceneId = normalizeId(options.sceneId);
    const specId = normalizeId(options.specId);
    const taskKey = normalizeId(options.taskKey);
    if (!sceneId || !specId || !taskKey) {
      return null;
    }

    const result = await this.stateStore.lookupTaskTuple({
      sceneId,
      specId,
      taskKey
    });

    if (!result) {
      return null;
    }

    return {
      ...result,
      registry_path: this.getRegistryRelativePath()
    };
  }
}

module.exports = {
  DEFAULT_REGISTRY_RELATIVE_PATH: DEFAULT_DB_RELATIVE_PATH,
  TASK_REF_PATTERN,
  parseTaskRef,
  buildTaskRef,
  formatSegment,
  TaskRefRegistry
};
