/**
 * Orchestrator Configuration Manager
 *
 * Manages `.sce/config/orchestrator.json` for the Agent Orchestrator.
 * When the config file does not exist or contains invalid JSON,
 * returns a default configuration so that orchestration can proceed
 * with sensible defaults.
 *
 * Requirements: 7.1 (read from orchestrator.json), 7.2 (defaults when missing),
 *               7.3 (supported config fields), 7.4 (invalid JSON fallback),
 *               7.5 (unknown fields ignored)
 */

const path = require('path');
const fs = require('fs-extra');
const fsUtils = require('../utils/fs-utils');

const CONFIG_FILENAME = 'orchestrator.json';
const CONFIG_DIR = '.sce/config';

/** Known configuration keys — anything else is silently ignored. */
const KNOWN_KEYS = new Set([
  'agentBackend',
  'maxParallel',
  'timeoutSeconds',
  'maxRetries',
  'rateLimitProfile',
  'rateLimitMaxRetries',
  'rateLimitBackoffBaseMs',
  'rateLimitBackoffMaxMs',
  'rateLimitAdaptiveParallel',
  'rateLimitParallelFloor',
  'rateLimitCooldownMs',
  'rateLimitLaunchBudgetPerMinute',
  'rateLimitLaunchBudgetWindowMs',
  'rateLimitSignalWindowMs',
  'rateLimitSignalThreshold',
  'rateLimitSignalExtraHoldMs',
  'rateLimitDynamicBudgetFloor',
  'rateLimitRetrySpreadMs',
  'rateLimitLaunchHoldPollMs',
  'rateLimitDecisionEventThrottleMs',
  'apiKeyEnvVar',
  'bootstrapTemplate',
  'codexArgs',
  'codexCommand',
]);

const RATE_LIMIT_PROFILE_PRESETS = Object.freeze({
  conservative: Object.freeze({
    rateLimitMaxRetries: 10,
    rateLimitBackoffBaseMs: 2200,
    rateLimitBackoffMaxMs: 90000,
    rateLimitAdaptiveParallel: true,
    rateLimitParallelFloor: 1,
    rateLimitCooldownMs: 60000,
    rateLimitLaunchBudgetPerMinute: 4,
    rateLimitLaunchBudgetWindowMs: 60000,
    rateLimitSignalWindowMs: 45000,
    rateLimitSignalThreshold: 2,
    rateLimitSignalExtraHoldMs: 5000,
    rateLimitDynamicBudgetFloor: 1,
    rateLimitRetrySpreadMs: 1200,
    rateLimitLaunchHoldPollMs: 1000,
    rateLimitDecisionEventThrottleMs: 1000,
  }),
  balanced: Object.freeze({
    rateLimitMaxRetries: 8,
    rateLimitBackoffBaseMs: 1500,
    rateLimitBackoffMaxMs: 60000,
    rateLimitAdaptiveParallel: true,
    rateLimitParallelFloor: 1,
    rateLimitCooldownMs: 45000,
    rateLimitLaunchBudgetPerMinute: 8,
    rateLimitLaunchBudgetWindowMs: 60000,
    rateLimitSignalWindowMs: 30000,
    rateLimitSignalThreshold: 3,
    rateLimitSignalExtraHoldMs: 3000,
    rateLimitDynamicBudgetFloor: 1,
    rateLimitRetrySpreadMs: 600,
    rateLimitLaunchHoldPollMs: 1000,
    rateLimitDecisionEventThrottleMs: 1000,
  }),
  aggressive: Object.freeze({
    rateLimitMaxRetries: 6,
    rateLimitBackoffBaseMs: 1000,
    rateLimitBackoffMaxMs: 30000,
    rateLimitAdaptiveParallel: true,
    rateLimitParallelFloor: 1,
    rateLimitCooldownMs: 20000,
    rateLimitLaunchBudgetPerMinute: 16,
    rateLimitLaunchBudgetWindowMs: 60000,
    rateLimitSignalWindowMs: 20000,
    rateLimitSignalThreshold: 4,
    rateLimitSignalExtraHoldMs: 2000,
    rateLimitDynamicBudgetFloor: 2,
    rateLimitRetrySpreadMs: 250,
    rateLimitLaunchHoldPollMs: 1000,
    rateLimitDecisionEventThrottleMs: 1000,
  }),
});

function resolveRateLimitProfileName(profileName, fallback = 'balanced') {
  const normalized = `${profileName || ''}`.trim().toLowerCase();
  if (normalized && Object.prototype.hasOwnProperty.call(RATE_LIMIT_PROFILE_PRESETS, normalized)) {
    return normalized;
  }
  return fallback;
}

function buildRateLimitProfileConfig(profileName) {
  const resolvedProfile = resolveRateLimitProfileName(profileName, 'balanced');
  const preset = RATE_LIMIT_PROFILE_PRESETS[resolvedProfile] || RATE_LIMIT_PROFILE_PRESETS.balanced;
  return {
    ...preset,
    rateLimitProfile: resolvedProfile,
  };
}

