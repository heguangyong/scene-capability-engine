const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { getSceStateStore } = require('../state/sce-state-store');

const DEFAULT_WRITE_AUTH_POLICY_PATH = '.sce/config/authorization-policy.json';
const DEFAULT_WRITE_AUTH_POLICY = Object.freeze({
  enabled: false,
  enforce_actions: ['studio:apply', 'studio:release', 'studio:rollback', 'task:rerun'],
  default_ttl_minutes: 15,
  max_ttl_minutes: 120,
  require_password_for_grant: true,
  require_password_for_revoke: false,
  password_env: 'SCE_AUTH_PASSWORD',
  default_scope: ['project:*'],
  allow_test_bypass: true,
  allow_password_as_inline_lease: false
});

function normalizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = normalizeString(`${value}`).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(`${value}`, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeStringArray(value, fallback = []) {
  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => normalizeString(item))
      .filter(Boolean);
    return normalized.length > 0 ? normalized : [...fallback];
  }

  const text = normalizeString(value);
  if (!text) {
    return [...fallback];
  }
  const split = text
    .split(/[,\s]+/g)
    .map((item) => normalizeString(item))
    .filter(Boolean);
  return split.length > 0 ? split : [...fallback];
}

function normalizeScopeList(value, fallback = ['project:*']) {
  const normalized = normalizeStringArray(value, fallback)
    .map((item) => item.toLowerCase())
    .map((item) => item.replace(/\s+/g, ''))
    .filter(Boolean);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : [...fallback];
}

function nowIso() {
  return new Date().toISOString();
}

function resolveActor(env = process.env) {
  const preferred = normalizeString(env.SCE_AUTH_ACTOR)
    || normalizeString(env.SCE_AUTH_SUBJECT)
    || normalizeString(env.USERNAME)
    || normalizeString(env.USER);
  if (preferred) {
    return preferred;
  }

  try {
    return normalizeString(os.userInfo().username) || 'unknown';
  } catch (_error) {
    return 'unknown';
  }
}

function scopeMatchesAction(scope, action) {
  const normalizedScope = normalizeString(scope).toLowerCase();
  const normalizedAction = normalizeString(action).toLowerCase();
  if (!normalizedScope || !normalizedAction) {
    return false;
  }
  if (normalizedScope === '*' || normalizedScope === 'project:*') {
    return true;
  }
  if (normalizedScope === normalizedAction) {
    return true;
  }
  if (normalizedScope.endsWith(':*')) {
    const prefix = normalizedScope.slice(0, -1);
    return normalizedAction.startsWith(prefix);
  }
  if (normalizedScope.endsWith('*')) {
    const prefix = normalizedScope.slice(0, -1);
    return normalizedAction.startsWith(prefix);
  }
  return false;
}

function hasScopeForAction(scopeList = [], action = '') {
  const normalizedScopes = normalizeScopeList(scopeList, []);
  if (normalizedScopes.length === 0) {
    return false;
  }
  return normalizedScopes.some((scope) => scopeMatchesAction(scope, action));
}

function normalizeWriteAuthPolicy(rawPolicy = {}) {
  const enabled = normalizeBoolean(rawPolicy.enabled, DEFAULT_WRITE_AUTH_POLICY.enabled);
  const enforceActions = normalizeScopeList(
    rawPolicy.enforce_actions,
    DEFAULT_WRITE_AUTH_POLICY.enforce_actions
  );
  const defaultScope = normalizeScopeList(
    rawPolicy.default_scope,
    DEFAULT_WRITE_AUTH_POLICY.default_scope
  );
  const defaultTtlMinutes = normalizeInteger(
    rawPolicy.default_ttl_minutes,
    DEFAULT_WRITE_AUTH_POLICY.default_ttl_minutes
  );
  const maxTtlMinutes = Math.max(
    normalizeInteger(rawPolicy.max_ttl_minutes, DEFAULT_WRITE_AUTH_POLICY.max_ttl_minutes),
    defaultTtlMinutes
  );

  return {
    enabled,
    enforce_actions: enforceActions,
    default_ttl_minutes: defaultTtlMinutes,
    max_ttl_minutes: maxTtlMinutes,
    require_password_for_grant: normalizeBoolean(
      rawPolicy.require_password_for_grant,
      DEFAULT_WRITE_AUTH_POLICY.require_password_for_grant
    ),
    require_password_for_revoke: normalizeBoolean(
      rawPolicy.require_password_for_revoke,
      DEFAULT_WRITE_AUTH_POLICY.require_password_for_revoke
    ),
    password_env: normalizeString(rawPolicy.password_env) || DEFAULT_WRITE_AUTH_POLICY.password_env,
    default_scope: defaultScope,
    allow_test_bypass: normalizeBoolean(
      rawPolicy.allow_test_bypass,
      DEFAULT_WRITE_AUTH_POLICY.allow_test_bypass
    ),
    allow_password_as_inline_lease: normalizeBoolean(
      rawPolicy.allow_password_as_inline_lease,
      DEFAULT_WRITE_AUTH_POLICY.allow_password_as_inline_lease
    )
  };
}

