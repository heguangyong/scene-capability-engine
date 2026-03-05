/**
 * OrchestrationEngine Unit Tests
 *
 * Validates: Requirements 3.1-3.7, 5.1-5.6
 * - 3.1: Build dependency graph (DAG)
 * - 3.2: Circular dependency detection
 * - 3.3: Batch computation (topological sort)
 * - 3.5: Parallel control (maxParallel)
 * - 3.6: Failure propagation (skip dependents)
 * - 3.7: DependencyManager integration
 * - 5.1: Crash detection
 * - 5.2: Retry on failure
 * - 5.3: Final failure after maxRetries
 * - 5.5: Graceful stop
 * - 5.6: Deregister on completion
 */

const { EventEmitter } = require('events');

// --- Mock fs-utils (pathExists for spec validation) ---
jest.mock('../../lib/utils/fs-utils', () => ({
  pathExists: jest.fn(),
  readJSON: jest.fn(),
}));

const fsUtils = require('../../lib/utils/fs-utils');
const { OrchestrationEngine } = require('../../lib/orchestrator/orchestration-engine');

// Helper: flush microtask queue
function flushPromises() {
  return new Promise((resolve) => process.nextTick(resolve));
}

describe('OrchestrationEngine', () => {
  let engine;
  let mockSpawner;
  let mockDependencyManager;
  let mockSLM;
  let mockStatusMonitor;
  let mockConfig;
  let mockRegistry;
  let spawnCounter;

  beforeEach(() => {
    spawnCounter = 0;

    // --- MockAgentSpawner (EventEmitter) ---
    mockSpawner = new EventEmitter();
    mockSpawner.spawn = jest.fn().mockImplementation((specName) => {
      spawnCounter++;
      const agentId = `agent-${specName}`;
      // Default: emit completion after a tick
      process.nextTick(() => {
        mockSpawner.emit('agent:completed', { agentId, specName, exitCode: 0 });
      });
      return Promise.resolve({ agentId, specName, status: 'running' });
    });
    mockSpawner.getResultSummary = jest.fn().mockImplementation((agentId) => {
      const agentText = `${agentId || ''}`;
      const normalizedSpecId = agentText.startsWith('agent-')
        ? agentText.replace(/^agent-/, '').replace(/-\d+$/, '')
        : 'unknown-spec';
      return {
        spec_id: normalizedSpecId,
        changed_files: [],
        tests_run: 0,
        tests_passed: 0,
        risk_level: 'low',
        open_issues: []
      };
    });
    mockSpawner.kill = jest.fn().mockResolvedValue(undefined);
    mockSpawner.killAll = jest.fn().mockResolvedValue(undefined);

    // --- MockDependencyManager ---
    mockDependencyManager = {
      buildDependencyGraph: jest.fn().mockResolvedValue({ nodes: [], edges: [] }),
      detectCircularDependencies: jest.fn().mockReturnValue(null),
    };

    // --- MockSpecLifecycleManager ---
    mockSLM = {
      transition: jest.fn().mockResolvedValue({ success: true }),
    };

    // --- MockStatusMonitor ---
    mockStatusMonitor = {
      initSpec: jest.fn(),
      updateSpecStatus: jest.fn(),
      incrementRetry: jest.fn(),
      recordRateLimitEvent: jest.fn(),
      updateParallelTelemetry: jest.fn(),
      updateLaunchBudgetTelemetry: jest.fn(),
      setOrchestrationState: jest.fn(),
      setBatchInfo: jest.fn(),
      getOrchestrationStatus: jest.fn().mockReturnValue({
        status: 'idle',
        totalSpecs: 0,
        completedSpecs: 0,
        failedSpecs: 0,
        runningSpecs: 0,
        currentBatch: 0,
        totalBatches: 0,
        specs: {},
      }),
      syncExternalStatus: jest.fn().mockResolvedValue(undefined),
    };

    // --- MockOrchestratorConfig ---
    mockConfig = {
      getConfig: jest.fn().mockResolvedValue({
        maxParallel: 3,
        maxRetries: 2,
        timeoutSeconds: 600,
      }),
    };

    // --- MockAgentRegistry ---
    mockRegistry = {};

    // All specs exist by default. Coordination policy file is absent unless explicitly mocked.
    fsUtils.pathExists.mockImplementation(async (targetPath) => {
      if (`${targetPath || ''}`.includes('multi-agent-coordination-policy-baseline.json')) {
        return false;
      }
      return true;
    });
    fsUtils.readJSON.mockResolvedValue({});

    engine = new OrchestrationEngine('/workspace', {
      agentSpawner: mockSpawner,
      dependencyManager: mockDependencyManager,
      specLifecycleManager: mockSLM,
      statusMonitor: mockStatusMonitor,
      orchestratorConfig: mockConfig,
      agentRegistry: mockRegistry,
    });
  });

  afterEach(() => {
    engine.removeAllListeners();
    mockSpawner.removeAllListeners();
  });

  // -------------------------------------------------------------------------
  // Batch Computation (Req 3.1, 3.3)
  // -------------------------------------------------------------------------

  describe('batch computation (Req 3.1, 3.3)', () => {
    test('independent specs → single batch', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a', 'spec-b', 'spec-c'],
        edges: [],
      });

      const result = await engine.start(['spec-a', 'spec-b', 'spec-c']);

      expect(result.status).not.toBe('failed');
      expect(result.plan).toBeDefined();
      expect(result.plan.batches).toHaveLength(1);
      expect(result.plan.batches[0]).toEqual(
        expect.arrayContaining(['spec-a', 'spec-b', 'spec-c'])
      );
    });

    test('linear dependency chain → sequential batches', async () => {
      // A → B → C (C depends on B, B depends on A)
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a', 'spec-b', 'spec-c'],
        edges: [
          { from: 'spec-b', to: 'spec-a' },
          { from: 'spec-c', to: 'spec-b' },
        ],
      });

      const result = await engine.start(['spec-a', 'spec-b', 'spec-c']);

      expect(result.plan.batches).toHaveLength(3);
      expect(result.plan.batches[0]).toEqual(['spec-a']);
      expect(result.plan.batches[1]).toEqual(['spec-b']);
      expect(result.plan.batches[2]).toEqual(['spec-c']);
    });

    test('diamond dependency → correct batch grouping', async () => {
      // A → B, A → C, B → D, C → D (D depends on B and C, B and C depend on A)
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a', 'spec-b', 'spec-c', 'spec-d'],
        edges: [
          { from: 'spec-b', to: 'spec-a' },
          { from: 'spec-c', to: 'spec-a' },
          { from: 'spec-d', to: 'spec-b' },
          { from: 'spec-d', to: 'spec-c' },
        ],
      });

      const result = await engine.start(['spec-a', 'spec-b', 'spec-c', 'spec-d']);

      expect(result.plan.batches).toHaveLength(3);
      expect(result.plan.batches[0]).toEqual(['spec-a']);
      expect(result.plan.batches[1]).toEqual(
        expect.arrayContaining(['spec-b', 'spec-c'])
      );
      expect(result.plan.batches[2]).toEqual(['spec-d']);
    });
  });

  // -------------------------------------------------------------------------
  // Circular Dependency Detection (Req 3.2)
  // -------------------------------------------------------------------------

  describe('circular dependency detection (Req 3.2)', () => {
    test('circular dependency → returns failed result with cycle path', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a', 'spec-b'],
        edges: [
          { from: 'spec-a', to: 'spec-b' },
          { from: 'spec-b', to: 'spec-a' },
        ],
      });
      mockDependencyManager.detectCircularDependencies.mockReturnValue([
        'spec-a', 'spec-b', 'spec-a',
      ]);

      const result = await engine.start(['spec-a', 'spec-b']);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Circular dependency detected');
      expect(result.error).toContain('spec-a');
      expect(result.error).toContain('spec-b');
      expect(result.plan.hasCycle).toBe(true);
      expect(result.plan.cyclePath).toEqual(['spec-a', 'spec-b', 'spec-a']);
      // Should NOT have spawned any agents
      expect(mockSpawner.spawn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Parallel Control (Req 3.5)
  // -------------------------------------------------------------------------

  describe('parallel control (Req 3.5)', () => {
    test('maxParallel limits concurrent spawns', async () => {
      // 5 independent specs, maxParallel = 2
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['s1', 's2', 's3', 's4', 's5'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({ maxParallel: 2, maxRetries: 0 });

      // Track concurrent spawns
      let concurrentCount = 0;
      let maxConcurrent = 0;

      mockSpawner.spawn.mockImplementation((specName) => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        const agentId = `agent-${specName}`;

        // Emit completion after a small delay
        setTimeout(() => {
          concurrentCount--;
          mockSpawner.emit('agent:completed', { agentId, specName, exitCode: 0 });
        }, 10);

        return Promise.resolve({ agentId, specName, status: 'running' });
      });

      const result = await engine.start(['s1', 's2', 's3', 's4', 's5']);

      expect(result.status).not.toBe('failed');
      expect(maxConcurrent).toBeLessThanOrEqual(2);
      expect(mockSpawner.spawn).toHaveBeenCalledTimes(5);
    });

    test('maxParallel from options overrides config', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['s1', 's2', 's3'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({ maxParallel: 10, maxRetries: 0 });

      let maxConcurrent = 0;
      let concurrentCount = 0;

      mockSpawner.spawn.mockImplementation((specName) => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        const agentId = `agent-${specName}`;
        setTimeout(() => {
          concurrentCount--;
          mockSpawner.emit('agent:completed', { agentId, specName, exitCode: 0 });
        }, 10);
        return Promise.resolve({ agentId, specName, status: 'running' });
      });

      await engine.start(['s1', 's2', 's3'], { maxParallel: 1 });

      expect(maxConcurrent).toBeLessThanOrEqual(1);
    });

    test('adaptive parallel throttles on rate limit and recovers after cooldown', () => {
      let now = 0;
      engine._now = () => now;
      engine._applyRetryPolicyConfig({
        rateLimitAdaptiveParallel: true,
        rateLimitParallelFloor: 1,
        rateLimitCooldownMs: 1000,
      });
      engine._initializeAdaptiveParallel(8);

      engine._onRateLimitSignal();
      expect(engine._effectiveMaxParallel).toBe(4);
      expect(engine._getEffectiveMaxParallel(8)).toBe(4);

      engine._onRateLimitSignal();
      expect(engine._effectiveMaxParallel).toBe(2);
      expect(engine._getEffectiveMaxParallel(8)).toBe(2);

      now = 1001;
      expect(engine._getEffectiveMaxParallel(8)).toBe(3);

      now = 2002;
      expect(engine._getEffectiveMaxParallel(8)).toBe(4);

      expect(mockStatusMonitor.updateParallelTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'throttled',
          effectiveMaxParallel: 4,
        })
      );
      expect(mockStatusMonitor.updateParallelTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'recovered',
        })
      );
    });

    test('adaptive parallel can be disabled', () => {
      engine._applyRetryPolicyConfig({
        rateLimitAdaptiveParallel: false,
        rateLimitParallelFloor: 1,
        rateLimitCooldownMs: 1000,
      });
      engine._initializeAdaptiveParallel(5);

      engine._onRateLimitSignal();

      expect(engine._effectiveMaxParallel).toBe(5);
      expect(engine._getEffectiveMaxParallel(5)).toBe(5);
    });

    test('launch hold still applies when adaptive parallel is disabled', () => {
      let now = 1000;
      engine._now = () => now;
      engine._applyRetryPolicyConfig({
        rateLimitAdaptiveParallel: false,
        rateLimitParallelFloor: 1,
        rateLimitCooldownMs: 1000,
      });
      engine._initializeAdaptiveParallel(5);

      engine._onRateLimitSignal(2000);

      expect(engine._effectiveMaxParallel).toBe(5);
      expect(engine._getRateLimitLaunchHoldRemainingMs()).toBe(2000);

      now = 1500;
      expect(engine._getRateLimitLaunchHoldRemainingMs()).toBe(1500);
    });

    test('rate-limit launch hold pauses new launches until hold expires', async () => {
      let now = 1000;
      engine._now = () => now;
      engine._rateLimitLaunchHoldUntil = 1500;

      const sleepSpy = jest.spyOn(engine, '_sleep').mockImplementation(async (ms) => {
        now += ms;
      });
      const executeSpy = jest.spyOn(engine, '_executeSpec').mockResolvedValue(undefined);

      await engine._executeSpecsInParallel(['spec-a'], 1, 0);

      expect(sleepSpy).toHaveBeenCalledWith(500);
      expect(executeSpy).toHaveBeenCalledWith('spec-a', 0);

      executeSpy.mockRestore();
      sleepSpy.mockRestore();
    });

    test('launch budget hold pauses new launches until rolling window frees capacity', async () => {
      let now = 0;
      engine._now = () => now;
      engine._applyRetryPolicyConfig({
        rateLimitLaunchBudgetPerMinute: 1,
        rateLimitLaunchBudgetWindowMs: 1000,
      });
      engine._initializeAdaptiveParallel(2);

      const sleepSpy = jest.spyOn(engine, '_sleep').mockImplementation(async (ms) => {
        now += ms;
      });
      const executeSpy = jest.spyOn(engine, '_executeSpec').mockResolvedValue(undefined);

      await engine._executeSpecsInParallel(['spec-a', 'spec-b'], 2, 0);

      expect(sleepSpy).toHaveBeenCalledWith(1000);
      expect(executeSpy).toHaveBeenCalledWith('spec-a', 0);
      expect(executeSpy).toHaveBeenCalledWith('spec-b', 0);
      expect(mockStatusMonitor.updateLaunchBudgetTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'hold',
          budgetPerMinute: 1,
          windowMs: 1000,
        })
      );

      executeSpy.mockRestore();
      sleepSpy.mockRestore();
    });

    test('rate-limit spike throttles launch budget and extends launch hold', () => {
      let now = 0;
      engine._now = () => now;
      engine._applyRetryPolicyConfig({
        rateLimitAdaptiveParallel: true,
        rateLimitParallelFloor: 1,
        rateLimitCooldownMs: 1000,
        rateLimitLaunchBudgetPerMinute: 8,
        rateLimitLaunchBudgetWindowMs: 60000,
      });
      engine._initializeAdaptiveParallel(8);

      engine._onRateLimitSignal(1000);
      expect(engine._getRateLimitLaunchHoldRemainingMs()).toBe(1000);
      engine._onRateLimitSignal(1000);
      expect(engine._getRateLimitLaunchHoldRemainingMs()).toBe(1000);
      engine._onRateLimitSignal(1000);

      expect(engine._getRateLimitLaunchHoldRemainingMs()).toBe(3000);
      expect(engine._getLaunchBudgetConfig().budgetPerMinute).toBe(4);
      expect(mockStatusMonitor.updateLaunchBudgetTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'throttled',
          budgetPerMinute: 4,
        })
      );
    });

    test('throttled launch budget recovers after cooldown and quiet window', () => {
      let now = 0;
      engine._now = () => now;
      engine._applyRetryPolicyConfig({
        rateLimitAdaptiveParallel: true,
        rateLimitParallelFloor: 1,
        rateLimitCooldownMs: 100,
        rateLimitLaunchBudgetPerMinute: 4,
        rateLimitLaunchBudgetWindowMs: 1000,
        rateLimitSignalWindowMs: 200,
      });
      engine._initializeAdaptiveParallel(4);

      engine._onRateLimitSignal(50);
      engine._onRateLimitSignal(50);
      engine._onRateLimitSignal(50);
      expect(engine._getLaunchBudgetConfig().budgetPerMinute).toBe(2);

      now = 150;
      engine._getEffectiveMaxParallel(4);
      expect(engine._getLaunchBudgetConfig().budgetPerMinute).toBe(2);

      now = 250;
      engine._getEffectiveMaxParallel(4);
      expect(engine._getLaunchBudgetConfig().budgetPerMinute).toBe(3);

      now = 500;
      engine._getEffectiveMaxParallel(4);
      expect(engine._getLaunchBudgetConfig().budgetPerMinute).toBe(4);
      expect(mockStatusMonitor.updateLaunchBudgetTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'recovered',
          budgetPerMinute: 4,
        })
      );
    });

    test('spike config knobs control hold extension and dynamic budget floor', () => {
      let now = 0;
      engine._now = () => now;
      engine._applyRetryPolicyConfig({
        rateLimitAdaptiveParallel: true,
        rateLimitParallelFloor: 1,
        rateLimitCooldownMs: 1000,
        rateLimitLaunchBudgetPerMinute: 8,
        rateLimitLaunchBudgetWindowMs: 60000,
        rateLimitSignalThreshold: 2,
        rateLimitSignalExtraHoldMs: 2500,
        rateLimitDynamicBudgetFloor: 3,
      });
      engine._initializeAdaptiveParallel(8);

      engine._onRateLimitSignal(1000);
      expect(engine._getRateLimitLaunchHoldRemainingMs()).toBe(1000);
      engine._onRateLimitSignal(1000);

      expect(engine._getRateLimitLaunchHoldRemainingMs()).toBe(2500);
      expect(engine._getLaunchBudgetConfig().budgetPerMinute).toBe(4);

      engine._onRateLimitSignal(1000);
      expect(engine._getLaunchBudgetConfig().budgetPerMinute).toBe(3);
      expect(engine._getRateLimitLaunchHoldRemainingMs()).toBe(5000);
    });

    test('start applies runtime configOverrides without mutating persisted config', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({
        maxParallel: 3,
        maxRetries: 2,
        timeoutSeconds: 600,
        rateLimitLaunchBudgetPerMinute: 8,
        rateLimitSignalThreshold: 3,
      });

      const result = await engine.start(['spec-a'], {
        configOverrides: {
          rateLimitLaunchBudgetPerMinute: 2,
          rateLimitSignalThreshold: 2,
        }
      });

      expect(result.status).toBe('completed');
      expect(engine._rateLimitLaunchBudgetPerMinute).toBe(2);
      expect(engine._rateLimitSignalThreshold).toBe(2);
      expect(mockConfig.getConfig).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Failure Propagation (Req 3.6)
  // -------------------------------------------------------------------------

  describe('failure propagation (Req 3.6)', () => {
    test('failed spec → dependents marked as skipped', async () => {
      // A → B (B depends on A). A fails → B skipped
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a', 'spec-b'],
        edges: [{ from: 'spec-b', to: 'spec-a' }],
      });
      mockConfig.getConfig.mockResolvedValue({ maxParallel: 3, maxRetries: 0 });

      mockSpawner.spawn.mockImplementation((specName) => {
        const agentId = `agent-${specName}`;
        process.nextTick(() => {
          if (specName === 'spec-a') {
            mockSpawner.emit('agent:failed', {
              agentId, specName, exitCode: 1, stderr: 'error',
            });
          } else {
            mockSpawner.emit('agent:completed', { agentId, specName, exitCode: 0 });
          }
        });
        return Promise.resolve({ agentId, specName, status: 'running' });
      });

      const result = await engine.start(['spec-a', 'spec-b']);

      expect(result.failed).toContain('spec-a');
      expect(result.skipped).toContain('spec-b');
      // spec-b should never have been spawned
      const spawnedSpecs = mockSpawner.spawn.mock.calls.map(c => c[0]);
      expect(spawnedSpecs).not.toContain('spec-b');
    });

    test('indirect dependents also skipped', async () => {
      // A → B → C (C depends on B, B depends on A). A fails → B,C skipped
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a', 'spec-b', 'spec-c'],
        edges: [
          { from: 'spec-b', to: 'spec-a' },
          { from: 'spec-c', to: 'spec-b' },
        ],
      });
      mockConfig.getConfig.mockResolvedValue({ maxParallel: 3, maxRetries: 0 });

      mockSpawner.spawn.mockImplementation((specName) => {
        const agentId = `agent-${specName}`;
        process.nextTick(() => {
          mockSpawner.emit('agent:failed', {
            agentId, specName, exitCode: 1, stderr: 'error',
          });
        });
        return Promise.resolve({ agentId, specName, status: 'running' });
      });

      const result = await engine.start(['spec-a', 'spec-b', 'spec-c']);

      expect(result.failed).toContain('spec-a');
      expect(result.skipped).toContain('spec-b');
      expect(result.skipped).toContain('spec-c');
    });
  });

  // -------------------------------------------------------------------------
  // Retry (Req 5.2, 5.3)
  // -------------------------------------------------------------------------

  describe('retry (Req 5.2, 5.3)', () => {
    test('failed spec retried up to maxRetries', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({ maxParallel: 3, maxRetries: 2 });

      let callCount = 0;
      mockSpawner.spawn.mockImplementation((specName) => {
        callCount++;
        const agentId = `agent-${specName}-${callCount}`;
        process.nextTick(() => {
          if (callCount <= 2) {
            // First 2 calls fail (original + 1 retry)
            mockSpawner.emit('agent:failed', {
              agentId, specName, exitCode: 1, stderr: 'error',
            });
          } else {
            // Third call (2nd retry) succeeds
            mockSpawner.emit('agent:completed', { agentId, specName, exitCode: 0 });
          }
        });
        return Promise.resolve({ agentId, specName, status: 'running' });
      });

      const result = await engine.start(['spec-a']);

      // spawn called 3 times: original + 2 retries
      expect(mockSpawner.spawn).toHaveBeenCalledTimes(3);
      expect(result.completed).toContain('spec-a');
      expect(result.failed).not.toContain('spec-a');
    });

    test('after maxRetries exhausted → final failure', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({ maxParallel: 3, maxRetries: 1 });

      mockSpawner.spawn.mockImplementation((specName) => {
        const agentId = `agent-${specName}`;
        process.nextTick(() => {
          mockSpawner.emit('agent:failed', {
            agentId, specName, exitCode: 1, stderr: 'always fails',
          });
        });
        return Promise.resolve({ agentId, specName, status: 'running' });
      });

      const result = await engine.start(['spec-a']);

      // spawn called 2 times: original + 1 retry
      expect(mockSpawner.spawn).toHaveBeenCalledTimes(2);
      expect(result.failed).toContain('spec-a');
      expect(result.status).toBe('failed');
    });

    test('incrementRetry called on StatusMonitor during retry', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({ maxParallel: 3, maxRetries: 1 });

      let callCount = 0;
      mockSpawner.spawn.mockImplementation((specName) => {
        callCount++;
        const agentId = `agent-${specName}-${callCount}`;
        process.nextTick(() => {
          if (callCount === 1) {
            mockSpawner.emit('agent:failed', {
              agentId, specName, exitCode: 1, stderr: 'error',
            });
          } else {
            mockSpawner.emit('agent:completed', { agentId, specName, exitCode: 0 });
          }
        });
        return Promise.resolve({ agentId, specName, status: 'running' });
      });

      await engine.start(['spec-a']);

      expect(mockStatusMonitor.incrementRetry).toHaveBeenCalledWith('spec-a');
    });

    test('rate-limit errors use backoff before retry', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({
        maxParallel: 3,
        maxRetries: 1,
        rateLimitBackoffBaseMs: 200,
        rateLimitBackoffMaxMs: 10000,
        rateLimitRetrySpreadMs: 0,
      });

      engine._random = () => 0; // deterministic jitter floor (50%)
      const sleepSpy = jest.spyOn(engine, '_sleep').mockResolvedValue(undefined);

      let callCount = 0;
      mockSpawner.spawn.mockImplementation((specName) => {
        callCount++;
        const agentId = `agent-${specName}-${callCount}`;
        process.nextTick(() => {
          if (callCount === 1) {
            mockSpawner.emit('agent:failed', {
              agentId, specName, exitCode: 1, stderr: '429 Too Many Requests',
            });
          } else {
            mockSpawner.emit('agent:completed', { agentId, specName, exitCode: 0 });
          }
        });
        return Promise.resolve({ agentId, specName, status: 'running' });
      });

      const result = await engine.start(['spec-a']);

      expect(mockSpawner.spawn).toHaveBeenCalledTimes(2);
      expect(sleepSpy).toHaveBeenCalledTimes(1);
      expect(sleepSpy).toHaveBeenCalledWith(100);
      expect(mockStatusMonitor.recordRateLimitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          specName: 'spec-a',
          retryDelayMs: 100,
        })
      );
      expect(result.completed).toContain('spec-a');
      sleepSpy.mockRestore();
    });

    test('rate-limit retry-after hint is clamped by backoff max', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({
        maxParallel: 3,
        maxRetries: 1,
        rateLimitBackoffBaseMs: 200,
        rateLimitBackoffMaxMs: 5000,
        rateLimitRetrySpreadMs: 0,
      });

      engine._random = () => 0; // computed backoff = 100ms
      const sleepSpy = jest.spyOn(engine, '_sleep').mockResolvedValue(undefined);

      let callCount = 0;
      mockSpawner.spawn.mockImplementation((specName) => {
        callCount++;
        const agentId = `agent-${specName}-${callCount}`;
        process.nextTick(() => {
          if (callCount === 1) {
            mockSpawner.emit('agent:failed', {
              agentId,
              specName,
              exitCode: 1,
              stderr: '429 Too Many Requests. Retry-After: 7',
            });
          } else {
            mockSpawner.emit('agent:completed', { agentId, specName, exitCode: 0 });
          }
        });
        return Promise.resolve({ agentId, specName, status: 'running' });
      });

      const result = await engine.start(['spec-a']);

      expect(mockSpawner.spawn).toHaveBeenCalledTimes(2);
      expect(sleepSpy).toHaveBeenCalledTimes(1);
      expect(sleepSpy).toHaveBeenCalledWith(5000);
      expect(mockStatusMonitor.recordRateLimitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          specName: 'spec-a',
          retryDelayMs: 5000,
        })
      );
      expect(result.completed).toContain('spec-a');
      sleepSpy.mockRestore();
    });

    test('rate-limit errors honor retry-after hints when higher than computed backoff', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({
        maxParallel: 3,
        maxRetries: 1,
        rateLimitBackoffBaseMs: 200,
        rateLimitBackoffMaxMs: 10000,
        rateLimitRetrySpreadMs: 0,
      });

      engine._random = () => 0; // computed backoff = 100ms
      const sleepSpy = jest.spyOn(engine, '_sleep').mockResolvedValue(undefined);

      let callCount = 0;
      mockSpawner.spawn.mockImplementation((specName) => {
        callCount++;
        const agentId = `agent-${specName}-${callCount}`;
        process.nextTick(() => {
          if (callCount === 1) {
            mockSpawner.emit('agent:failed', {
              agentId,
              specName,
              exitCode: 1,
              stderr: '429 Too Many Requests. Retry-After: 7',
            });
          } else {
            mockSpawner.emit('agent:completed', { agentId, specName, exitCode: 0 });
          }
        });
        return Promise.resolve({ agentId, specName, status: 'running' });
      });

      const result = await engine.start(['spec-a']);

      expect(mockSpawner.spawn).toHaveBeenCalledTimes(2);
      expect(sleepSpy).toHaveBeenCalledTimes(1);
      expect(sleepSpy).toHaveBeenCalledWith(7000);
      expect(mockStatusMonitor.recordRateLimitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          specName: 'spec-a',
          retryDelayMs: 7000,
        })
      );
      expect(result.completed).toContain('spec-a');
      sleepSpy.mockRestore();
    });

    test('non-rate-limit retries do not apply backoff sleep', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({
        maxParallel: 3,
        maxRetries: 1,
        rateLimitBackoffBaseMs: 200,
        rateLimitBackoffMaxMs: 5000,
      });

      const sleepSpy = jest.spyOn(engine, '_sleep').mockResolvedValue(undefined);

      let callCount = 0;
      mockSpawner.spawn.mockImplementation((specName) => {
        callCount++;
        const agentId = `agent-${specName}-${callCount}`;
        process.nextTick(() => {
          if (callCount === 1) {
            mockSpawner.emit('agent:failed', {
              agentId, specName, exitCode: 1, stderr: 'build error',
            });
          } else {
            mockSpawner.emit('agent:completed', { agentId, specName, exitCode: 0 });
          }
        });
        return Promise.resolve({ agentId, specName, status: 'running' });
      });

      const result = await engine.start(['spec-a']);

      expect(mockSpawner.spawn).toHaveBeenCalledTimes(2);
      expect(sleepSpy).not.toHaveBeenCalled();
      expect(result.completed).toContain('spec-a');
      sleepSpy.mockRestore();
    });

    test('rate-limit retries use rateLimitMaxRetries when maxRetries is lower', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({
        maxParallel: 3,
        maxRetries: 0,
        rateLimitMaxRetries: 2,
        rateLimitBackoffBaseMs: 200,
        rateLimitBackoffMaxMs: 5000,
      });

      const sleepSpy = jest.spyOn(engine, '_sleep').mockResolvedValue(undefined);

      let callCount = 0;
      mockSpawner.spawn.mockImplementation((specName) => {
        callCount++;
        const agentId = `agent-${specName}-${callCount}`;
        process.nextTick(() => {
          mockSpawner.emit('agent:failed', {
            agentId, specName, exitCode: 1, stderr: 'rate limit exceeded',
          });
        });
        return Promise.resolve({ agentId, specName, status: 'running' });
      });

      const result = await engine.start(['spec-a']);

      expect(result.status).toBe('failed');
      expect(mockSpawner.spawn).toHaveBeenCalledTimes(3); // initial + 2 rate-limit retries
      expect(sleepSpy).toHaveBeenCalledTimes(2);
      sleepSpy.mockRestore();
    });

    test('burst 429 under high parallelism converges without deadlock', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a', 'spec-b', 'spec-c', 'spec-d'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({
        maxParallel: 4,
        maxRetries: 0,
        timeoutSeconds: 60,
        rateLimitMaxRetries: 2,
        rateLimitBackoffBaseMs: 50,
        rateLimitBackoffMaxMs: 50,
        rateLimitAdaptiveParallel: true,
        rateLimitParallelFloor: 1,
        rateLimitCooldownMs: 1000,
      });

      const sleepSpy = jest.spyOn(engine, '_sleep').mockResolvedValue(undefined);
      const attempts = new Map();
      const specs = ['spec-a', 'spec-b', 'spec-c', 'spec-d'];

      mockSpawner.spawn.mockImplementation((specName) => {
        const attempt = (attempts.get(specName) || 0) + 1;
        attempts.set(specName, attempt);
        const agentId = `agent-${specName}-${attempt}`;
        process.nextTick(() => {
          if (attempt === 1) {
            mockSpawner.emit('agent:failed', {
              agentId,
              specName,
              exitCode: 1,
              stderr: '429 Too Many Requests',
            });
            return;
          }
          mockSpawner.emit('agent:completed', { agentId, specName, exitCode: 0 });
        });
        return Promise.resolve({ agentId, specName, status: 'running' });
      });

      const result = await engine.start(specs);

      expect(result.status).toBe('completed');
      expect(result.completed).toEqual(expect.arrayContaining(specs));
      expect(mockSpawner.spawn).toHaveBeenCalledTimes(8); // 4 initial + 4 retry
      expect(mockStatusMonitor.recordRateLimitEvent).toHaveBeenCalledTimes(4);
      expect(mockStatusMonitor.updateParallelTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'throttled', reason: 'rate-limit' })
      );
      sleepSpy.mockRestore();
    });

    test('rate-limit retries apply deterministic spread to reduce synchronized retries', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-alpha', 'spec-beta'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({
        maxParallel: 2,
        maxRetries: 1,
        rateLimitBackoffBaseMs: 200,
        rateLimitBackoffMaxMs: 10000,
        rateLimitAdaptiveParallel: false,
        rateLimitRetrySpreadMs: 200,
        rateLimitDecisionEventThrottleMs: 0,
      });

      engine._random = () => 0; // base backoff = 100ms
      const sleepSpy = jest.spyOn(engine, '_sleep').mockResolvedValue(undefined);
      const attempts = new Map();
      const rateLimitedEvents = [];
      engine.on('spec:rate-limited', (event) => {
        rateLimitedEvents.push(event);
      });

      mockSpawner.spawn.mockImplementation((specName) => {
        const attempt = (attempts.get(specName) || 0) + 1;
        attempts.set(specName, attempt);
        const agentId = `agent-${specName}-${attempt}`;
        process.nextTick(() => {
          if (attempt === 1) {
            mockSpawner.emit('agent:failed', {
              agentId,
              specName,
              exitCode: 1,
              stderr: '429 Too Many Requests',
            });
            return;
          }
          mockSpawner.emit('agent:completed', { agentId, specName, exitCode: 0 });
        });
        return Promise.resolve({ agentId, specName, status: 'running' });
      });

      const result = await engine.start(['spec-alpha', 'spec-beta']);

      expect(result.status).toBe('completed');
      const retrySleeps = sleepSpy.mock.calls.map(([ms]) => ms).filter((ms) => ms > 0);
      expect(retrySleeps).toHaveLength(2);
      expect(retrySleeps.every((ms) => ms >= 100 && ms <= 300)).toBe(true);
      expect(retrySleeps.some((ms) => ms > 100)).toBe(true);
      expect(rateLimitedEvents).toHaveLength(2);
      expect(rateLimitedEvents[0]).toEqual(expect.objectContaining({
        retryBaseDelayMs: 100,
        retryHintMs: 0,
        retrySpreadMs: expect.any(Number),
      }));
      expect(rateLimitedEvents[1]).toEqual(expect.objectContaining({
        retryBaseDelayMs: 100,
        retryHintMs: 0,
        retrySpreadMs: expect.any(Number),
      }));
      sleepSpy.mockRestore();
    });

    test('launch hold polling interval is configurable and emits machine-readable decision events', async () => {
      let now = 0;
      engine._now = () => now;
      engine._applyRetryPolicyConfig({
        rateLimitLaunchHoldPollMs: 250,
        rateLimitDecisionEventThrottleMs: 0,
      });
      engine._initializeAdaptiveParallel(1);
      engine._rateLimitLaunchHoldUntil = 1000;

      const decisions = [];
      engine.on('rate-limit:decision', (event) => {
        decisions.push(event);
      });

      const sleepSpy = jest.spyOn(engine, '_sleep').mockImplementation(async (ms) => {
        now += ms;
      });
      const executeSpy = jest.spyOn(engine, '_executeSpec').mockResolvedValue(undefined);

      await engine._executeSpecsInParallel(['spec-a'], 1, 0);

      expect(executeSpy).toHaveBeenCalledWith('spec-a', 0);
      expect(sleepSpy.mock.calls.map(([ms]) => ms)).toEqual([250, 250, 250, 250]);
      expect(decisions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          decision: 'launch-hold',
          reason: 'rate-limit-retry-hold',
          sleepMs: 250,
        })
      ]));

      executeSpy.mockRestore();
      sleepSpy.mockRestore();
    });

    test('waitForAgent has fallback timeout when lifecycle events are missing', async () => {
      jest.useFakeTimers();
      try {
        engine._agentWaitTimeoutMs = 200;
        const waitPromise = engine._waitForAgent('spec-a', 'agent-spec-a');
        jest.advanceTimersByTime(250);
        await expect(waitPromise).resolves.toEqual(expect.objectContaining({
          status: 'timeout',
          error: expect.stringContaining('without lifecycle events'),
        }));
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Result summary contract (Req 5.2, 5.3)
  // -------------------------------------------------------------------------

  describe('result summary contract and merge policy', () => {
    test('enforces required summary when baseline policy enables require_result_summary', async () => {
      fsUtils.pathExists.mockImplementation(async () => true);
      fsUtils.readJSON.mockResolvedValue({
        coordination_rules: {
          require_result_summary: true,
          block_merge_on_failed_tests: true,
          block_merge_on_unresolved_conflicts: true
        },
        result_summary_contract: {
          required_fields: [
            'spec_id',
            'changed_files',
            'tests_run',
            'tests_passed',
            'risk_level',
            'open_issues'
          ]
        }
      });
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({
        maxParallel: 3,
        maxRetries: 0,
      });
      mockSpawner.getResultSummary.mockReturnValue(null);

      const result = await engine.start(['spec-a']);

      expect(result.status).toBe('failed');
      expect(result.failed).toContain('spec-a');
      expect(fsUtils.readJSON).toHaveBeenCalled();
    });

    test('fails when summary contract is required but missing', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({
        maxParallel: 3,
        maxRetries: 0,
        coordinationRules: {
          require_result_summary: true,
          block_merge_on_failed_tests: true,
          block_merge_on_unresolved_conflicts: true,
        },
      });
      mockSpawner.getResultSummary.mockReturnValue(null);

      const result = await engine.start(['spec-a']);

      expect(result.status).toBe('failed');
      expect(result.failed).toContain('spec-a');
      expect(result.error).toBeNull();
      expect(mockStatusMonitor.updateSpecStatus).toHaveBeenCalledWith(
        'spec-a',
        'failed',
        'agent-spec-a',
        expect.stringContaining('result summary contract missing')
      );
    });

    test('fails when summary contract payload is invalid', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({
        maxParallel: 3,
        maxRetries: 0,
        coordinationRules: {
          require_result_summary: true,
        },
      });
      mockSpawner.getResultSummary.mockReturnValue({
        spec_id: 'spec-a',
        changed_files: [],
        tests_run: 2,
        tests_passed: 3,
        risk_level: 'critical',
        open_issues: []
      });

      const result = await engine.start(['spec-a']);

      expect(result.status).toBe('failed');
      expect(result.failed).toContain('spec-a');
      expect(mockStatusMonitor.updateSpecStatus).toHaveBeenCalledWith(
        'spec-a',
        'failed',
        'agent-spec-a',
        expect.stringContaining('result summary contract invalid')
      );
    });

    test('blocks merge when summary reports failed tests', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({
        maxParallel: 3,
        maxRetries: 0,
        coordinationRules: {
          require_result_summary: true,
          block_merge_on_failed_tests: true,
        },
      });
      mockSpawner.getResultSummary.mockReturnValue({
        spec_id: 'spec-a',
        changed_files: ['src/a.js'],
        tests_run: 5,
        tests_passed: 4,
        risk_level: 'medium',
        open_issues: []
      });

      const result = await engine.start(['spec-a']);

      expect(result.status).toBe('failed');
      expect(result.failed).toContain('spec-a');
      expect(result.completed).not.toContain('spec-a');
      expect(result.result_summaries['spec-a']).toBeUndefined();
      expect(mockStatusMonitor.updateSpecStatus).toHaveBeenCalledWith(
        'spec-a',
        'failed',
        'agent-spec-a',
        expect.stringContaining('merge blocked')
      );
    });

    test('stores validated summary when merge policy passes', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({
        maxParallel: 3,
        maxRetries: 0,
        coordinationRules: {
          require_result_summary: true,
          block_merge_on_failed_tests: true,
          block_merge_on_unresolved_conflicts: true,
        },
      });
      mockSpawner.getResultSummary.mockReturnValue({
        spec_id: 'spec-a',
        changed_files: ['src/a.js'],
        tests_run: 2,
        tests_passed: 2,
        risk_level: 'low',
        open_issues: []
      });

      const result = await engine.start(['spec-a']);

      expect(result.status).toBe('completed');
      expect(result.result_summaries['spec-a']).toEqual(expect.objectContaining({
        spec_id: 'spec-a',
        tests_run: 2,
        tests_passed: 2,
        risk_level: 'low'
      }));
    });
  });

  // -------------------------------------------------------------------------
  // Stop (Req 5.5)
  // -------------------------------------------------------------------------

  describe('stop (Req 5.5)', () => {
    test('stop() calls killAll and marks as stopped', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });

      // Spawn but never complete — hold the agent running
      mockSpawner.spawn.mockImplementation((specName) => {
        const agentId = `agent-${specName}`;
        // Do NOT emit completion — agent stays running
        return Promise.resolve({ agentId, specName, status: 'running' });
      });

      // Start orchestration in background
      const startPromise = engine.start(['spec-a']);

      // Wait for spawn to be called
      await flushPromises();

      // Now stop
      await engine.stop();

      expect(mockSpawner.killAll).toHaveBeenCalled();
      expect(mockStatusMonitor.setOrchestrationState).toHaveBeenCalledWith('stopped');

      // The start promise should eventually resolve with stopped status
      // Emit completion so _waitForAgent resolves
      mockSpawner.emit('agent:completed', {
        agentId: 'agent-spec-a', specName: 'spec-a', exitCode: 0,
      });

      const result = await startPromise;
      expect(result.status).toBe('stopped');
    });

    test('stop() when not running is a no-op', async () => {
      await engine.stop();
      expect(mockSpawner.killAll).not.toHaveBeenCalled();
    });

    test('stop() interrupts pending retry sleeps to avoid stuck rate-limit waits', async () => {
      jest.useFakeTimers();
      try {
        const settled = jest.fn();
        const sleepPromise = engine._sleep(60000).then(settled);
        await Promise.resolve();

        await engine.stop();
        await Promise.resolve();
        await sleepPromise;

        expect(settled).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Spec Existence Validation (Req 6.4)
  // -------------------------------------------------------------------------

  describe('spec existence validation (Req 6.4)', () => {
    test('missing specs → failed result listing missing specs', async () => {
      fsUtils.pathExists.mockImplementation((specDir) => {
        if (specDir.includes('missing-spec')) return Promise.resolve(false);
        return Promise.resolve(true);
      });

      const result = await engine.start(['good-spec', 'missing-spec']);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('missing-spec');
      expect(mockSpawner.spawn).not.toHaveBeenCalled();
    });

    test('all specs exist → proceeds normally', async () => {
      fsUtils.pathExists.mockResolvedValue(true);
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });

      const result = await engine.start(['spec-a']);

      expect(result.status).not.toBe('failed');
      expect(mockSpawner.spawn).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  describe('events', () => {
    test('emits batch:start and batch:complete', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });

      const batchStartHandler = jest.fn();
      const batchCompleteHandler = jest.fn();
      engine.on('batch:start', batchStartHandler);
      engine.on('batch:complete', batchCompleteHandler);

      await engine.start(['spec-a']);

      expect(batchStartHandler).toHaveBeenCalledWith(
        expect.objectContaining({ batch: 0, specs: ['spec-a'] })
      );
      expect(batchCompleteHandler).toHaveBeenCalledWith(
        expect.objectContaining({ batch: 0 })
      );
    });

    test('emits spec:start and spec:complete on success', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });

      const specStartHandler = jest.fn();
      const specCompleteHandler = jest.fn();
      engine.on('spec:start', specStartHandler);
      engine.on('spec:complete', specCompleteHandler);

      await engine.start(['spec-a']);

      expect(specStartHandler).toHaveBeenCalledWith(
        expect.objectContaining({ specName: 'spec-a' })
      );
      expect(specCompleteHandler).toHaveBeenCalledWith(
        expect.objectContaining({ specName: 'spec-a', agentId: 'agent-spec-a' })
      );
    });

    test('emits spec:failed on failure', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({ maxParallel: 3, maxRetries: 0 });

      mockSpawner.spawn.mockImplementation((specName) => {
        const agentId = `agent-${specName}`;
        process.nextTick(() => {
          mockSpawner.emit('agent:failed', {
            agentId, specName, exitCode: 1, stderr: 'boom',
          });
        });
        return Promise.resolve({ agentId, specName, status: 'running' });
      });

      const specFailedHandler = jest.fn();
      engine.on('spec:failed', specFailedHandler);

      await engine.start(['spec-a']);

      expect(specFailedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          specName: 'spec-a',
          agentId: 'agent-spec-a',
          error: expect.any(String),
        })
      );
    });

    test('emits orchestration:complete', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });

      const orchCompleteHandler = jest.fn();
      engine.on('orchestration:complete', orchCompleteHandler);

      await engine.start(['spec-a']);

      expect(orchCompleteHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          status: expect.any(String),
          plan: expect.any(Object),
          completed: expect.any(Array),
          failed: expect.any(Array),
          skipped: expect.any(Array),
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // SLM Integration (Req 8.1, 8.2)
  // -------------------------------------------------------------------------

  describe('SLM integration (Req 8.1, 8.2)', () => {
    test('transitions through assigned → in-progress → completed', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });

      await engine.start(['spec-a']);

      const transitionCalls = mockSLM.transition.mock.calls.map(c => c);
      // Should have: assigned, in-progress, completed
      expect(transitionCalls).toEqual(
        expect.arrayContaining([
          ['spec-a', 'assigned'],
          ['spec-a', 'in-progress'],
          ['spec-a', 'completed'],
        ])
      );
    });

    test('SLM transition failure is non-fatal', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });
      mockSLM.transition.mockRejectedValue(new Error('SLM unavailable'));

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await engine.start(['spec-a']);

      // Should still complete despite SLM failures
      expect(result.completed).toContain('spec-a');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // StatusMonitor Integration
  // -------------------------------------------------------------------------

  describe('StatusMonitor integration', () => {
    test('initSpec called for each spec with batch index', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a', 'spec-b'],
        edges: [{ from: 'spec-b', to: 'spec-a' }],
      });

      await engine.start(['spec-a', 'spec-b']);

      expect(mockStatusMonitor.initSpec).toHaveBeenCalledWith('spec-a', 0);
      expect(mockStatusMonitor.initSpec).toHaveBeenCalledWith('spec-b', 1);
    });

    test('setBatchInfo called with batch progress', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });

      await engine.start(['spec-a']);

      // Initial setBatchInfo(0, 1) then setBatchInfo(1, 1) during execution
      expect(mockStatusMonitor.setBatchInfo).toHaveBeenCalledWith(0, 1);
      expect(mockStatusMonitor.setBatchInfo).toHaveBeenCalledWith(1, 1);
    });

    test('updateSpecStatus called with running then completed', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });

      await engine.start(['spec-a']);

      expect(mockStatusMonitor.updateSpecStatus).toHaveBeenCalledWith('spec-a', 'running');
      expect(mockStatusMonitor.updateSpecStatus).toHaveBeenCalledWith(
        'spec-a', 'completed', 'agent-spec-a'
      );
    });

    test('syncExternalStatus called on completion', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });

      await engine.start(['spec-a']);

      expect(mockStatusMonitor.syncExternalStatus).toHaveBeenCalledWith('spec-a', 'completed');
    });

    test('setOrchestrationState tracks lifecycle', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });

      await engine.start(['spec-a']);

      const states = mockStatusMonitor.setOrchestrationState.mock.calls.map(c => c[0]);
      expect(states[0]).toBe('running');
      expect(states[states.length - 1]).toBe('completed');
    });
  });

  // -------------------------------------------------------------------------
  // getStatus()
  // -------------------------------------------------------------------------

  describe('getStatus()', () => {
    test('delegates to StatusMonitor.getOrchestrationStatus', () => {
      const mockStatus = { status: 'running', totalSpecs: 5 };
      mockStatusMonitor.getOrchestrationStatus.mockReturnValue(mockStatus);

      const status = engine.getStatus();

      expect(status).toBe(mockStatus);
      expect(mockStatusMonitor.getOrchestrationStatus).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Already running guard
  // -------------------------------------------------------------------------

  describe('already running guard', () => {
    test('throws if start() called while already running', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });

      // Hold the agent running so orchestration stays in 'running' state
      mockSpawner.spawn.mockImplementation((specName) => {
        const agentId = `agent-${specName}`;
        return Promise.resolve({ agentId, specName, status: 'running' });
      });

      // Start first orchestration (will hang waiting for agent)
      const firstStart = engine.start(['spec-a']);
      await flushPromises();

      // Try to start again
      await expect(engine.start(['spec-a'])).rejects.toThrow(
        'Orchestration is already running'
      );

      // Cleanup: emit completion so first start resolves
      mockSpawner.emit('agent:completed', {
        agentId: 'agent-spec-a', specName: 'spec-a', exitCode: 0,
      });
      await firstStart;
    });
  });

  // -------------------------------------------------------------------------
  // Timeout handling (via agent:timeout event)
  // -------------------------------------------------------------------------

  describe('timeout handling (Req 5.4)', () => {
    test('agent timeout treated as failure', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({ maxParallel: 3, maxRetries: 0 });

      mockSpawner.spawn.mockImplementation((specName) => {
        const agentId = `agent-${specName}`;
        process.nextTick(() => {
          mockSpawner.emit('agent:timeout', {
            agentId, specName, timeoutSeconds: 600,
          });
        });
        return Promise.resolve({ agentId, specName, status: 'running' });
      });

      const result = await engine.start(['spec-a']);

      expect(result.failed).toContain('spec-a');
      expect(result.status).toBe('failed');
    });
  });

  // -------------------------------------------------------------------------
  // Spawn failure (Req 5.1)
  // -------------------------------------------------------------------------

  describe('spawn failure (Req 5.1)', () => {
    test('spawn rejection triggers retry then failure', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });
      mockConfig.getConfig.mockResolvedValue({ maxParallel: 3, maxRetries: 0 });

      mockSpawner.spawn.mockRejectedValue(new Error('spawn failed'));

      const result = await engine.start(['spec-a']);

      expect(result.failed).toContain('spec-a');
      expect(result.status).toBe('failed');
    });
  });

  // -------------------------------------------------------------------------
  // External sync failure is non-fatal
  // -------------------------------------------------------------------------

  describe('external sync failure', () => {
    test('syncExternalStatus failure is non-fatal', async () => {
      mockDependencyManager.buildDependencyGraph.mockResolvedValue({
        nodes: ['spec-a'],
        edges: [],
      });
      mockStatusMonitor.syncExternalStatus.mockRejectedValue(
        new Error('sync failed')
      );

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await engine.start(['spec-a']);

      expect(result.completed).toContain('spec-a');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