/** @type {import('./orchestrator-config').OrchestratorConfigData} */
const DEFAULT_CONFIG = Object.freeze({
  agentBackend: 'codex',
  maxParallel: 3,
  timeoutSeconds: 600,
  maxRetries: 2,
  rateLimitProfile: 'balanced',
  rateLimitMaxRetries: 8,
  rateLimitBackoffBaseMs: 1500,
  rateLimitBackoffMaxMs: 60000,
  rateLimitAdaptiveParallel: true,
  rateLimitParallelFloor: 1,
  rateLimitCooldownMs: 45000,
  rateLimitLaunchBudgetPerMinute: 8,
  rateLimitLaunchBudgetWindowMs: 60000,
  rateLimitSignalWindowMs: 30000,
  rateLimitSignalThreshold: 3,
  rateLimitSignalExtraHoldMs: 3000,
  rateLimitDynamicBudgetFloor: 1,
  rateLimitRetrySpreadMs: 600,
  rateLimitLaunchHoldPollMs: 1000,
  rateLimitDecisionEventThrottleMs: 1000,
  apiKeyEnvVar: 'CODEX_API_KEY',
  bootstrapTemplate: null,
  codexArgs: [],
  codexCommand: null,
});

class OrchestratorConfig {
  /**
   * @param {string} workspaceRoot - Absolute path to the project root
   */
  constructor(workspaceRoot) {
    this._workspaceRoot = workspaceRoot;
    this._configPath = path.join(workspaceRoot, CONFIG_DIR, CONFIG_FILENAME);
    this._configDir = path.join(workspaceRoot, CONFIG_DIR);
  }

  /**
   * Read the current configuration.
   * Returns the default config when the file is missing or contains invalid JSON.
   * Unknown fields in the file are silently ignored (Requirement 7.5).
   *
   * @returns {Promise<object>} Resolved configuration
   */
  async getConfig() {
    const exists = await fsUtils.pathExists(this._configPath);
    if (!exists) {
      return { ...DEFAULT_CONFIG };
    }

    try {
      const data = await fsUtils.readJSON(this._configPath);
      return this._mergeWithDefaults(data);
    } catch (_err) {
      // Invalid JSON — fall back to defaults (Requirement 7.4)
      console.warn(
        `[OrchestratorConfig] Failed to parse ${this._configPath}, using default config`
      );
      return { ...DEFAULT_CONFIG };
    }
  }

  /**
   * Persist a (partial) configuration update.
   * Merges the provided values with the current config and writes atomically.
   * Auto-initialises the config directory on first write.
   *
   * @param {object} updates - Partial config values to merge
   * @returns {Promise<object>} The full config after the update
   */
  async updateConfig(updates) {
    await fsUtils.ensureDirectory(this._configDir);
    const current = await this.getConfig();
    const filtered = this._filterKnownKeys(updates);
    const merged = { ...current, ...filtered };
    await fsUtils.writeJSON(this._configPath, merged);
    return merged;
  }

  /**
   * Get the bootstrap prompt template.
   * If a custom template path is configured, reads and returns its content.
   * Otherwise returns null (callers should use the built-in default template).
   *
   * @returns {Promise<string|null>} Template content or null
   */
  async getBootstrapTemplate() {
    const config = await this.getConfig();
    if (!config.bootstrapTemplate) {
      return null;
    }

    const templatePath = path.resolve(this._workspaceRoot, config.bootstrapTemplate);
    try {
      return await fs.readFile(templatePath, 'utf8');
    } catch (_err) {
      console.warn(
        `[OrchestratorConfig] Failed to read bootstrap template at ${templatePath}, using default`
      );
      return null;
    }
  }

  /**
   * Merge raw data with defaults, keeping only known keys.
   * @param {object} data - Raw config data from file
   * @returns {object} Merged config with only known keys
   * @private
   */
  _mergeWithDefaults(data) {
    const filtered = this._filterKnownKeys(data);
    const rateLimitProfile = resolveRateLimitProfileName(
      filtered.rateLimitProfile,
      DEFAULT_CONFIG.rateLimitProfile
    );
    const profileDefaults = buildRateLimitProfileConfig(rateLimitProfile);
    return {
      ...DEFAULT_CONFIG,
      ...profileDefaults,
      ...filtered,
      rateLimitProfile,
    };
  }

  /**
   * Filter an object to only include known configuration keys.
   * @param {object} obj
   * @returns {object}
   * @private
   */
  _filterKnownKeys(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return {};
    }
    const result = {};
    for (const key of Object.keys(obj)) {
      if (KNOWN_KEYS.has(key)) {
        result[key] = obj[key];
      }
    }
    return result;
  }

  /** Absolute path to the config file (useful for tests / diagnostics). */
  get configPath() {
    return this._configPath;
  }
}

module.exports = {
  OrchestratorConfig,
  DEFAULT_CONFIG,
  KNOWN_KEYS,
  RATE_LIMIT_PROFILE_PRESETS,
  resolveRateLimitProfileName,
  buildRateLimitProfileConfig,
};