function applyPolicyEnvOverrides(policy = {}, env = process.env) {
  const overrideEnabled = normalizeString(env.SCE_AUTH_REQUIRE_LEASE);
  const overridePasswordEnv = normalizeString(env.SCE_AUTH_PASSWORD_ENV);
  const overrideEnforceActions = normalizeString(env.SCE_AUTH_ENFORCE_ACTIONS);
  const overrideDefaultTtl = normalizeString(env.SCE_AUTH_DEFAULT_TTL_MINUTES);
  const overrideMaxTtl = normalizeString(env.SCE_AUTH_MAX_TTL_MINUTES);

  return normalizeWriteAuthPolicy({
    ...policy,
    enabled: overrideEnabled ? normalizeBoolean(overrideEnabled, policy.enabled) : policy.enabled,
    password_env: overridePasswordEnv || policy.password_env,
    enforce_actions: overrideEnforceActions
      ? normalizeScopeList(overrideEnforceActions, policy.enforce_actions)
      : policy.enforce_actions,
    default_ttl_minutes: overrideDefaultTtl
      ? normalizeInteger(overrideDefaultTtl, policy.default_ttl_minutes)
      : policy.default_ttl_minutes,
    max_ttl_minutes: overrideMaxTtl
      ? normalizeInteger(overrideMaxTtl, policy.max_ttl_minutes)
      : policy.max_ttl_minutes,
    require_password_for_grant: normalizeString(env.SCE_AUTH_REQUIRE_PASSWORD_FOR_GRANT)
      ? normalizeBoolean(env.SCE_AUTH_REQUIRE_PASSWORD_FOR_GRANT, policy.require_password_for_grant)
      : policy.require_password_for_grant,
    require_password_for_revoke: normalizeString(env.SCE_AUTH_REQUIRE_PASSWORD_FOR_REVOKE)
      ? normalizeBoolean(env.SCE_AUTH_REQUIRE_PASSWORD_FOR_REVOKE, policy.require_password_for_revoke)
      : policy.require_password_for_revoke,
    allow_test_bypass: normalizeString(env.SCE_AUTH_ALLOW_TEST_BYPASS)
      ? normalizeBoolean(env.SCE_AUTH_ALLOW_TEST_BYPASS, policy.allow_test_bypass)
      : policy.allow_test_bypass,
    allow_password_as_inline_lease: normalizeString(env.SCE_AUTH_INLINE_PASSWORD_LEASE)
      ? normalizeBoolean(env.SCE_AUTH_INLINE_PASSWORD_LEASE, policy.allow_password_as_inline_lease)
      : policy.allow_password_as_inline_lease
  });
}

function sanitizePolicyForOutput(policy = {}) {
  return {
    enabled: policy.enabled === true,
    enforce_actions: normalizeScopeList(policy.enforce_actions, DEFAULT_WRITE_AUTH_POLICY.enforce_actions),
    default_ttl_minutes: normalizeInteger(policy.default_ttl_minutes, DEFAULT_WRITE_AUTH_POLICY.default_ttl_minutes),
    max_ttl_minutes: normalizeInteger(policy.max_ttl_minutes, DEFAULT_WRITE_AUTH_POLICY.max_ttl_minutes),
    require_password_for_grant: policy.require_password_for_grant === true,
    require_password_for_revoke: policy.require_password_for_revoke === true,
    password_env: normalizeString(policy.password_env) || DEFAULT_WRITE_AUTH_POLICY.password_env,
    default_scope: normalizeScopeList(policy.default_scope, DEFAULT_WRITE_AUTH_POLICY.default_scope),
    allow_test_bypass: policy.allow_test_bypass === true,
    allow_password_as_inline_lease: policy.allow_password_as_inline_lease === true
  };
}

