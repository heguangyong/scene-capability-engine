const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const {
  DEFAULT_POLICY_PATH,
  DEFAULT_REPORT_DIR,
  normalizePolicy,
  evaluateProblemContext,
  collectIncidentSignals,
  runProblemEvaluation
} = require('../../../lib/problem/problem-evaluator');

describe('problem-evaluator', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-problem-eval-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  test('normalizes policy and applies env overrides', async () => {
    const policyPath = path.join(tempDir, DEFAULT_POLICY_PATH);
    await fs.ensureDir(path.dirname(policyPath));
    await fs.writeJson(policyPath, {
      enabled: true,
      mode: 'required',
      block_on_stages: ['apply']
    }, { spaces: 2 });

    const advisory = normalizePolicy({
      enabled: true,
      mode: 'required',
      block_on_stages: ['apply']
    }, {
      SCE_PROBLEM_EVAL_MODE: 'advisory'
    });
    expect(advisory.mode).toBe('advisory');
    expect(advisory.enabled).toBe(true);

    const disabled = normalizePolicy({
      enabled: true,
      mode: 'required'
    }, {
      SCE_PROBLEM_EVAL_DISABLED: '1'
    });
    expect(disabled.enabled).toBe(false);
  });

  test('blocks apply stage when required mode has low confidence', () => {
    const result = evaluateProblemContext({
      stage: 'apply',
      scene_id: '',
      spec_id: '',
      goal: '',
      stage_readiness: {
        prerequisites_ready: false,
        rollback_ready: false
      }
    }, normalizePolicy({
      mode: 'required',
      enabled: true,
      block_on_stages: ['apply'],
      min_confidence_by_stage: {
        apply: 80
      }
    }));

    expect(result.stage).toBe('apply');
    expect(result.blocked).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.blockers.some((item) => item.includes('confidence-too-low'))).toBe(true);
  });

  test('keeps advisory mode non-blocking even when confidence is below threshold', () => {
    const result = evaluateProblemContext({
      stage: 'apply',
      scene_id: '',
      spec_id: '',
      goal: '',
      stage_readiness: {
        prerequisites_ready: false
      }
    }, normalizePolicy({
      mode: 'advisory',
      enabled: true,
      block_on_stages: ['apply'],
      min_confidence_by_stage: {
        apply: 90
      }
    }));

    expect(result.policy.mode).toBe('advisory');
    expect(result.blocked).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test('requires debug evidence for repeated high-risk release attempts', () => {
    const result = evaluateProblemContext({
      stage: 'release',
      scene_id: 'scene.payment',
      goal: 'production payment rollback fix',
      release_channel: 'prod',
      incident_signals: {
        max_attempt_count: 4,
        has_debug_evidence: false,
        open_incident_count: 2
      },
      stage_readiness: {
        prerequisites_ready: true
      }
    }, normalizePolicy({
      mode: 'required',
      enabled: true,
      block_on_stages: ['release'],
      high_risk_requires_debug_evidence: true
    }));

    expect(result.blocked).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.dimensions.strategy.strategy).toBe('debug-first');
    expect(result.blockers).toContain('missing-debug-evidence-after-repeated-failures');
  });

  test('blocks plan stage when problem contract is incomplete', () => {
    const result = evaluateProblemContext({
      stage: 'plan',
      scene_id: '',
      goal: '',
      problem_contract: {
        issue_statement: '',
        expected_outcome: '',
        reproduction_steps: [],
        impact_scope: '',
        forbidden_workarounds: []
      },
      stage_readiness: {
        prerequisites_ready: true
      }
    }, normalizePolicy({
      mode: 'required',
      enabled: true,
      enforce_on_stages: ['plan'],
      problem_contract_required_stages: ['plan'],
      problem_contract_block_stages: ['plan']
    }));

    expect(result.blocked).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.blockers.some((item) => item.startsWith('problem-contract-incomplete'))).toBe(true);
  });

  test('blocks release when high-severity governance breaches are present', () => {
    const result = evaluateProblemContext({
      stage: 'release',
      scene_id: 'scene.governance',
      goal: 'release customer flow',
      stage_readiness: {
        prerequisites_ready: true,
        verify_report_ready: true,
        verify_stage_passed: true,
        regression_passed: true,
        gate_required_ready: true,
        high_alert_count: 2
      },
      gate_signals: {
        required_total: 3,
        required_enabled: 3,
        required_missing: 0
      }
    }, normalizePolicy({
      mode: 'required',
      enabled: true,
      enforce_on_stages: ['release'],
      block_on_stages: ['release'],
      convergence_required_stages: ['release'],
      convergence_block_stages: ['release'],
      release_block_on_high_alerts: true
    }));

    expect(result.blocked).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.blockers.some((item) => item.includes('convergence-gate-missing'))).toBe(true);
  });

  test('collects staging incident signals and detects debug evidence', async () => {
    const indexPath = path.join(tempDir, '.sce', 'errorbook', 'staging', 'index.json');
    const incidentsDir = path.join(tempDir, '.sce', 'errorbook', 'staging', 'incidents');
    await fs.ensureDir(incidentsDir);
    await fs.writeJson(indexPath, {
      incidents: [
        { id: 'inc-001', state: 'open' },
        { id: 'inc-002', state: 'resolved' }
      ]
    }, { spaces: 2 });
    await fs.writeJson(path.join(incidentsDir, 'inc-001.json'), {
      title: 'order approval failure',
      symptom: 'retry loop timeout',
      attempt_count: 4,
      attempts: [
        {
          source: { spec: '01-00-order-flow' },
          tags: ['debug-evidence'],
          notes: 'added debug trace around order approval service'
        }
      ]
    }, { spaces: 2 });
    await fs.writeJson(path.join(incidentsDir, 'inc-002.json'), {
      title: 'inventory cache issue',
      symptom: 'stale read',
      attempt_count: 1,
      attempts: [
        {
          source: { spec: '99-00-unrelated' },
          tags: ['candidate']
        }
      ]
    }, { spaces: 2 });

    const signals = await collectIncidentSignals(tempDir, {
      spec_id: '01-00-order-flow',
      scene_id: 'scene.order'
    });
    expect(signals.has_staging_data).toBe(true);
    expect(signals.total_incident_count).toBe(2);
    expect(signals.open_incident_count).toBe(1);
    expect(signals.resolved_incident_count).toBe(1);
    expect(signals.relevant_incident_count).toBe(1);
    expect(signals.max_attempt_count).toBe(4);
    expect(signals.has_debug_evidence).toBe(true);
  });

  test('runs evaluation and writes report artifact file', async () => {
    const report = await runProblemEvaluation({
      stage: 'plan',
      job_id: 'job-123',
      scene_id: 'scene.customer-order',
      spec_id: '01-00-customer-order',
      goal: 'bootstrap flow',
      stage_readiness: {
        prerequisites_ready: true
      }
    }, {
      projectPath: tempDir,
      fileSystem: fs,
      writeReport: true
    });

    expect(report.mode).toBe('problem-eval');
    expect(report.stage).toBe('plan');
    expect(report.report_file).toContain('.sce/reports/problem-eval/job-123-plan.json');

    const reportFilePath = path.join(tempDir, DEFAULT_REPORT_DIR, 'job-123-plan.json');
    expect(await fs.pathExists(reportFilePath)).toBe(true);
    const persisted = await fs.readJson(reportFilePath);
    expect(persisted.stage).toBe('plan');
    expect(persisted.job_id).toBe('job-123');
  });
});
