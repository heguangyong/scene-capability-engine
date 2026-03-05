/**
 * Orchestration Engine — Batch Scheduling Engine (Core)
 *
 * Coordinates all orchestrator components: builds dependency graphs via
 * DependencyManager, computes topological batches, spawns agents via
 * AgentSpawner, tracks status via StatusMonitor, and integrates with
 * SpecLifecycleManager and AgentRegistry.
 *
 * Requirements: 3.1-3.7 (dependency graph, batches, parallel, failure propagation)
 *               5.1-5.6 (crash detection, retry, timeout, graceful stop, deregister)
 *               8.1-8.5 (SLM transitions, AgentRegistry, TaskLockManager, CSM sync)
 */

const { EventEmitter } = require('events');
const path = require('path');
const fsUtils = require('../utils/fs-utils');

const SPECS_DIR = '.sce/specs';
const DEFAULT_RATE_LIMIT_MAX_RETRIES = 8;
const DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS = 1500;
const DEFAULT_RATE_LIMIT_BACKOFF_MAX_MS = 60000;
const DEFAULT_RATE_LIMIT_ADAPTIVE_PARALLEL = true;
const DEFAULT_RATE_LIMIT_PARALLEL_FLOOR = 1;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 45000;
const DEFAULT_RATE_LIMIT_LAUNCH_BUDGET_PER_MINUTE = 8;
const DEFAULT_RATE_LIMIT_LAUNCH_BUDGET_WINDOW_MS = 60000;
const DEFAULT_RATE_LIMIT_SIGNAL_WINDOW_MS = 30000;
const DEFAULT_RATE_LIMIT_SIGNAL_THRESHOLD = 3;
const DEFAULT_RATE_LIMIT_SIGNAL_EXTRA_HOLD_MS = 3000;
const DEFAULT_RATE_LIMIT_DYNAMIC_BUDGET_FLOOR = 1;
const DEFAULT_RATE_LIMIT_RETRY_SPREAD_MS = 600;
const DEFAULT_RATE_LIMIT_LAUNCH_HOLD_POLL_MS = 1000;
const DEFAULT_RATE_LIMIT_DECISION_EVENT_THROTTLE_MS = 1000;
const MAX_RATE_LIMIT_RETRY_SPREAD_MS = 60000;
const DEFAULT_AGENT_WAIT_TIMEOUT_SECONDS = 600;
const AGENT_WAIT_TIMEOUT_GRACE_MS = 30000;
const RATE_LIMIT_BACKOFF_JITTER_RATIO = 0.5;
const RATE_LIMIT_RETRY_AFTER_MAX_MS = 10 * 60 * 1000;
const RATE_LIMIT_ERROR_PATTERNS = [
  /(^|[^0-9])429([^0-9]|$)/i,
  /too many requests/i,
  /rate[\s-]?limit/i,
  /resource exhausted/i,
  /quota exceeded/i,
  /exceeded.*quota/i,
  /exceeded retry limit/i,
  /requests per minute/i,
  /tokens per minute/i,
];
const DEFAULT_COORDINATION_POLICY_RELATIVE_PATH = path.join(
  'docs',
  'agent-runtime',
  'multi-agent-coordination-policy-baseline.json'
);
const DEFAULT_RESULT_SUMMARY_REQUIRED_FIELDS = [
  'spec_id',
  'changed_files',
  'tests_run',
  'tests_passed',
  'risk_level',
  'open_issues'
];
const DEFAULT_COORDINATION_RULES = {
  require_result_summary: false,
  block_merge_on_failed_tests: true,
  block_merge_on_unresolved_conflicts: true
};
const VALID_RESULT_RISK_LEVELS = new Set(['low', 'medium', 'high', 'unknown']);

class OrchestrationEngine extends EventEmitter {
  /**
   * @param {string} workspaceRoot - Absolute path to the project root
   * @param {object} options
   * @param {import('./agent-spawner').AgentSpawner} options.agentSpawner
   * @param {import('../collab/dependency-manager')} options.dependencyManager
   * @param {import('../collab/spec-lifecycle-manager').SpecLifecycleManager} options.specLifecycleManager
   * @param {import('./status-monitor').StatusMonitor} options.statusMonitor
   * @param {import('./orchestrator-config').OrchestratorConfig} options.orchestratorConfig
   * @param {import('../collab/agent-registry').AgentRegistry} options.agentRegistry
   */
  constructor(workspaceRoot, options) {
    super();
    this._workspaceRoot = workspaceRoot;
    this._agentSpawner = options.agentSpawner;
    this._dependencyManager = options.dependencyManager;
    this._specLifecycleManager = options.specLifecycleManager;
    this._statusMonitor = options.statusMonitor;
    this._orchestratorConfig = options.orchestratorConfig;
    this._agentRegistry = options.agentRegistry;

    /** @type {'idle'|'running'|'completed'|'failed'|'stopped'} */
    this._state = 'idle';
    /** @type {Map<string, string>} specName → agentId */
    this._runningAgents = new Map();
    /** @type {Map<string, number>} specName → retry count */
    this._retryCounts = new Map();
    /** @type {Set<string>} specs marked as final failure */
    this._failedSpecs = new Set();
    /** @type {Set<string>} specs skipped due to dependency failure */
    this._skippedSpecs = new Set();
    /** @type {Set<string>} specs completed successfully */
    this._completedSpecs = new Set();
    /** @type {boolean} whether stop() has been called */
    this._stopped = false;
    /** @type {object|null} execution plan */
    this._executionPlan = null;
    /** @type {number} max retries for rate-limit failures */
    this._rateLimitMaxRetries = DEFAULT_RATE_LIMIT_MAX_RETRIES;
    /** @type {number} base delay for rate-limit retries */
    this._rateLimitBackoffBaseMs = DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS;
    /** @type {number} max delay for rate-limit retries */
    this._rateLimitBackoffMaxMs = DEFAULT_RATE_LIMIT_BACKOFF_MAX_MS;
    /** @type {boolean} enable adaptive parallel throttling on rate-limit signals */
    this._rateLimitAdaptiveParallel = DEFAULT_RATE_LIMIT_ADAPTIVE_PARALLEL;
    /** @type {number} minimum effective parallelism during rate-limit cooldown */
    this._rateLimitParallelFloor = DEFAULT_RATE_LIMIT_PARALLEL_FLOOR;
    /** @type {number} cooldown before each adaptive parallel recovery step */
    this._rateLimitCooldownMs = DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    /** @type {number|null} configured max parallel for current run */
    this._baseMaxParallel = null;
    /** @type {number|null} dynamic effective parallel limit for current run */
    this._effectiveMaxParallel = null;
    /** @type {number} timestamp after which recovery can step up */
    this._rateLimitCooldownUntil = 0;
    /** @type {number} timestamp before which new launches are paused after rate-limit */
    this._rateLimitLaunchHoldUntil = 0;
    /** @type {number} max spec launches allowed within rolling launch-budget window */
    this._rateLimitLaunchBudgetPerMinute = DEFAULT_RATE_LIMIT_LAUNCH_BUDGET_PER_MINUTE;
    /** @type {number} rolling window size for launch-budget throttling */
    this._rateLimitLaunchBudgetWindowMs = DEFAULT_RATE_LIMIT_LAUNCH_BUDGET_WINDOW_MS;
    /** @type {number|null} dynamic launch budget per minute derived from recent rate-limit pressure */
    this._dynamicLaunchBudgetPerMinute = null;
    /** @type {number[]} timestamps (ms) of recent rate-limit signals for spike detection */
    this._rateLimitSignalTimestamps = [];
    /** @type {number} rolling window for rate-limit spike detection */
    this._rateLimitSignalWindowMs = DEFAULT_RATE_LIMIT_SIGNAL_WINDOW_MS;
    /** @type {number} number of rate-limit signals inside window that triggers escalation */
    this._rateLimitSignalThreshold = DEFAULT_RATE_LIMIT_SIGNAL_THRESHOLD;
    /** @type {number} additional launch hold applied per escalation step */
    this._rateLimitSignalExtraHoldMs = DEFAULT_RATE_LIMIT_SIGNAL_EXTRA_HOLD_MS;
    /** @type {number} minimum dynamic launch budget floor under sustained pressure */
    this._rateLimitDynamicBudgetFloor = DEFAULT_RATE_LIMIT_DYNAMIC_BUDGET_FLOOR;
    /** @type {number} deterministic per-spec retry spread to prevent synchronized retry bursts */
    this._rateLimitRetrySpreadMs = DEFAULT_RATE_LIMIT_RETRY_SPREAD_MS;
    /** @type {number} polling interval while launch hold is active */
    this._rateLimitLaunchHoldPollMs = DEFAULT_RATE_LIMIT_LAUNCH_HOLD_POLL_MS;
    /** @type {number} minimum interval between repeated rate-limit decision events */
    this._rateLimitDecisionEventThrottleMs = DEFAULT_RATE_LIMIT_DECISION_EVENT_THROTTLE_MS;
    /** @type {number[]} timestamps (ms) of recent spec launches for rolling budget accounting */
    this._rateLimitLaunchTimestamps = [];
    /** @type {number} last launch-budget hold telemetry emission timestamp (ms) */
    this._launchBudgetLastHoldSignalAt = 0;
    /** @type {number} last launch-budget hold duration emitted to telemetry (ms) */
    this._launchBudgetLastHoldMs = 0;
    /** @type {number} last rate-limit decision event emission timestamp (ms) */
    this._lastRateLimitDecisionAt = 0;
    /** @type {string} dedupe key for last rate-limit decision event */
    this._lastRateLimitDecisionKey = '';
    /** @type {Set<{timer: NodeJS.Timeout|null, resolve: (() => void)|null}>} cancellable sleep waiters */
    this._pendingSleeps = new Set();
    /** @type {number} fallback wait timeout to avoid indefinite hangs when lifecycle events are missing */
    this._agentWaitTimeoutMs = (DEFAULT_AGENT_WAIT_TIMEOUT_SECONDS * 1000) + AGENT_WAIT_TIMEOUT_GRACE_MS;
    /** @type {() => number} */
    this._random = typeof options.random === 'function' ? options.random : Math.random;
    /** @type {() => number} */
    this._now = typeof options.now === 'function' ? options.now : Date.now;
    /** @type {{ require_result_summary: boolean, block_merge_on_failed_tests: boolean, block_merge_on_unresolved_conflicts: boolean }} */
    this._coordinationRules = { ...DEFAULT_COORDINATION_RULES };
    /** @type {string[]} */
    this._resultSummaryRequiredFields = [...DEFAULT_RESULT_SUMMARY_REQUIRED_FIELDS];
    /** @type {Map<string, object>} */
    this._resultSummaries = new Map();
    /** @type {string} */
    this._coordinationPolicyPath = DEFAULT_COORDINATION_POLICY_RELATIVE_PATH;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start orchestration execution.
   *
   * 1. Validate spec existence
   * 2. Build dependency graph via DependencyManager (Req 3.1, 3.7)
   * 3. Detect circular dependencies (Req 3.2)
   * 4. Compute batches via topological sort (Req 3.3)
   * 5. Execute batches sequentially, specs within batch in parallel (Req 3.4, 3.5)
   *
   * @param {string[]} specNames - Specs to orchestrate
   * @param {object} [options]
   * @param {number} [options.maxParallel] - Override max parallel from config
   * @param {object} [options.configOverrides] - Runtime config overrides for this execution only
   * @returns {Promise<object>} OrchestrationResult
   */
  async start(specNames, options = {}) {
    if (this._state === 'running') {
      throw new Error('Orchestration is already running');
    }

    this._reset();
    this._state = 'running';
    this._stopped = false;
    this._statusMonitor.setOrchestrationState('running');

    try {
      // Step 1: Validate spec existence (Req 6.4)
      const missingSpecs = await this._validateSpecExistence(specNames);
      if (missingSpecs.length > 0) {
        const error = `Specs not found: ${missingSpecs.join(', ')}`;
        this._state = 'failed';
        this._statusMonitor.setOrchestrationState('failed');
        return this._buildResult('failed', error);
      }

      // Step 2: Build dependency graph (Req 3.1, 3.7)
      const graph = await this._dependencyManager.buildDependencyGraph(specNames);

      // Step 3: Detect circular dependencies (Req 3.2)
      const cyclePath = this._dependencyManager.detectCircularDependencies(graph);
      if (cyclePath) {
        const error = `Circular dependency detected: ${cyclePath.join(' → ')}`;
        this._state = 'failed';
        this._statusMonitor.setOrchestrationState('failed');
        this._executionPlan = {
          specs: specNames,
          batches: [],
          dependencies: this._extractDependencies(graph, specNames),
          hasCycle: true,
          cyclePath,
        };
        return this._buildResult('failed', error);
      }

      // Step 4: Compute batches (Req 3.3)
      const dependencies = this._extractDependencies(graph, specNames);
      const batches = this._computeBatches(specNames, dependencies);

      this._executionPlan = {
        specs: specNames,
        batches,
        dependencies,
        hasCycle: false,
        cyclePath: null,
      };

      // Initialize specs in StatusMonitor
      for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        for (const specName of batches[batchIdx]) {
          this._statusMonitor.initSpec(specName, batchIdx);
        }
      }
      this._statusMonitor.setBatchInfo(0, batches.length);

      // Get config for maxParallel and maxRetries
      const config = await this._orchestratorConfig.getConfig();
      const configOverrides = options && typeof options.configOverrides === 'object' && !Array.isArray(options.configOverrides)
        ? options.configOverrides
        : null;
      const effectiveConfig = configOverrides
        ? { ...config, ...configOverrides }
        : config;

      this._applyRetryPolicyConfig(effectiveConfig);
      await this._applyCoordinationPolicyConfig(effectiveConfig);
      this._agentWaitTimeoutMs = this._resolveAgentWaitTimeoutMs(effectiveConfig);
      const maxParallel = options.maxParallel || effectiveConfig.maxParallel || 3;
      const maxRetries = effectiveConfig.maxRetries || 2;
      this._initializeAdaptiveParallel(maxParallel);

      // Step 5: Execute batches (Req 3.4)
      await this._executeBatches(batches, maxParallel, maxRetries);

      // Determine final state
      if (this._stopped) {
        this._state = 'stopped';
        this._statusMonitor.setOrchestrationState('stopped');
      } else if (this._failedSpecs.size > 0) {
        this._state = 'failed';
        this._statusMonitor.setOrchestrationState('failed');
      } else {
        this._state = 'completed';
        this._statusMonitor.setOrchestrationState('completed');
      }

      this.emit('orchestration:complete', this._buildResult(this._state));
      return this._buildResult(this._state);
    } catch (err) {
      this._state = 'failed';
      this._statusMonitor.setOrchestrationState('failed');
      return this._buildResult('failed', err.message);
    }
  }