async function loadWriteAuthorizationPolicy(projectPath = process.cwd(), fileSystem = fs, env = process.env) {
  const policyPath = path.join(projectPath, DEFAULT_WRITE_AUTH_POLICY_PATH);
  let filePolicy = {};

  if (await fileSystem.pathExists(policyPath)) {
    try {
      filePolicy = await fileSystem.readJson(policyPath);
    } catch (error) {
      throw new Error(`Failed to read write authorization policy: ${error.message}`);
    }
  }

  const merged = normalizeWriteAuthPolicy({
    ...DEFAULT_WRITE_AUTH_POLICY,
    ...(filePolicy || {})
  });
  const normalized = applyPolicyEnvOverrides(merged, env);

  return {
    policy: normalized,
    policy_path: DEFAULT_WRITE_AUTH_POLICY_PATH
  };
}

function shouldEnforceAction(policy = {}, action = '', options = {}) {
  if (options.requireAuth === true) {
    return true;
  }
  if (policy.enabled !== true) {
    return false;
  }
  return hasScopeForAction(policy.enforce_actions || [], action);
}

function resolveStore(projectPath, dependencies = {}) {
  return getSceStateStore(projectPath, {
    fileSystem: dependencies.fileSystem || fs,
    env: dependencies.env || process.env,
    sqliteModule: dependencies.sqliteModule
  });
}

function ensureLeaseActive(lease = {}, now = nowIso()) {
  if (!lease || typeof lease !== 'object') {
    return { ok: false, reason: 'lease_not_found' };
  }
  if (normalizeString(lease.revoked_at)) {
    return { ok: false, reason: 'lease_revoked' };
  }
  const expiresAt = Date.parse(normalizeString(lease.expires_at));
  const nowTs = Date.parse(normalizeString(now));
  if (!Number.isFinite(expiresAt) || !Number.isFinite(nowTs) || expiresAt <= nowTs) {
    return { ok: false, reason: 'lease_expired' };
  }
  return { ok: true, reason: '' };
}

async function appendAuthAuditEvent(stateStore, payload = {}) {
  const appended = await stateStore.appendAuthEvent(payload);
  if (!appended) {
    throw new Error('Failed to persist authorization audit event into sqlite state store');
  }
}

function ensurePolicyPassword(options = {}, dependencies = {}, policy = {}, actionLabel = 'grant') {
  const env = dependencies.env || process.env;
  const passwordEnv = normalizeString(policy.password_env) || DEFAULT_WRITE_AUTH_POLICY.password_env;
  const expected = normalizeString(dependencies.authSecret || env[passwordEnv]);
  if (!expected) {
    throw new Error(
      `Authorization policy requires password for ${actionLabel}, but ${passwordEnv} is not configured`
    );
  }

  const provided = normalizeString(options.authPassword);
  if (!provided) {
    throw new Error(`Authorization password required for ${actionLabel}. Provide --auth-password`);
  }
  if (provided !== expected) {
    throw new Error(`Authorization password check failed for ${actionLabel}`);
  }

  return passwordEnv;
}

function normalizeTtlMinutes(ttlValue, policy = {}) {
  const defaultTtl = normalizeInteger(policy.default_ttl_minutes, DEFAULT_WRITE_AUTH_POLICY.default_ttl_minutes);
  const maxTtl = normalizeInteger(policy.max_ttl_minutes, DEFAULT_WRITE_AUTH_POLICY.max_ttl_minutes);
  const requested = normalizeInteger(ttlValue, defaultTtl);
  return Math.min(Math.max(requested, 1), Math.max(maxTtl, 1));
}

