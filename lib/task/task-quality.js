const fs = require('fs-extra');
const path = require('path');
const TaskClaimer = require('./task-claimer');

const DEFAULT_TASK_GOVERNANCE_DIR = '.sce/task-governance';
const DEFAULT_DRAFTS_FILE = 'drafts.json';
const DEFAULT_SCHEMA_VERSION = '1.0';

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

function toNonNegativeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(`${value}`, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function toPositiveInteger(value, fallback = 1) {
  const parsed = Number.parseInt(`${value}`, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function buildDraftId() {
  const now = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `draft-${now}-${random}`;
}

function splitGoals(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return [];
  }
  const separators = /[;；\n]|(?:\s+and\s+)|(?:\s+then\s+)|(?:\s+also\s+)|(?:\s+plus\s+)|、|，|,|并且|同时|然后|以及|并/;
  const parts = normalized.split(separators).map((item) => normalizeText(item)).filter(Boolean);
  if (parts.length <= 1) {
    return parts;
  }
  const unique = [];
  for (const part of parts) {
    if (!unique.some((item) => item === part)) {
      unique.push(part);
    }
  }
  return unique;
}

function normalizeTitle(text) {
  const goals = splitGoals(text);
  const base = goals.length > 0 ? goals[0] : normalizeText(text);
  if (!base) {
    return 'Untitled task';
  }
  return base.length > 120 ? `${base.slice(0, 117)}...` : base;
}

function buildDraft(rawRequest, options = {}) {
  const now = new Date().toISOString();
  const normalizedRaw = normalizeText(rawRequest);
  const goals = splitGoals(normalizedRaw);
  const subGoals = goals.length > 1 ? goals.slice(1, 4) : [];
  const needsSplit = goals.length > 1;
  const acceptanceCriteria = normalizeStringArray(options.acceptance_criteria);
  const confidenceBase = options.confidence !== undefined
    ? Number(options.confidence)
    : 0.55;
  const confidence = Math.max(0.1, Math.min(0.95, confidenceBase + (acceptanceCriteria.length > 0 ? 0.1 : -0.05)));

  return {
    draft_id: buildDraftId(),
    scene_id: normalizeText(options.scene_id),
    spec_id: normalizeText(options.spec_id),
    raw_request: normalizedRaw,
    title_norm: normalizeTitle(normalizedRaw),
    goal: goals.length > 0 ? goals[0] : normalizedRaw,
    sub_goals: subGoals,
    acceptance_criteria: acceptanceCriteria,
    needs_split: needsSplit,
    confidence,
    status: 'draft',
    created_at: now,
    updated_at: now
  };
}

function scoreDraft(draft) {
  const issues = [];
  const goal = normalizeText(draft.goal);
  const title = normalizeText(draft.title_norm);
  const acceptance = normalizeStringArray(draft.acceptance_criteria);
  const needsSplit = Boolean(draft.needs_split);

  let clarity = 100;
  if (!title || title.length < 4) {
    clarity -= 30;
    issues.push('title too short or missing');
  }
  if (needsSplit) {
    clarity -= 25;
    issues.push('multiple goals detected; split required');
  }

  let verifiability = 90;
  if (acceptance.length === 0) {
    verifiability = 45;
    issues.push('acceptance criteria missing');
  }

  let executability = goal ? 85 : 40;
  if (!goal) {
    issues.push('goal missing');
  }
  if (!normalizeText(draft.spec_id)) {
    executability -= 20;
    issues.push('spec_id missing');
  }

  let risk = 40;
  if (needsSplit) {
    risk = 65;
  }

  clarity = Math.max(0, Math.min(100, Math.round(clarity)));
  verifiability = Math.max(0, Math.min(100, Math.round(verifiability)));
  executability = Math.max(0, Math.min(100, Math.round(executability)));
  risk = Math.max(0, Math.min(100, Math.round(risk)));

  const overall = Math.round(
    (clarity * 0.3)
    + (verifiability * 0.3)
    + (executability * 0.3)
    + ((100 - risk) * 0.1)
  );

  const passed = overall >= 70 && acceptance.length > 0 && !needsSplit;

  return {
    score: overall,
    passed,
    breakdown: {
      clarity,
      verifiability,
      executability,
      risk
    },
    issues
  };
}

async function loadDraftStore(projectPath, fileSystem = fs) {
  const storePath = path.join(projectPath, DEFAULT_TASK_GOVERNANCE_DIR, DEFAULT_DRAFTS_FILE);
  if (!await fileSystem.pathExists(storePath)) {
    return {
      path: storePath,
      payload: {
        schema_version: DEFAULT_SCHEMA_VERSION,
        updated_at: new Date().toISOString(),
        drafts: []
      }
    };
  }

  const payload = await fileSystem.readJson(storePath);
  return {
    path: storePath,
    payload: payload && typeof payload === 'object'
      ? payload
      : {
          schema_version: DEFAULT_SCHEMA_VERSION,
          updated_at: new Date().toISOString(),
          drafts: []
        }
  };
}

async function saveDraftStore(store, fileSystem = fs) {
  const next = {
    schema_version: store.payload.schema_version || DEFAULT_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
    drafts: Array.isArray(store.payload.drafts) ? store.payload.drafts : []
  };
  await fileSystem.ensureDir(path.dirname(store.path));
  await fileSystem.writeJson(store.path, next, { spaces: 2 });
  return { path: store.path, payload: next };
}

async function appendDraft(projectPath, draft, fileSystem = fs) {
  const store = await loadDraftStore(projectPath, fileSystem);
  store.payload.drafts = Array.isArray(store.payload.drafts) ? store.payload.drafts : [];
  store.payload.drafts.push(draft);
  await saveDraftStore(store, fileSystem);
  return { draft, store: store.payload, store_path: store.path };
}

async function updateDraft(projectPath, draftId, updater, fileSystem = fs) {
  const store = await loadDraftStore(projectPath, fileSystem);
  const drafts = Array.isArray(store.payload.drafts) ? store.payload.drafts : [];
  const index = drafts.findIndex((item) => item.draft_id === draftId);
  if (index < 0) {
    return null;
  }
  const updated = updater({ ...drafts[index] });
  updated.updated_at = new Date().toISOString();
  drafts[index] = updated;
  store.payload.drafts = drafts;
  await saveDraftStore(store, fileSystem);
  return updated;
}

function consolidateDraftGroup(group) {
  const merged = { ...group[0] };
  const now = new Date().toISOString();
  merged.status = 'consolidated';
  merged.updated_at = now;
  const rawRequests = group.map((item) => normalizeText(item.raw_request)).filter(Boolean);
  const subGoals = group.flatMap((item) => normalizeStringArray(item.sub_goals));
  const acceptance = group.flatMap((item) => normalizeStringArray(item.acceptance_criteria));
  merged.raw_request = rawRequests.join(' | ');
  merged.sub_goals = Array.from(new Set(subGoals));
  merged.acceptance_criteria = Array.from(new Set(acceptance));
  merged.needs_split = merged.sub_goals.length > 0;
  return merged;
}

async function consolidateDrafts(projectPath, options = {}, fileSystem = fs) {
  const store = await loadDraftStore(projectPath, fileSystem);
  const drafts = Array.isArray(store.payload.drafts) ? store.payload.drafts : [];
  const sceneId = normalizeText(options.scene_id);
  const specId = normalizeText(options.spec_id);

  const candidates = drafts.filter((draft) => {
    if (sceneId && normalizeText(draft.scene_id) !== sceneId) {
      return false;
    }
    if (specId && normalizeText(draft.spec_id) !== specId) {
      return false;
    }
    return draft.status === 'draft' || draft.status === 'consolidated';
  });

  const groups = new Map();
  candidates.forEach((draft) => {
    const key = normalizeTitle(draft.raw_request || draft.title_norm);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(draft);
  });

  const mergedDrafts = [];
  const mergedLog = [];
  for (const [key, group] of groups.entries()) {
    if (group.length === 1) {
      mergedDrafts.push(group[0]);
      continue;
    }
    const merged = consolidateDraftGroup(group);
    mergedDrafts.push(merged);
    mergedLog.push({
      title_norm: key,
      draft_ids: group.map((item) => item.draft_id),
      merged_id: merged.draft_id
    });
  }

  const untouched = drafts.filter((draft) => {
    if (sceneId && normalizeText(draft.scene_id) !== sceneId) {
      return true;
    }
    if (specId && normalizeText(draft.spec_id) !== specId) {
      return true;
    }
    return false;
  });

  store.payload.drafts = [...untouched, ...mergedDrafts];
  await saveDraftStore(store, fileSystem);

  return {
    merged: mergedLog,
    drafts: mergedDrafts,
    store_path: store.path
  };
}

function parseTaskIdValue(taskId) {
  if (!taskId) {
    return 0;
  }
  const token = `${taskId}`.split('.')[0];
  return toNonNegativeInteger(token, 0);
}

async function promoteDraftToTasks(projectPath, draft, fileSystem = fs) {
  const specId = normalizeText(draft.spec_id);
  if (!specId) {
    throw new Error('spec_id is required to promote draft to tasks.md');
  }
  const tasksPath = path.join(projectPath, '.sce', 'specs', specId, 'tasks.md');
  if (!await fileSystem.pathExists(tasksPath)) {
    throw new Error(`tasks.md not found: ${tasksPath}`);
  }

  const claimer = new TaskClaimer();
  const tasks = await claimer.parseTasks(tasksPath);
  const maxId = tasks.reduce((max, task) => {
    const value = parseTaskIdValue(task.taskId);
    return Math.max(max, value);
  }, 0);
  const nextId = maxId + 1;
  const title = normalizeText(draft.title_norm) || normalizeText(draft.goal) || 'New task';
  const line = `- [ ] ${nextId}. ${title}`;

  const content = await fileSystem.readFile(tasksPath, 'utf8');
  const nextContent = content.trimEnd() + '\n' + line + '\n';
  await fileSystem.writeFile(tasksPath, nextContent, 'utf8');

  return {
    task_id: `${nextId}`,
    tasks_path: tasksPath
  };
}

module.exports = {
  DEFAULT_TASK_GOVERNANCE_DIR,
  DEFAULT_DRAFTS_FILE,
  buildDraft,
  scoreDraft,
  loadDraftStore,
  saveDraftStore,
  appendDraft,
  updateDraft,
  consolidateDrafts,
  promoteDraftToTasks
};