  /**
   * Gracefully stop all running agents and halt orchestration (Req 5.5).
   * @returns {Promise<void>}
   */
  async stop() {
    this._stopped = true;
    this._cancelPendingSleeps();

    if (this._state !== 'running') {
      return;
    }

    // Kill all running agents
    await this._agentSpawner.killAll();

    // Mark running specs as stopped
    for (const [specName] of this._runningAgents) {
      this._statusMonitor.updateSpecStatus(specName, 'skipped', null, 'Orchestration stopped');
    }
    this._runningAgents.clear();

    this._state = 'stopped';
    this._statusMonitor.setOrchestrationState('stopped');
  }

  /**
   * Get current orchestration status.
   * @returns {object} OrchestrationStatus
   */
  getStatus() {
    return this._statusMonitor.getOrchestrationStatus();
  }

  // ---------------------------------------------------------------------------
  // Batch Execution
  // ---------------------------------------------------------------------------

  /**
   * Execute all batches sequentially.
   * Within each batch, specs run in parallel up to maxParallel.
   *
   * @param {string[][]} batches
   * @param {number} maxParallel
   * @param {number} maxRetries
   * @returns {Promise<void>}
   * @private
   */
  async _executeBatches(batches, maxParallel, maxRetries) {
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      if (this._stopped) break;

      const batch = batches[batchIdx];
      this._statusMonitor.setBatchInfo(batchIdx + 1, batches.length);

      // Filter out skipped specs (dependency failures)
      const executableSpecs = batch.filter(s => !this._skippedSpecs.has(s));

      if (executableSpecs.length === 0) {
        continue;
      }

      this.emit('batch:start', { batch: batchIdx, specs: executableSpecs });

      // Execute specs in parallel with maxParallel limit
      await this._executeSpecsInParallel(executableSpecs, maxParallel, maxRetries);

      this.emit('batch:complete', {
        batch: batchIdx,
        completed: executableSpecs.filter(s => this._completedSpecs.has(s)),
        failed: executableSpecs.filter(s => this._failedSpecs.has(s)),
        skipped: executableSpecs.filter(s => this._skippedSpecs.has(s)),
      });
    }
  }

  /**
   * Execute a set of specs in parallel, respecting maxParallel limit (Req 3.5).
   *
   * @param {string[]} specNames
   * @param {number} maxParallel
   * @param {number} maxRetries
   * @returns {Promise<void>}
   * @private
   */
  async _executeSpecsInParallel(specNames, maxParallel, maxRetries) {
    const pending = [...specNames];
    const inFlight = new Map(); // specName → Promise

    const launchNext = async () => {
      while (pending.length > 0 && !this._stopped) {
        const rateLimitHoldMs = this._getRateLimitLaunchHoldRemainingMs();
        const launchBudgetHoldMs = this._getLaunchBudgetHoldRemainingMs();
        const launchHoldMs = Math.max(rateLimitHoldMs, launchBudgetHoldMs);
        if (launchHoldMs > 0) {
          // Pause new launches when provider asks us to retry later or launch budget is exhausted.
          const holdReason = launchBudgetHoldMs >= rateLimitHoldMs
            ? 'launch-budget'
            : 'rate-limit-retry-hold';
          if (launchBudgetHoldMs > 0) {
            this._onLaunchBudgetHold(launchBudgetHoldMs);
          }
          const launchHoldPollMs = this._toPositiveInteger(
            this._rateLimitLaunchHoldPollMs,
            DEFAULT_RATE_LIMIT_LAUNCH_HOLD_POLL_MS
          );
          const holdSleepMs = Math.max(1, Math.min(launchHoldMs, launchHoldPollMs));
          this._emitRateLimitDecision('launch-hold', {
            reason: holdReason,
            holdMs: launchHoldMs,
            sleepMs: holdSleepMs,
            pendingSpecs: pending.length,
            inFlightSpecs: inFlight.size,
            effectiveMaxParallel: this._toPositiveInteger(
              this._effectiveMaxParallel,
              this._toPositiveInteger(maxParallel, 1)
            ),
          });
          await this._sleep(holdSleepMs);
          continue;
        }

        if (inFlight.size >= this._getEffectiveMaxParallel(maxParallel)) {
          break;
        }

        const specName = pending.shift();
        if (this._skippedSpecs.has(specName)) continue;

        this._recordLaunchStart();
        const promise = this._executeSpec(specName, maxRetries);
        inFlight.set(specName, promise);

        // When done, remove from inFlight and try to launch more
        promise.then(() => {
          inFlight.delete(specName);
        });
      }
    };

    // Initial launch
    await launchNext();

    // Wait for all in-flight specs to complete, launching new ones as slots open
    while (inFlight.size > 0 && !this._stopped) {
      // Wait for any one to complete
      await Promise.race(inFlight.values());
      // Launch more if slots available
      await launchNext();
    }
  }

  // ---------------------------------------------------------------------------
  // Single Spec Execution
  // ---------------------------------------------------------------------------

  /**
   * Execute a single spec with retry support (Req 5.2, 5.3).
   *
   * @param {string} specName
   * @param {number} maxRetries
   * @returns {Promise<void>}
   * @private
   */
  async _executeSpec(specName, maxRetries) {
    if (this._stopped) return;

    this._retryCounts.set(specName, this._retryCounts.get(specName) || 0);

    // Transition to assigned then in-progress via SLM (Req 8.1)
    await this._transitionSafe(specName, 'assigned');
    await this._transitionSafe(specName, 'in-progress');

    this._statusMonitor.updateSpecStatus(specName, 'running');
    this.emit('spec:start', { specName });

    try {
      // Spawn agent via AgentSpawner
      const agent = await this._agentSpawner.spawn(specName);
      this._runningAgents.set(specName, agent.agentId);

      // Wait for agent completion
      const result = await this._waitForAgent(specName, agent.agentId);

      this._runningAgents.delete(specName);

      if (result.status === 'completed') {
        await this._handleSpecCompleted(specName, agent.agentId);
      } else {
        // failed or timeout (Req 5.1, 5.4)
        await this._handleSpecFailed(specName, agent.agentId, maxRetries, result.error);
      }
    } catch (err) {
      // Spawn failure (Req 5.1)
      this._runningAgents.delete(specName);
      await this._handleSpecFailed(specName, null, maxRetries, err.message);
    }
  }

  /**
   * Wait for an agent to complete, fail, or timeout.
   * Returns a promise that resolves with the outcome.
   *
   * @param {string} specName
   * @param {string} agentId
   * @returns {Promise<{status: string, error: string|null}>}
   * @private
   */
  _waitForAgent(specName, agentId) {
    return new Promise((resolve) => {
      const fallbackTimeoutMs = this._toPositiveInteger(
        this._agentWaitTimeoutMs,
        (DEFAULT_AGENT_WAIT_TIMEOUT_SECONDS * 1000) + AGENT_WAIT_TIMEOUT_GRACE_MS
      );
      let settled = false;
      let fallbackTimer = null;

      const finalize = (payload) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(payload);
      };

      const onCompleted = (data) => {
        if (data.agentId === agentId) {
          finalize({ status: 'completed', error: null });
        }
      };

      const onFailed = (data) => {
        if (data.agentId === agentId) {
          const error = data.stderr || data.error || `Exit code: ${data.exitCode}`;
          finalize({ status: 'failed', error });
        }
      };

      const onTimeout = (data) => {
        if (data.agentId === agentId) {
          finalize({ status: 'timeout', error: `Timeout after ${data.timeoutSeconds}s` });
        }
      };

      const cleanup = () => {
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        this._agentSpawner.removeListener('agent:completed', onCompleted);
        this._agentSpawner.removeListener('agent:failed', onFailed);
        this._agentSpawner.removeListener('agent:timeout', onTimeout);
      };

      this._agentSpawner.on('agent:completed', onCompleted);
      this._agentSpawner.on('agent:failed', onFailed);
      this._agentSpawner.on('agent:timeout', onTimeout);

      fallbackTimer = setTimeout(() => {
        finalize({
          status: 'timeout',
          error: (
            `Agent wait timeout after ${Math.ceil(fallbackTimeoutMs / 1000)}s for ` +
            `${specName} (${agentId}) without lifecycle events`
          ),
        });
      }, fallbackTimeoutMs);
    });
  }

  /**
   * Handle successful spec completion (Req 8.2, 5.6).
   *
   * @param {string} specName
   * @param {string} agentId
   * @returns {Promise<void>}
   * @private
   */
  async _handleSpecCompleted(specName, agentId) {
    const summaryValidation = this._resolveAndValidateResultSummary(specName, agentId);
    if (!summaryValidation.valid) {
      await this._handleSummaryContractViolation(
        specName,
        agentId,
        summaryValidation.message,
        summaryValidation
      );
      return;
    }

    const mergeDecision = this._evaluateMergeDecision(summaryValidation.summary);
    if (!mergeDecision.allowed) {
      await this._handleSummaryContractViolation(
        specName,
        agentId,
        `merge blocked by result summary policy: ${mergeDecision.reasons.join('; ')}`,
        {
          valid: true,
          summary: summaryValidation.summary,
          issues: mergeDecision.reasons
        }
      );
      return;
    }

    this._resultSummaries.set(specName, { ...summaryValidation.summary });
    this._completedSpecs.add(specName);
    this._statusMonitor.updateSpecStatus(specName, 'completed', agentId);

    // Transition to completed via SLM (Req 8.2)
    await this._transitionSafe(specName, 'completed');

    // Sync external status (Req 8.5)
    await this._syncExternalSafe(specName, 'completed');

    this.emit('spec:complete', {
      specName,
      agentId,
      result_summary: summaryValidation.summary,
      merge_decision: 'accepted'
    });
  }

  /**
   * Handle spec failure — retry or propagate (Req 5.2, 5.3, 3.6).
   *
   * @param {string} specName
   * @param {string|null} agentId
   * @param {number} maxRetries
   * @param {string} error
   * @returns {Promise<void>}
   * @private
   */
  async _handleSpecFailed(specName, agentId, maxRetries, error) {
    const resolvedError = `${error || 'Unknown error'}`;
    const retryCount = this._retryCounts.get(specName) || 0;
    const isRateLimitError = this._isRateLimitError(resolvedError);
    const retryLimit = isRateLimitError
      ? Math.max(maxRetries, this._rateLimitMaxRetries || DEFAULT_RATE_LIMIT_MAX_RETRIES)
      : maxRetries;

    if (retryCount < retryLimit && !this._stopped) {
      // Retry (Req 5.2)
      this._retryCounts.set(specName, retryCount + 1);
      this._statusMonitor.incrementRetry(specName);
      this._statusMonitor.updateSpecStatus(specName, 'pending', null, resolvedError);

      const retryPlan = isRateLimitError
        ? this._buildRateLimitRetryPlan(specName, retryCount, resolvedError)
        : null;
      const retryDelayMs = retryPlan ? retryPlan.totalDelayMs : 0;
      if (retryDelayMs > 0) {
        this._onRateLimitSignal(retryDelayMs);
        const launchHoldMs = this._getRateLimitLaunchHoldRemainingMs();
        this._updateStatusMonitorRateLimit({
          specName,
          retryCount,
          retryDelayMs,
          retryBaseDelayMs: retryPlan ? retryPlan.baseDelayMs : retryDelayMs,
          retryHintMs: retryPlan ? retryPlan.retryAfterHintMs : 0,
          retryBackoffMs: retryPlan ? retryPlan.computedBackoffMs : retryDelayMs,
          retrySpreadMs: retryPlan ? retryPlan.spreadDelayMs : 0,
          launchHoldMs,
          error: resolvedError,
        });
        this._emitRateLimitDecision('retry', {
          reason: 'rate-limit-retry',
          specName,
          retryCount,
          retryDelayMs,
          retryBaseDelayMs: retryPlan ? retryPlan.baseDelayMs : retryDelayMs,
          retryHintMs: retryPlan ? retryPlan.retryAfterHintMs : 0,
          retryBackoffMs: retryPlan ? retryPlan.computedBackoffMs : retryDelayMs,
          retrySpreadMs: retryPlan ? retryPlan.spreadDelayMs : 0,
          launchHoldMs,
          pendingRetryCount: this._retryCounts.get(specName) || 0,
        });
        this.emit('spec:rate-limited', {
          specName,
          retryCount,
          retryDelayMs,
          retryBaseDelayMs: retryPlan ? retryPlan.baseDelayMs : retryDelayMs,
          retryHintMs: retryPlan ? retryPlan.retryAfterHintMs : 0,
          retryBackoffMs: retryPlan ? retryPlan.computedBackoffMs : retryDelayMs,
          retrySpreadMs: retryPlan ? retryPlan.spreadDelayMs : 0,
          launchHoldMs,
          error: resolvedError,
        });
        await this._sleep(retryDelayMs);
        if (this._stopped) {
          return;
        }
      }

      // Re-execute
      await this._executeSpec(specName, maxRetries);
    } else {
      // Final failure (Req 5.3)
      this._failedSpecs.add(specName);
      this._statusMonitor.updateSpecStatus(specName, 'failed', agentId, resolvedError);
      if (isRateLimitError) {
        this._emitRateLimitDecision('retry-exhausted', {
          reason: 'rate-limit-retry-budget-exhausted',
          specName,
          retryCount,
          retryLimit,
          error: resolvedError,
        });
        this.emit('spec:rate-limit-exhausted', {
          specName,
          retryCount,
          retryLimit,
          error: resolvedError,
        });
      }

      // Sync external status
      await this._syncExternalSafe(specName, 'failed');

      this.emit('spec:failed', { specName, agentId, error: resolvedError, retryCount });

      // Propagate failure to dependents (Req 3.6)
      this._propagateFailure(specName);
    }
  }

  // ---------------------------------------------------------------------------
  // Dependency Graph & Batch Computation
  // ---------------------------------------------------------------------------

  /**
   * Extract dependency map from the graph for the given specs.
   * edges go FROM dependent TO dependency (from: specA, to: specB means specA depends on specB).
   *
   * @param {object} graph - {nodes, edges}
   * @param {string[]} specNames
   * @returns {object} {[specName]: string[]} - each spec maps to its dependencies
   * @private
   */
  _extractDependencies(graph, specNames) {
    const specSet = new Set(specNames);
    const deps = {};

    for (const specName of specNames) {
      deps[specName] = [];
    }

    for (const edge of graph.edges) {
      if (specSet.has(edge.from) && specSet.has(edge.to)) {
        deps[edge.from].push(edge.to);
      }
    }

    return deps;
  }

  /**
   * Compute execution batches via topological sort (Req 3.3).
   * Specs with no dependencies → batch 0.
   * Specs whose dependencies are all in earlier batches → next batch.
   *
   * @param {string[]} specNames
   * @param {object} dependencies - {[specName]: string[]}
   * @returns {string[][]} Array of batches
   * @private
   */
  _computeBatches(specNames, dependencies) {
    const batches = [];
    const assigned = new Set(); // specs already assigned to a batch

    while (assigned.size < specNames.length) {
      const batch = [];

      for (const specName of specNames) {
        if (assigned.has(specName)) continue;

        // Check if all dependencies are in earlier batches
        const deps = dependencies[specName] || [];
        const allDepsAssigned = deps.every(d => assigned.has(d));

        if (allDepsAssigned) {
          batch.push(specName);
        }
      }

      if (batch.length === 0) {
        // Should not happen if cycle detection passed, but safety guard
        break;
      }

      batches.push(batch);
      for (const specName of batch) {
        assigned.add(specName);
      }
    }

    return batches;
  }

  /**
   * Propagate failure: mark all direct and indirect dependents as skipped (Req 3.6).
   *
   * @param {string} failedSpec
   * @private
   */
  _propagateFailure(failedSpec) {
    if (!this._executionPlan) return;

    const deps = this._executionPlan.dependencies;
    const toSkip = new Set();

    // Find all specs that directly or indirectly depend on failedSpec
    const findDependents = (specName) => {
      for (const candidate of this._executionPlan.specs) {
        if (toSkip.has(candidate) || this._completedSpecs.has(candidate)) continue;
        const candidateDeps = deps[candidate] || [];
        if (candidateDeps.includes(specName)) {
          toSkip.add(candidate);
          findDependents(candidate); // recursive: indirect dependents
        }
      }
    };

    findDependents(failedSpec);

    for (const specName of toSkip) {
      this._skippedSpecs.add(specName);
      this._statusMonitor.updateSpecStatus(
        specName, 'skipped', null,
        `Skipped: dependency '${failedSpec}' failed`
      );
    }
  }

  /**
   * Resolve coordination policy from baseline file and runtime config.
   *
   * @param {object} config
   * @returns {Promise<void>}
   * @private
   */
  async _applyCoordinationPolicyConfig(config) {
    const baseline = await this._loadCoordinationPolicyBaseline(config);
    const baselineRules = baseline && baseline.coordination_rules
      ? baseline.coordination_rules
      : {};
    const runtimeRules = config && config.coordinationRules && typeof config.coordinationRules === 'object'
      ? config.coordinationRules
      : {};
    const requireFields = baseline
      && baseline.result_summary_contract
      && Array.isArray(baseline.result_summary_contract.required_fields)
      ? baseline.result_summary_contract.required_fields
      : DEFAULT_RESULT_SUMMARY_REQUIRED_FIELDS;
    const overrideFields = Array.isArray(config && config.resultSummaryRequiredFields)
      ? config.resultSummaryRequiredFields
      : null;

    this._coordinationRules = {
      require_result_summary: this._toBoolean(
        runtimeRules.require_result_summary,
        this._toBoolean(baselineRules.require_result_summary, DEFAULT_COORDINATION_RULES.require_result_summary)
      ),
      block_merge_on_failed_tests: this._toBoolean(
        runtimeRules.block_merge_on_failed_tests,
        this._toBoolean(
          baselineRules.block_merge_on_failed_tests,
          DEFAULT_COORDINATION_RULES.block_merge_on_failed_tests
        )
      ),
      block_merge_on_unresolved_conflicts: this._toBoolean(
        runtimeRules.block_merge_on_unresolved_conflicts,
        this._toBoolean(
          baselineRules.block_merge_on_unresolved_conflicts,
          DEFAULT_COORDINATION_RULES.block_merge_on_unresolved_conflicts
        )
      )
    };

    const selectedFields = overrideFields || requireFields;
    const normalizedFields = selectedFields
      .map((field) => `${field || ''}`.trim())
      .filter(Boolean);
    this._resultSummaryRequiredFields = normalizedFields.length > 0
      ? normalizedFields
      : [...DEFAULT_RESULT_SUMMARY_REQUIRED_FIELDS];
  }

  /**
   * @param {object} config
   * @returns {Promise<object>}
   * @private
   */
  async _loadCoordinationPolicyBaseline(config) {
    const relativePath = (
      config
      && typeof config.coordinationPolicyFile === 'string'
      && config.coordinationPolicyFile.trim()
    )
      ? config.coordinationPolicyFile.trim()
      : this._coordinationPolicyPath;
    const policyPath = path.resolve(this._workspaceRoot, relativePath);
    const exists = await fsUtils.pathExists(policyPath);
    if (!exists) {
      return {};
    }
    try {
      return await fsUtils.readJSON(policyPath);
    } catch (err) {
      console.warn(`[OrchestrationEngine] Failed to parse coordination policy: ${err.message}`);
      return {};
    }
  }

  /**
   * @param {string} specName
   * @param {string} agentId
   * @returns {{ valid: boolean, summary: object|null, issues: string[], message: string }}
   * @private
   */
  _resolveAndValidateResultSummary(specName, agentId) {
    const requireSummary = this._coordinationRules
      && this._coordinationRules.require_result_summary === true;
    if (!requireSummary) {
      return {
        valid: true,
        summary: {
          spec_id: specName,
          changed_files: [],
          tests_run: 0,
          tests_passed: 0,
          risk_level: 'unknown',
          open_issues: []
        },
        issues: [],
        message: ''
      };
    }

    const summary = this._readResultSummaryFromSpawner(agentId);
    if (!summary) {
      return {
        valid: false,
        summary: null,
        issues: ['missing result summary payload'],
        message: 'result summary contract missing'
      };
    }

    const normalizedSummary = this._normalizeResultSummary(summary, specName);
    const issues = this._validateResultSummary(normalizedSummary);
    return {
      valid: issues.length === 0,
      summary: normalizedSummary,
      issues,
      message: issues.length === 0 ? '' : `result summary contract invalid: ${issues.join('; ')}`
    };
  }

  /**
   * @param {string} agentId
   * @returns {object|null}
   * @private
   */
  _readResultSummaryFromSpawner(agentId) {
    if (!this._agentSpawner || typeof this._agentSpawner.getResultSummary !== 'function') {
      return null;
    }
    try {
      return this._agentSpawner.getResultSummary(agentId);
    } catch (_err) {
      return null;
    }
  }

  /**
   * @param {object} summary
   * @param {string} fallbackSpecName
   * @returns {object}
   * @private
   */
  _normalizeResultSummary(summary, fallbackSpecName) {
    const changedFiles = Array.isArray(summary.changed_files)
      ? summary.changed_files.map((item) => `${item || ''}`.trim()).filter(Boolean)
      : [];
    const openIssues = Array.isArray(summary.open_issues)
      ? summary.open_issues.map((item) => `${item || ''}`.trim()).filter(Boolean)
      : [];
    const testsRun = Number(summary.tests_run);
    const testsPassed = Number(summary.tests_passed);
    const normalizedRisk = `${summary.risk_level || 'unknown'}`.trim().toLowerCase();

    return {
      spec_id: `${summary.spec_id || fallbackSpecName || ''}`.trim(),
      changed_files: changedFiles,
      tests_run: Number.isFinite(testsRun) ? Math.max(0, Math.floor(testsRun)) : NaN,
      tests_passed: Number.isFinite(testsPassed) ? Math.max(0, Math.floor(testsPassed)) : NaN,
      risk_level: normalizedRisk || 'unknown',
      open_issues: openIssues
    };
  }

  /**
   * @param {object} summary
   * @returns {string[]}
   * @private
   */
  _validateResultSummary(summary) {
    const issues = [];
    const requiredFields = Array.isArray(this._resultSummaryRequiredFields)
      ? this._resultSummaryRequiredFields
      : [];
    for (const field of requiredFields) {
      if (!Object.prototype.hasOwnProperty.call(summary, field)) {
        issues.push(`missing field '${field}'`);
      }
    }

    if (!summary.spec_id) {
      issues.push('spec_id must be non-empty');
    }
    if (!Array.isArray(summary.changed_files)) {
      issues.push('changed_files must be an array');
    }
    if (!Number.isFinite(summary.tests_run)) {
      issues.push('tests_run must be a non-negative integer');
    }
    if (!Number.isFinite(summary.tests_passed)) {
      issues.push('tests_passed must be a non-negative integer');
    }
    if (
      Number.isFinite(summary.tests_run)
      && Number.isFinite(summary.tests_passed)
      && summary.tests_passed > summary.tests_run
    ) {
      issues.push('tests_passed cannot exceed tests_run');
    }
    if (!VALID_RESULT_RISK_LEVELS.has(summary.risk_level)) {
      issues.push(`risk_level must be one of: ${[...VALID_RESULT_RISK_LEVELS].join(', ')}`);
    }
    if (!Array.isArray(summary.open_issues)) {
      issues.push('open_issues must be an array');
    }

    return issues;
  }

  /**
   * @param {object} summary
   * @returns {{ allowed: boolean, reasons: string[] }}
   * @private
   */
  _evaluateMergeDecision(summary) {
    const reasons = [];
    const coordinationRules = this._coordinationRules || DEFAULT_COORDINATION_RULES;
    if (
      coordinationRules.block_merge_on_failed_tests
      && Number.isFinite(summary.tests_run)
      && Number.isFinite(summary.tests_passed)
      && summary.tests_run > summary.tests_passed
    ) {
      reasons.push(
        `tests failed (${summary.tests_passed}/${summary.tests_run} passed)`
      );
    }

    if (coordinationRules.block_merge_on_unresolved_conflicts) {
      const hasConflictIssue = Array.isArray(summary.open_issues)
        && summary.open_issues.some((issue) => /conflict|unresolved/i.test(`${issue}`));
      if (hasConflictIssue) {
        reasons.push('open issues contain unresolved conflict');
      }
    }

    return {
      allowed: reasons.length === 0,
      reasons
    };
  }

  /**
   * @param {string} specName
   * @param {string} agentId
   * @param {string} errorMessage
   * @param {object} validation
   * @returns {Promise<void>}
   * @private
   */
  async _handleSummaryContractViolation(specName, agentId, errorMessage, validation = {}) {
    this._completedSpecs.delete(specName);
    this._failedSpecs.add(specName);
    this._statusMonitor.updateSpecStatus(specName, 'failed', agentId, errorMessage);
    await this._syncExternalSafe(specName, 'failed');

    this.emit('spec:failed', {
      specName,
      agentId,
      error: errorMessage,
      summary_contract_violation: true,
      summary_validation: validation
    });

    this._propagateFailure(specName);
  }

  // ---------------------------------------------------------------------------
  // Validation & Helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve retry-related runtime config with safe defaults.
   *
   * @param {object} config
   * @private
   */
  _applyRetryPolicyConfig(config) {
    this._rateLimitMaxRetries = this._toNonNegativeInteger(
      config && config.rateLimitMaxRetries,
      DEFAULT_RATE_LIMIT_MAX_RETRIES
    );

    const baseMs = this._toPositiveInteger(
      config && config.rateLimitBackoffBaseMs,
      DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS
    );
    const maxMs = this._toPositiveInteger(
      config && config.rateLimitBackoffMaxMs,
      DEFAULT_RATE_LIMIT_BACKOFF_MAX_MS
    );

    this._rateLimitBackoffBaseMs = Math.min(baseMs, maxMs);
    this._rateLimitBackoffMaxMs = Math.max(baseMs, maxMs);
    this._rateLimitAdaptiveParallel = this._toBoolean(
      config && config.rateLimitAdaptiveParallel,
      DEFAULT_RATE_LIMIT_ADAPTIVE_PARALLEL
    );
    this._rateLimitParallelFloor = this._toPositiveInteger(
      config && config.rateLimitParallelFloor,
      DEFAULT_RATE_LIMIT_PARALLEL_FLOOR
    );
    this._rateLimitCooldownMs = this._toPositiveInteger(
      config && config.rateLimitCooldownMs,
      DEFAULT_RATE_LIMIT_COOLDOWN_MS
    );
    this._rateLimitLaunchBudgetPerMinute = this._toNonNegativeInteger(
      config && config.rateLimitLaunchBudgetPerMinute,
      DEFAULT_RATE_LIMIT_LAUNCH_BUDGET_PER_MINUTE
    );
    this._rateLimitLaunchBudgetWindowMs = this._toPositiveInteger(
      config && config.rateLimitLaunchBudgetWindowMs,
      DEFAULT_RATE_LIMIT_LAUNCH_BUDGET_WINDOW_MS
    );
    this._rateLimitSignalWindowMs = this._toPositiveInteger(
      config && config.rateLimitSignalWindowMs,
      DEFAULT_RATE_LIMIT_SIGNAL_WINDOW_MS
    );
    this._rateLimitSignalThreshold = this._toPositiveInteger(
      config && config.rateLimitSignalThreshold,
      DEFAULT_RATE_LIMIT_SIGNAL_THRESHOLD
    );
    this._rateLimitSignalExtraHoldMs = this._toPositiveInteger(
      config && config.rateLimitSignalExtraHoldMs,
      DEFAULT_RATE_LIMIT_SIGNAL_EXTRA_HOLD_MS
    );
    this._rateLimitDynamicBudgetFloor = this._toPositiveInteger(
      config && config.rateLimitDynamicBudgetFloor,
      DEFAULT_RATE_LIMIT_DYNAMIC_BUDGET_FLOOR
    );
    this._rateLimitRetrySpreadMs = Math.min(
      MAX_RATE_LIMIT_RETRY_SPREAD_MS,
      this._toNonNegativeInteger(
        config && config.rateLimitRetrySpreadMs,
        DEFAULT_RATE_LIMIT_RETRY_SPREAD_MS
      )
    );
    this._rateLimitLaunchHoldPollMs = this._toPositiveInteger(
      config && config.rateLimitLaunchHoldPollMs,
      DEFAULT_RATE_LIMIT_LAUNCH_HOLD_POLL_MS
    );
    this._rateLimitDecisionEventThrottleMs = this._toNonNegativeInteger(
      config && config.rateLimitDecisionEventThrottleMs,
      DEFAULT_RATE_LIMIT_DECISION_EVENT_THROTTLE_MS
    );
  }

  /**
   * Resolve a fallback wait timeout for _waitForAgent.
   * This protects orchestration from hanging forever if lifecycle events
   * are unexpectedly missing.
   *
   * @param {object} config
   * @returns {number}
   * @private
   */
  _resolveAgentWaitTimeoutMs(config) {
    const timeoutSeconds = this._toPositiveInteger(
      config && config.timeoutSeconds,
      DEFAULT_AGENT_WAIT_TIMEOUT_SECONDS
    );
    return (timeoutSeconds * 1000) + AGENT_WAIT_TIMEOUT_GRACE_MS;
  }

  /**
   * @param {number} maxParallel
   * @private
   */
  _initializeAdaptiveParallel(maxParallel) {
    const boundedMax = this._toPositiveInteger(maxParallel, 1);
    this._baseMaxParallel = boundedMax;
    this._effectiveMaxParallel = boundedMax;
    this._rateLimitCooldownUntil = 0;
    this._rateLimitLaunchHoldUntil = 0;
    this._rateLimitLaunchTimestamps = [];
    this._rateLimitSignalTimestamps = [];
    this._dynamicLaunchBudgetPerMinute = null;
    this._launchBudgetLastHoldSignalAt = 0;
    this._launchBudgetLastHoldMs = 0;
    this._updateStatusMonitorParallelTelemetry({
      adaptive: this._isAdaptiveParallelEnabled(),
      maxParallel: boundedMax,
      effectiveMaxParallel: boundedMax,
      floor: Math.min(
        boundedMax,
        this._toPositiveInteger(this._rateLimitParallelFloor, DEFAULT_RATE_LIMIT_PARALLEL_FLOOR)
      ),
    });
    const launchBudgetConfig = this._getLaunchBudgetConfig();
    if (launchBudgetConfig.budgetPerMinute > 0) {
      this._updateStatusMonitorLaunchBudget({
        budgetPerMinute: launchBudgetConfig.budgetPerMinute,
        windowMs: launchBudgetConfig.windowMs,
        used: 0,
        holdMs: 0,
      });
    }
  }

  /**
   * @param {number} maxParallel
   * @returns {number}
   * @private
   */
  _getEffectiveMaxParallel(maxParallel) {
    const boundedMax = this._toPositiveInteger(maxParallel, 1);
    const floor = Math.min(
      boundedMax,
      this._toPositiveInteger(this._rateLimitParallelFloor, DEFAULT_RATE_LIMIT_PARALLEL_FLOOR)
    );

    if (!this._isAdaptiveParallelEnabled()) {
      this._baseMaxParallel = boundedMax;
      this._effectiveMaxParallel = boundedMax;
      this._updateStatusMonitorParallelTelemetry({
        adaptive: false,
        maxParallel: boundedMax,
        effectiveMaxParallel: boundedMax,
        floor,
      });
      return boundedMax;
    }

    this._baseMaxParallel = boundedMax;
    this._maybeRecoverParallelLimit(boundedMax);

    const effective = this._toPositiveInteger(this._effectiveMaxParallel, boundedMax);
    const resolved = Math.max(floor, Math.min(boundedMax, effective));
    this._updateStatusMonitorParallelTelemetry({
      adaptive: true,
      maxParallel: boundedMax,
      effectiveMaxParallel: resolved,
      floor,
    });
    return resolved;
  }

  /**
   * @private
   */
  _onRateLimitSignal(retryDelayMs = 0) {
    const now = this._getNow();
    const launchHoldMs = this._toNonNegativeInteger(retryDelayMs, 0);
    this._recordRateLimitSignal(now);
    if (launchHoldMs > 0) {
      const currentHoldUntil = this._toNonNegativeInteger(this._rateLimitLaunchHoldUntil, 0);
      this._rateLimitLaunchHoldUntil = Math.max(currentHoldUntil, now + launchHoldMs);
    }

    this._applyRateLimitEscalation(now);

    if (!this._isAdaptiveParallelEnabled()) {
      return;
    }

    const base = this._toPositiveInteger(this._baseMaxParallel, 1);
    const current = this._toPositiveInteger(this._effectiveMaxParallel, base);
    const floor = Math.min(
      base,
      this._toPositiveInteger(this._rateLimitParallelFloor, DEFAULT_RATE_LIMIT_PARALLEL_FLOOR)
    );
    const next = Math.max(floor, Math.floor(current / 2));

    if (next < current) {
      this._effectiveMaxParallel = next;
      this._updateStatusMonitorParallelTelemetry({
        event: 'throttled',
        reason: 'rate-limit',
        adaptive: true,
        maxParallel: base,
        effectiveMaxParallel: next,
        floor,
      });
      this.emit('parallel:throttled', {
        reason: 'rate-limit',
        previousMaxParallel: current,
        effectiveMaxParallel: next,
        floor,
      });
      this._emitRateLimitDecision('parallel-throttled', {
        reason: 'rate-limit',
        previousMaxParallel: current,
        effectiveMaxParallel: next,
        floor,
      });
    } else {
      this._effectiveMaxParallel = current;
    }

    this._rateLimitCooldownUntil = now + this._rateLimitCooldownMs;
  }

  /**
   * @param {number} maxParallel
   * @private
   */
  _maybeRecoverParallelLimit(maxParallel) {
    this._maybeRecoverLaunchBudget();

    if (!this._isAdaptiveParallelEnabled()) {
      return;
    }

    const boundedMax = this._toPositiveInteger(maxParallel, 1);
    const current = this._toPositiveInteger(this._effectiveMaxParallel, boundedMax);
    if (current >= boundedMax) {
      this._effectiveMaxParallel = boundedMax;
      return;
    }

    if (this._getNow() < this._rateLimitCooldownUntil) {
      return;
    }

    const next = Math.min(boundedMax, current + 1);
    if (next > current) {
      this._effectiveMaxParallel = next;
      this._rateLimitCooldownUntil = this._getNow() + this._rateLimitCooldownMs;
      this._updateStatusMonitorParallelTelemetry({
        event: 'recovered',
        adaptive: true,
        maxParallel: boundedMax,
        effectiveMaxParallel: next,
      });
      this.emit('parallel:recovered', {
        previousMaxParallel: current,
        effectiveMaxParallel: next,
        maxParallel: boundedMax,
      });
      this._emitRateLimitDecision('parallel-recovered', {
        reason: 'rate-limit-cooldown',
        previousMaxParallel: current,
        effectiveMaxParallel: next,
        maxParallel: boundedMax,
      });
    }
  }

  /**
   * @returns {boolean}
   * @private
   */
  _isAdaptiveParallelEnabled() {
    if (typeof this._rateLimitAdaptiveParallel === 'boolean') {
      return this._rateLimitAdaptiveParallel;
    }
    return DEFAULT_RATE_LIMIT_ADAPTIVE_PARALLEL;
  }

  /**
   * @returns {number}
   * @private
   */
  _getNow() {
    return typeof this._now === 'function' ? this._now() : Date.now();
  }

  /**
   * @returns {number}
   * @private
   */
  _getRateLimitLaunchHoldRemainingMs() {
    const holdUntil = this._toNonNegativeInteger(this._rateLimitLaunchHoldUntil, 0);
    if (holdUntil <= 0) {
      return 0;
    }
    return Math.max(0, holdUntil - this._getNow());
  }

  /**
   * @returns {{ budgetPerMinute: number, windowMs: number }}
   * @private
   */
  _getLaunchBudgetConfig() {
    const configuredBudget = this._toNonNegativeInteger(
      this._rateLimitLaunchBudgetPerMinute,
      DEFAULT_RATE_LIMIT_LAUNCH_BUDGET_PER_MINUTE
    );
    const dynamicBudget = this._dynamicLaunchBudgetPerMinute === null
      || this._dynamicLaunchBudgetPerMinute === undefined
      ? configuredBudget
      : this._toNonNegativeInteger(this._dynamicLaunchBudgetPerMinute, configuredBudget);
    return {
      budgetPerMinute: Math.min(configuredBudget, dynamicBudget),
      windowMs: this._toPositiveInteger(
        this._rateLimitLaunchBudgetWindowMs,
        DEFAULT_RATE_LIMIT_LAUNCH_BUDGET_WINDOW_MS
      ),
    };
  }

  /**
   * @param {number} windowMs
   * @private
   */
  _pruneLaunchBudgetHistory(windowMs) {
    const now = this._getNow();
    const history = Array.isArray(this._rateLimitLaunchTimestamps)
      ? this._rateLimitLaunchTimestamps
      : [];
    this._rateLimitLaunchTimestamps = history
      .filter((timestamp) => Number.isFinite(timestamp) && timestamp > (now - windowMs));
  }

  /**
   * @returns {number}
   * @private
   */
  _getLaunchBudgetHoldRemainingMs() {
    const { budgetPerMinute, windowMs } = this._getLaunchBudgetConfig();
    if (budgetPerMinute <= 0) {
      return 0;
    }
    this._pruneLaunchBudgetHistory(windowMs);
    if (this._rateLimitLaunchTimestamps.length < budgetPerMinute) {
      return 0;
    }
    const oldest = this._rateLimitLaunchTimestamps[0];
    if (!Number.isFinite(oldest)) {
      return 0;
    }
    return Math.max(0, windowMs - (this._getNow() - oldest));
  }

  /**
   * @private
   */
  _recordLaunchStart() {
    const { budgetPerMinute, windowMs } = this._getLaunchBudgetConfig();
    if (budgetPerMinute <= 0) {
      return;
    }
    this._pruneLaunchBudgetHistory(windowMs);
    this._rateLimitLaunchTimestamps.push(this._getNow());
    const holdMs = this._getLaunchBudgetHoldRemainingMs();
    this._updateStatusMonitorLaunchBudget({
      budgetPerMinute,
      windowMs,
      used: this._rateLimitLaunchTimestamps.length,
      holdMs,
    });
  }

  /**
   * @param {number} holdMs
   * @private
   */
  _onLaunchBudgetHold(holdMs) {
    const { budgetPerMinute, windowMs } = this._getLaunchBudgetConfig();
    if (budgetPerMinute <= 0 || holdMs <= 0) {
      return;
    }
    if (!Array.isArray(this._rateLimitLaunchTimestamps)) {
      this._rateLimitLaunchTimestamps = [];
    }

    const now = this._getNow();
    const lastSignalAt = this._toNonNegativeInteger(this._launchBudgetLastHoldSignalAt, 0);
    const lastHoldMs = this._toNonNegativeInteger(this._launchBudgetLastHoldMs, 0);
    const deltaFromLast = now - lastSignalAt;
    const holdDelta = Math.abs(holdMs - lastHoldMs);
    if (deltaFromLast < 1000 && holdDelta < 200) {
      return;
    }
    this._launchBudgetLastHoldSignalAt = now;
    this._launchBudgetLastHoldMs = holdMs;

    this._updateStatusMonitorLaunchBudget({
      event: 'hold',
      budgetPerMinute,
      windowMs,
      used: this._rateLimitLaunchTimestamps.length,
      holdMs,
    });
    this.emit('launch:budget-hold', {
      reason: 'rate-limit-launch-budget',
      holdMs,
      budgetPerMinute,
      windowMs,
      used: this._rateLimitLaunchTimestamps.length,
    });
    this._emitRateLimitDecision('launch-budget-hold', {
      reason: 'rate-limit-launch-budget',
      holdMs,
      budgetPerMinute,
      windowMs,
      used: this._rateLimitLaunchTimestamps.length,
    });
  }

  /**
   * @param {any} value
   * @param {boolean} fallback
   * @returns {boolean}
   * @private
   */
  _toBoolean(value, fallback) {
    if (typeof value === 'boolean') {
      return value;
    }
    return fallback;
  }

  /**
   * @param {any} value
   * @param {number} fallback
   * @returns {number}
   * @private
   */
  _toPositiveInteger(value, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return fallback;
    }
    return Math.floor(numeric);
  }

  /**
   * @param {any} value
   * @param {number} fallback
   * @returns {number}
   * @private
   */
  _toNonNegativeInteger(value, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
      return fallback;
    }
    return Math.floor(numeric);
  }

  /**
   * @param {string} error
   * @returns {boolean}
   * @private
   */
  _isRateLimitError(error) {
    return RATE_LIMIT_ERROR_PATTERNS.some(pattern => pattern.test(`${error || ''}`));
  }

  /**
   * Parse retry-after hints from rate-limit error messages.
   * Supports formats like:
   * - "Retry-After: 7"
   * - "retry after 2s"
   * - "try again in 1500ms"
   *
   * @param {string} error
   * @returns {number} delay in ms (0 when no hint)
   * @private
   */
  _extractRateLimitRetryAfterMs(error) {
    const message = `${error || ''}`;
    if (!message) {
      return 0;
    }

    const patterns = [
      /retry[-_\s]?after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|msec|milliseconds?|s|sec|seconds?|m|min|minutes?)?/i,
      /try\s+again\s+in\s+(\d+(?:\.\d+)?)\s*(ms|msec|milliseconds?|s|sec|seconds?|m|min|minutes?)?/i,
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(message);
      if (!match) {
        continue;
      }

      const value = Number(match[1]);
      if (!Number.isFinite(value) || value <= 0) {
        continue;
      }

      const unit = `${match[2] || 's'}`.trim().toLowerCase();
      let multiplier = 1000;
      if (unit === 'ms' || unit === 'msec' || unit.startsWith('millisecond')) {
        multiplier = 1;
      } else if (unit === 'm' || unit === 'min' || unit.startsWith('minute')) {
        multiplier = 60 * 1000;
      } else {
        multiplier = 1000;
      }

      const delayMs = Math.round(value * multiplier);
      return Math.max(0, Math.min(RATE_LIMIT_RETRY_AFTER_MAX_MS, delayMs));
    }

    return 0;
  }

  /**
   * @param {number} retryCount
   * @returns {number}
   * @private
   */
  _calculateRateLimitBackoffMs(retryCount) {
    const exponent = Math.max(0, retryCount);
    const cappedBaseDelay = Math.min(
      this._rateLimitBackoffMaxMs || DEFAULT_RATE_LIMIT_BACKOFF_MAX_MS,
      (this._rateLimitBackoffBaseMs || DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS) * (2 ** exponent)
    );

    const randomValue = typeof this._random === 'function' ? this._random() : Math.random();
    const normalizedRandom = Number.isFinite(randomValue)
      ? Math.min(1, Math.max(0, randomValue))
      : 0.5;
    const jitterFactor = (1 - RATE_LIMIT_BACKOFF_JITTER_RATIO)
      + (normalizedRandom * RATE_LIMIT_BACKOFF_JITTER_RATIO);

    return Math.max(1, Math.round(cappedBaseDelay * jitterFactor));
  }

  /**
   * @param {number} now
   * @private
   */
  _recordRateLimitSignal(now) {
    const signalAt = Number.isFinite(now) ? now : this._getNow();
    const windowMs = this._toPositiveInteger(
      this._rateLimitSignalWindowMs,
      DEFAULT_RATE_LIMIT_SIGNAL_WINDOW_MS
    );
    if (!Array.isArray(this._rateLimitSignalTimestamps)) {
      this._rateLimitSignalTimestamps = [];
    }
    this._rateLimitSignalTimestamps = this._rateLimitSignalTimestamps
      .filter((timestamp) => Number.isFinite(timestamp) && timestamp > (signalAt - windowMs));
    this._rateLimitSignalTimestamps.push(signalAt);
  }

  /**
   * @returns {number}
   * @private
   */
  _getRecentRateLimitSignalCount() {
    const now = this._getNow();
    const windowMs = this._toPositiveInteger(
      this._rateLimitSignalWindowMs,
      DEFAULT_RATE_LIMIT_SIGNAL_WINDOW_MS
    );
    if (!Array.isArray(this._rateLimitSignalTimestamps)) {
      this._rateLimitSignalTimestamps = [];
      return 0;
    }
    this._rateLimitSignalTimestamps = this._rateLimitSignalTimestamps
      .filter((timestamp) => Number.isFinite(timestamp) && timestamp > (now - windowMs));
    return this._rateLimitSignalTimestamps.length;
  }

  /**
   * @param {number} now
   * @private
   */
  _applyRateLimitEscalation(now) {
    const signalCount = this._getRecentRateLimitSignalCount();
    const threshold = this._toPositiveInteger(
      this._rateLimitSignalThreshold,
      DEFAULT_RATE_LIMIT_SIGNAL_THRESHOLD
    );

    if (signalCount < threshold) {
      return;
    }

    const maxHoldMs = this._toPositiveInteger(
      this._rateLimitBackoffMaxMs,
      DEFAULT_RATE_LIMIT_BACKOFF_MAX_MS
    );
    const escalationUnits = signalCount - threshold + 1;
    const extraHoldMs = Math.min(
      maxHoldMs,
      escalationUnits * this._toPositiveInteger(
        this._rateLimitSignalExtraHoldMs,
        DEFAULT_RATE_LIMIT_SIGNAL_EXTRA_HOLD_MS
      )
    );
    if (extraHoldMs > 0) {
      const currentHoldUntil = this._toNonNegativeInteger(this._rateLimitLaunchHoldUntil, 0);
      this._rateLimitLaunchHoldUntil = Math.max(currentHoldUntil, now + extraHoldMs);
      this._emitRateLimitDecision('launch-hold-escalated', {
        reason: 'rate-limit-spike-hold',
        signalCount,
        extraHoldMs,
      });
    }

    const configuredBudget = this._toNonNegativeInteger(
      this._rateLimitLaunchBudgetPerMinute,
      DEFAULT_RATE_LIMIT_LAUNCH_BUDGET_PER_MINUTE
    );
    if (configuredBudget <= 0) {
      return;
    }

    const currentBudget = this._toPositiveInteger(
      this._dynamicLaunchBudgetPerMinute == null
        ? configuredBudget
        : this._dynamicLaunchBudgetPerMinute,
      configuredBudget
    );
    const budgetFloor = Math.max(
      1,
      Math.min(
        configuredBudget,
        this._toPositiveInteger(
          this._rateLimitDynamicBudgetFloor,
          DEFAULT_RATE_LIMIT_DYNAMIC_BUDGET_FLOOR
        )
      )
    );
    const nextBudget = Math.max(budgetFloor, Math.floor(currentBudget / 2));
    if (nextBudget >= currentBudget) {
      return;
    }

    this._dynamicLaunchBudgetPerMinute = nextBudget;
    const launchBudgetConfig = this._getLaunchBudgetConfig();
    const holdMs = this._getLaunchBudgetHoldRemainingMs();
    this._updateStatusMonitorLaunchBudget({
      event: 'throttled',
      budgetPerMinute: launchBudgetConfig.budgetPerMinute,
      windowMs: launchBudgetConfig.windowMs,
      used: Array.isArray(this._rateLimitLaunchTimestamps) ? this._rateLimitLaunchTimestamps.length : 0,
      holdMs,
    });
    this.emit('launch:budget-throttled', {
      reason: 'rate-limit-spike',
      signalCount,
      budgetPerMinute: launchBudgetConfig.budgetPerMinute,
      windowMs: launchBudgetConfig.windowMs,
      holdMs,
    });
    this._emitRateLimitDecision('launch-budget-throttled', {
      reason: 'rate-limit-spike',
      signalCount,
      budgetPerMinute: launchBudgetConfig.budgetPerMinute,
      windowMs: launchBudgetConfig.windowMs,
      holdMs,
    });
  }

  /**
   * @private
   */
  _maybeRecoverLaunchBudget() {
    const configuredBudget = this._toNonNegativeInteger(
      this._rateLimitLaunchBudgetPerMinute,
      DEFAULT_RATE_LIMIT_LAUNCH_BUDGET_PER_MINUTE
    );
    if (configuredBudget <= 0) {
      this._dynamicLaunchBudgetPerMinute = null;
      return;
    }

    const currentBudget = this._toPositiveInteger(
      this._dynamicLaunchBudgetPerMinute == null
        ? configuredBudget
        : this._dynamicLaunchBudgetPerMinute,
      configuredBudget
    );
    if (currentBudget >= configuredBudget) {
      this._dynamicLaunchBudgetPerMinute = null;
      return;
    }

    if (this._getNow() < this._rateLimitCooldownUntil) {
      return;
    }

    if (this._getRecentRateLimitSignalCount() > 0) {
      return;
    }

    const nextBudget = Math.min(configuredBudget, currentBudget + 1);
    this._dynamicLaunchBudgetPerMinute = nextBudget >= configuredBudget
      ? null
      : nextBudget;

    const launchBudgetConfig = this._getLaunchBudgetConfig();
    const holdMs = this._getLaunchBudgetHoldRemainingMs();
    this._updateStatusMonitorLaunchBudget({
      event: 'recovered',
      budgetPerMinute: launchBudgetConfig.budgetPerMinute,
      windowMs: launchBudgetConfig.windowMs,
      used: Array.isArray(this._rateLimitLaunchTimestamps) ? this._rateLimitLaunchTimestamps.length : 0,
      holdMs,
    });
    this.emit('launch:budget-recovered', {
      reason: 'rate-limit-cooldown',
      budgetPerMinute: launchBudgetConfig.budgetPerMinute,
      windowMs: launchBudgetConfig.windowMs,
      holdMs,
    });
    this._emitRateLimitDecision('launch-budget-recovered', {
      reason: 'rate-limit-cooldown',
      budgetPerMinute: launchBudgetConfig.budgetPerMinute,
      windowMs: launchBudgetConfig.windowMs,
      holdMs,
    });
  }

  /**
   * Resolve final retry delay for rate-limit failures.
   * Uses larger of computed backoff and retry-after hint, then clamps to configured max.
   *
   * @param {string} error
   * @param {number} retryCount
   * @returns {number}
   * @private
   */
  _resolveRateLimitRetryDelayMs(error, retryCount) {
    const computedBackoffMs = this._calculateRateLimitBackoffMs(retryCount);
    const hintedRetryAfterMs = this._extractRateLimitRetryAfterMs(error);
    const candidateDelayMs = Math.max(computedBackoffMs, hintedRetryAfterMs);
    const maxDelayMs = this._toPositiveInteger(
      this._rateLimitBackoffMaxMs,
      DEFAULT_RATE_LIMIT_BACKOFF_MAX_MS
    );
    return Math.max(1, Math.min(candidateDelayMs, maxDelayMs));
  }

  /**
   * Build retry delay details for a rate-limit failure.
   * Keeps backoff compliant with provider hint while spreading retries across specs.
   *
   * @param {string} specName
   * @param {number} retryCount
   * @param {string} error
   * @returns {{computedBackoffMs: number, retryAfterHintMs: number, baseDelayMs: number, spreadDelayMs: number, totalDelayMs: number}}
   * @private
   */
  _buildRateLimitRetryPlan(specName, retryCount, error) {
    const computedBackoffMs = this._calculateRateLimitBackoffMs(retryCount);
    const retryAfterHintMs = this._extractRateLimitRetryAfterMs(error);
    const baseDelayMs = this._resolveRateLimitRetryDelayMs(error, retryCount);
    const spreadDelayMs = this._calculateRateLimitRetrySpreadMs(specName, retryCount);
    return {
      computedBackoffMs,
      retryAfterHintMs,
      baseDelayMs,
      spreadDelayMs,
      totalDelayMs: baseDelayMs + spreadDelayMs,
    };
  }

  /**
   * Spread same-round retries across specs to avoid synchronized 429 bursts.
   *
   * @param {string} specName
   * @param {number} retryCount
   * @returns {number}
   * @private
   */
  _calculateRateLimitRetrySpreadMs(specName, retryCount) {
    const spreadCapMs = Math.min(
      MAX_RATE_LIMIT_RETRY_SPREAD_MS,
      this._toNonNegativeInteger(
        this._rateLimitRetrySpreadMs,
        DEFAULT_RATE_LIMIT_RETRY_SPREAD_MS
      )
    );
    if (spreadCapMs <= 0) {
      return 0;
    }

    const normalizedSpecName = `${specName || ''}`.trim() || 'unknown-spec';
    const retryOrdinal = this._toNonNegativeInteger(retryCount, 0) + 1;
    const seed = `${normalizedSpecName}#${retryOrdinal}`;
    const hash = this._hashString(seed);
    return hash % (spreadCapMs + 1);
  }

  /**
   * Lightweight deterministic hash for retry spread.
   *
   * @param {string} value
   * @returns {number}
   * @private
   */
  _hashString(value) {
    let hash = 0;
    const input = `${value || ''}`;
    for (let idx = 0; idx < input.length; idx++) {
      hash = ((hash * 31) + input.charCodeAt(idx)) >>> 0;
    }
    return hash;
  }

  /**
   * Emit machine-readable rate-limit decision telemetry with simple de-dup throttling.
   *
   * @param {string} decision
   * @param {object} payload
   * @private
   */
  _emitRateLimitDecision(decision, payload = {}) {
    const normalizedDecision = `${decision || ''}`.trim();
    if (!normalizedDecision) {
      return;
    }

    const now = this._getNow();
    const reason = payload && typeof payload.reason === 'string'
      ? payload.reason.trim()
      : '';
    const dedupeKey = `${normalizedDecision}:${reason}`;
    const throttleMs = this._toNonNegativeInteger(
      this._rateLimitDecisionEventThrottleMs,
      DEFAULT_RATE_LIMIT_DECISION_EVENT_THROTTLE_MS
    );

    if (
      throttleMs > 0
      && dedupeKey === this._lastRateLimitDecisionKey
      && (now - this._lastRateLimitDecisionAt) < throttleMs
    ) {
      return;
    }

    this._lastRateLimitDecisionAt = now;
    this._lastRateLimitDecisionKey = dedupeKey;
    this.emit('rate-limit:decision', {
      decision: normalizedDecision,
      at: new Date(now).toISOString(),
      ...(payload && typeof payload === 'object' ? payload : {}),
    });
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   * @private
   */
  _sleep(ms) {
    if (!ms || ms <= 0 || this._stopped) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const entry = { timer: null, resolve: null };
      entry.resolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (entry.timer) {
          clearTimeout(entry.timer);
        }
        this._pendingSleeps.delete(entry);
        resolve();
      };
      entry.timer = setTimeout(() => {
        if (entry.resolve) {
          entry.resolve();
        }
      }, ms);
      this._pendingSleeps.add(entry);
    });
  }

  /**
   * Cancel all pending sleeps so stop() does not block behind long retry waits.
   *
   * @private
   */
  _cancelPendingSleeps() {
    if (!this._pendingSleeps || this._pendingSleeps.size === 0) {
      return;
    }
    for (const entry of Array.from(this._pendingSleeps)) {
      if (entry && typeof entry.resolve === 'function') {
        entry.resolve();
      }
    }
    this._pendingSleeps.clear();
  }

  /**
   * Safely update StatusMonitor rate-limit telemetry.
   *
   * @param {object} payload
   * @private
   */
  _updateStatusMonitorRateLimit(payload) {
    const handler = this._statusMonitor && this._statusMonitor.recordRateLimitEvent;
    if (typeof handler === 'function') {
      try {
        handler.call(this._statusMonitor, payload);
      } catch (_err) {
        // Non-fatal status telemetry update.
      }
    }
  }

  /**
   * Safely update StatusMonitor adaptive parallel telemetry.
   *
   * @param {object} payload
   * @private
   */
  _updateStatusMonitorParallelTelemetry(payload) {
    const handler = this._statusMonitor && this._statusMonitor.updateParallelTelemetry;
    if (typeof handler === 'function') {
      try {
        handler.call(this._statusMonitor, payload);
      } catch (_err) {
        // Non-fatal status telemetry update.
      }
    }
  }

  /**
   * Safely update StatusMonitor launch-budget telemetry.
   *
   * @param {object} payload
   * @private
   */
  _updateStatusMonitorLaunchBudget(payload) {
    const handler = this._statusMonitor && this._statusMonitor.updateLaunchBudgetTelemetry;
    if (typeof handler === 'function') {
      try {
        handler.call(this._statusMonitor, payload);
      } catch (_err) {
        // Non-fatal status telemetry update.
      }
    }
  }

  /**
   * Validate that all spec directories exist (Req 6.4).
   *
   * @param {string[]} specNames
   * @returns {Promise<string[]>} List of missing spec names
   * @private
   */
  async _validateSpecExistence(specNames) {
    const missing = [];
    for (const specName of specNames) {
      const specDir = path.join(this._workspaceRoot, SPECS_DIR, specName);
      const exists = await fsUtils.pathExists(specDir);
      if (!exists) {
        missing.push(specName);
      }
    }
    return missing;
  }

  /**
   * Safely transition a spec via SpecLifecycleManager (Req 8.1, 8.2).
   * Failures are logged but do not propagate (non-fatal).
   *
   * @param {string} specName
   * @param {string} newStatus
   * @returns {Promise<void>}
   * @private
   */
  async _transitionSafe(specName, newStatus) {
    try {
      await this._specLifecycleManager.transition(specName, newStatus);
    } catch (err) {
      console.warn(
        `[OrchestrationEngine] SLM transition failed for ${specName} → ${newStatus}: ${err.message}`
      );
    }
  }

  /**
   * Safely sync external status via StatusMonitor (Req 8.5).
   * Failures are logged but do not propagate (non-fatal).
   *
   * @param {string} specName
   * @param {string} status
   * @returns {Promise<void>}
   * @private
   */
  async _syncExternalSafe(specName, status) {
    try {
      await this._statusMonitor.syncExternalStatus(specName, status);
    } catch (err) {
      console.warn(
        `[OrchestrationEngine] External sync failed for ${specName}: ${err.message}`
      );
    }
  }

  /**
   * Build the orchestration result object.
   *
   * @param {string} status
   * @param {string|null} [error=null]
   * @returns {object}
   * @private
   */
  _buildResult(status, error = null) {
    const resultSummaries = {};
    if (this._resultSummaries && typeof this._resultSummaries.entries === 'function') {
      for (const [specName, summary] of this._resultSummaries.entries()) {
        resultSummaries[specName] = { ...summary };
      }
    }
    return {
      status,
      plan: this._executionPlan,
      completed: [...this._completedSpecs],
      failed: [...this._failedSpecs],
      skipped: [...this._skippedSpecs],
      result_summaries: resultSummaries,
      coordination_rules: { ...(this._coordinationRules || DEFAULT_COORDINATION_RULES) },
      error,
    };
  }

  /**
   * Reset internal state for a new orchestration run.
   * @private
   */
  _reset() {
    this._cancelPendingSleeps();
    this._runningAgents.clear();
    this._retryCounts.clear();
    this._failedSpecs.clear();
    this._skippedSpecs.clear();
    this._completedSpecs.clear();
    if (this._resultSummaries && typeof this._resultSummaries.clear === 'function') {
      this._resultSummaries.clear();
    } else {
      this._resultSummaries = new Map();
    }
    this._executionPlan = null;
    this._stopped = false;
    this._baseMaxParallel = null;
    this._effectiveMaxParallel = null;
    this._rateLimitCooldownUntil = 0;
    this._rateLimitLaunchHoldUntil = 0;
    this._rateLimitLaunchTimestamps = [];
    this._rateLimitSignalTimestamps = [];
    this._dynamicLaunchBudgetPerMinute = null;
    this._launchBudgetLastHoldSignalAt = 0;
    this._launchBudgetLastHoldMs = 0;
    this._lastRateLimitDecisionAt = 0;
    this._lastRateLimitDecisionKey = '';
  }
}

module.exports = { OrchestrationEngine };