async function grantWriteAuthorizationLease(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;
  const loadedPolicy = await loadWriteAuthorizationPolicy(projectPath, fileSystem, env);
  const policy = loadedPolicy.policy;

  let passwordEnv = null;
  if (policy.require_password_for_grant) {
    passwordEnv = ensurePolicyPassword(options, dependencies, policy, 'auth grant');
  }

  const ttlMinutes = normalizeTtlMinutes(options.ttlMinutes || options.ttl_minutes, policy);
  const actor = normalizeString(options.actor) || resolveActor(env);
  const subject = normalizeString(options.subject) || actor;
  const role = normalizeString(options.role) || 'maintainer';
  const scope = normalizeScopeList(options.scope, policy.default_scope);
  const reason = normalizeString(options.reason) || 'manual-auth-grant';
  const metadata = options.metadata && typeof options.metadata === 'object'
    ? { ...options.metadata }
    : {};

  const stateStore = resolveStore(projectPath, { ...dependencies, fileSystem, env });
  const lease = await stateStore.issueAuthLease({
    subject,
    role,
    scope,
    reason,
    metadata: {
      ...metadata,
      actor,
      source: metadata.source || 'sce auth grant'
    },
    ttl_minutes: ttlMinutes
  });
  if (!lease) {
    throw new Error('SQLite state backend unavailable while issuing auth lease');
  }

  await appendAuthAuditEvent(stateStore, {
    event_type: 'lease.granted',
    action: 'auth:grant',
    actor,
    lease_id: lease.lease_id,
    result: 'allow',
    target: subject,
    detail: {
      role,
      scope,
      reason,
      ttl_minutes: ttlMinutes
    }
  });

  return {
    success: true,
    policy: sanitizePolicyForOutput(policy),
    policy_path: loadedPolicy.policy_path,
    password_env: passwordEnv,
    lease,
    store_path: stateStore.getStoreRelativePath()
  };
}

async function revokeWriteAuthorizationLease(leaseId, options = {}, dependencies = {}) {
  const normalizedLeaseId = normalizeString(leaseId);
  if (!normalizedLeaseId) {
    throw new Error('lease id is required');
  }

  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;
  const loadedPolicy = await loadWriteAuthorizationPolicy(projectPath, fileSystem, env);
  const policy = loadedPolicy.policy;

  if (policy.require_password_for_revoke) {
    ensurePolicyPassword(options, dependencies, policy, 'auth revoke');
  }

  const actor = normalizeString(options.actor) || resolveActor(env);
  const reason = normalizeString(options.reason) || 'manual-auth-revoke';
  const stateStore = resolveStore(projectPath, { ...dependencies, fileSystem, env });

  const lease = await stateStore.revokeAuthLease(normalizedLeaseId);
  if (!lease) {
    throw new Error(`Auth lease not found: ${normalizedLeaseId}`);
  }

  await appendAuthAuditEvent(stateStore, {
    event_type: 'lease.revoked',
    action: 'auth:revoke',
    actor,
    lease_id: normalizedLeaseId,
    result: 'allow',
    target: lease.subject || null,
    detail: {
      reason
    }
  });

  return {
    success: true,
    policy: sanitizePolicyForOutput(policy),
    policy_path: loadedPolicy.policy_path,
    lease,
    store_path: stateStore.getStoreRelativePath()
  };
}

async function ensureWriteAuthorization(action, options = {}, dependencies = {}) {
  const normalizedAction = normalizeString(action).toLowerCase();
  if (!normalizedAction) {
    throw new Error('write authorization action is required');
  }

  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;
  const loadedPolicy = await loadWriteAuthorizationPolicy(projectPath, fileSystem, env);
  const policy = loadedPolicy.policy;
  const enforce = shouldEnforceAction(policy, normalizedAction, options);

  if (!enforce) {
    return {
      required: false,
      passed: true,
      action: normalizedAction,
      policy: sanitizePolicyForOutput(policy),
      policy_path: loadedPolicy.policy_path
    };
  }

  if (policy.allow_test_bypass && normalizeString(env.NODE_ENV).toLowerCase() === 'test') {
    return {
      required: true,
      passed: true,
      bypassed: 'test-env',
      action: normalizedAction,
      policy: sanitizePolicyForOutput(policy),
      policy_path: loadedPolicy.policy_path
    };
  }

  const actor = normalizeString(options.actor) || resolveActor(env);
  const stateStore = resolveStore(projectPath, { ...dependencies, fileSystem, env });
  let leaseId = normalizeString(options.authLease || options.authLeaseId);

  if (!leaseId && policy.allow_password_as_inline_lease && normalizeString(options.authPassword)) {
    const granted = await grantWriteAuthorizationLease({
      subject: actor,
      role: 'maintainer',
      scope: [normalizedAction],
      reason: `inline-auth:${normalizedAction}`,
      authPassword: options.authPassword,
      metadata: {
        source: `inline:${normalizedAction}`
      }
    }, {
      projectPath,
      fileSystem,
      env,
      authSecret: dependencies.authSecret
    });
    leaseId = normalizeString(granted?.lease?.lease_id);
  }

  if (!leaseId) {
    await appendAuthAuditEvent(stateStore, {
      event_type: 'authorization.denied',
      action: normalizedAction,
      actor,
      result: 'deny',
      detail: {
        reason: 'lease_required'
      }
    });
    throw new Error(
      `Write authorization required for ${normalizedAction}. Run: sce auth grant --scope ${normalizedAction} --reason "<reason>"`
    );
  }

  const lease = await stateStore.getAuthLease(leaseId);
  if (!lease) {
    await appendAuthAuditEvent(stateStore, {
      event_type: 'authorization.denied',
      action: normalizedAction,
      actor,
      lease_id: leaseId,
      result: 'deny',
      detail: {
        reason: 'lease_not_found'
      }
    });
    throw new Error(`Write authorization denied for ${normalizedAction}: lease not found (${leaseId})`);
  }

  const active = ensureLeaseActive(lease, nowIso());
  if (!active.ok) {
    await appendAuthAuditEvent(stateStore, {
      event_type: 'authorization.denied',
      action: normalizedAction,
      actor,
      lease_id: leaseId,
      result: 'deny',
      target: lease.subject || null,
      detail: {
        reason: active.reason
      }
    });
    throw new Error(`Write authorization denied for ${normalizedAction}: ${active.reason}`);
  }

  if (!hasScopeForAction(lease.scope || [], normalizedAction)) {
    await appendAuthAuditEvent(stateStore, {
      event_type: 'authorization.denied',
      action: normalizedAction,
      actor,
      lease_id: leaseId,
      result: 'deny',
      target: lease.subject || null,
      detail: {
        reason: 'scope_mismatch',
        scope: lease.scope || []
      }
    });
    throw new Error(`Write authorization denied for ${normalizedAction}: scope mismatch`);
  }

  await appendAuthAuditEvent(stateStore, {
    event_type: 'authorization.allowed',
    action: normalizedAction,
    actor,
    lease_id: leaseId,
    result: 'allow',
    target: lease.subject || null,
    detail: {
      scope: lease.scope || [],
      expires_at: lease.expires_at || null
    }
  });

  return {
    required: true,
    passed: true,
    action: normalizedAction,
    lease_id: lease.lease_id,
    lease_subject: lease.subject || null,
    lease_role: lease.role || null,
    lease_scope: Array.isArray(lease.scope) ? [...lease.scope] : [],
    lease_expires_at: lease.expires_at || null,
    policy: sanitizePolicyForOutput(policy),
    policy_path: loadedPolicy.policy_path,
    store_path: stateStore.getStoreRelativePath()
  };
}

async function getWriteAuthorizationLease(leaseId, dependencies = {}) {
  const normalizedLeaseId = normalizeString(leaseId);
  if (!normalizedLeaseId) {
    return null;
  }

  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;
  const stateStore = resolveStore(projectPath, { ...dependencies, fileSystem, env });
  return stateStore.getAuthLease(normalizedLeaseId);
}

async function collectWriteAuthorizationStatus(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;
  const loadedPolicy = await loadWriteAuthorizationPolicy(projectPath, fileSystem, env);
  const stateStore = resolveStore(projectPath, { ...dependencies, fileSystem, env });

  const activeOnly = options.activeOnly !== false;
  const limit = normalizeInteger(options.limit, 20);
  const eventsLimit = normalizeInteger(options.eventsLimit, 20);

  const leases = await stateStore.listAuthLeases({
    activeOnly,
    limit
  });
  const events = await stateStore.listAuthEvents({
    limit: eventsLimit
  });

  if (leases === null || events === null) {
    throw new Error('SQLite state backend unavailable while reading authorization status');
  }

  return {
    success: true,
    policy: sanitizePolicyForOutput(loadedPolicy.policy),
    policy_path: loadedPolicy.policy_path,
    leases,
    events,
    store_path: stateStore.getStoreRelativePath()
  };
}

module.exports = {
  DEFAULT_WRITE_AUTH_POLICY,
  DEFAULT_WRITE_AUTH_POLICY_PATH,
  normalizeWriteAuthPolicy,
  loadWriteAuthorizationPolicy,
  grantWriteAuthorizationLease,
  revokeWriteAuthorizationLease,
  ensureWriteAuthorization,
  collectWriteAuthorizationStatus,
  getWriteAuthorizationLease,
  hasScopeForAction
};
