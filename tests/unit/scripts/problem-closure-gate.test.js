'use strict';

const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {
  ensureSpecDomainArtifacts,
  DOMAIN_CHAIN_RELATIVE_PATH
} = require('../../../lib/spec/domain-modeling');
const {
  parseArgs,
  evaluateProblemClosureGate,
  runProblemClosureGateScript
} = require('../../../scripts/problem-closure-gate');

async function prepareReadySpecFixture(projectPath, specId, sceneId) {
  await fs.ensureDir(path.join(projectPath, '.sce', 'specs', specId));
  await ensureSpecDomainArtifacts(projectPath, specId, {
    fileSystem: fs,
    sceneId,
    problemStatement: 'Order approval blocks due to stale inventory reservation',
    primaryFlow: 'Reserve inventory before order confirmation',
    verificationPlan: 'Run deterministic order and inventory consistency tests'
  });

  const chainPath = path.join(projectPath, '.sce', 'specs', specId, DOMAIN_CHAIN_RELATIVE_PATH);
  const chain = await fs.readJson(chainPath);
  chain.problem.statement = 'Order approval fails when inventory reservation drifts from actual stock';
  chain.problem.scope = 'Order and inventory synchronization path';
  chain.problem.symptom = 'Order state remains pending while inventory is already reserved';
  chain.ontology.entity = ['Order', 'InventoryReservation'];
  chain.ontology.relation = ['Order references InventoryReservation'];
  chain.ontology.business_rule = ['Order cannot approve when reservation is stale'];
  chain.ontology.decision_policy = ['Approve only when reservation checksum matches'];
  chain.ontology.execution_flow = ['validate -> reconcile -> approve'];
  chain.hypotheses = [
    {
      id: 'H1',
      statement: 'Reservation checksum is stale after retry',
      evidence: ['debug: reservation checksum mismatch on retry path'],
      confidence: 'medium'
    }
  ];
  chain.risks = [
    {
      id: 'R1',
      type: 'data-integrity',
      statement: 'Approve may consume wrong inventory balance',
      mitigation: 'force checksum reconcile before approve'
    }
  ];
  chain.decision_execution_path = [
    { step: 1, action: 'entry', decision: 'new approval request', expected_result: 'request accepted' },
    { step: 2, action: 'check', decision: 'checksum match', expected_result: 'pass reconcile guard' },
    { step: 3, action: 'execute', decision: 'approve order', expected_result: 'order approved and inventory locked' }
  ];
  chain.correction_loop = {
    triggers: ['gate failure', 'checksum mismatch'],
    actions: ['attach debug evidence', 'rebuild reservation mapping']
  };
  chain.verification = {
    plan: 'Run order+inventory regression and release gates',
    gates: ['spec-gate', 'tests', 'release preflight']
  };
  chain.research_coverage = {
    mode: 'scene-closed-loop',
    required_dimensions: [
      'scene_boundary',
      'entity',
      'relation',
      'business_rule',
      'decision_policy',
      'execution_flow',
      'failure_signal',
      'debug_evidence_plan',
      'verification_gate'
    ],
    checklist: {
      scene_boundary: true,
      entity: true,
      relation: true,
      business_rule: true,
      decision_policy: true,
      execution_flow: true,
      failure_signal: true,
      debug_evidence_plan: true,
      verification_gate: true
    },
    status: 'ready'
  };
  chain.problem_contract = {
    schema_version: '1.0',
    spec_id: specId,
    scene_id: sceneId,
    issue_statement: 'Order approval enters stale reservation state',
    expected_outcome: 'Approval completes with consistent reservation state',
    reproduction_steps: [
      'Submit an order and trigger inventory reserve retry',
      'Approve the order and inspect reservation checksum log'
    ],
    impact_scope: 'order approval + inventory reserve path',
    forbidden_workarounds: [
      'Do not disable reservation checksum validation',
      'Do not skip release gates'
    ]
  };
  chain.ontology_evidence = {
    entity: ['entity:model/order-entity'],
    relation: ['relation:order-reservation-link'],
    business_rule: ['rule:reservation-checksum-guard'],
    decision_policy: ['decision:approval-checksum-policy'],
    execution_flow: ['flow:approve-order-pipeline']
  };
  await fs.writeJson(chainPath, chain, { spaces: 2 });
}

describe('problem-closure-gate script', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-problem-closure-gate-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  test('parseArgs supports policy and stage options', () => {
    const parsed = parseArgs([
      '--stage', 'verify',
      '--spec', '01-00-contract',
      '--policy', '.sce/config/problem-closure-policy.json',
      '--verify-report', '.sce/reports/studio/verify-job.json',
      '--json',
      '--fail-on-block'
    ]);

    expect(parsed.stage).toBe('verify');
    expect(parsed.spec).toBe('01-00-contract');
    expect(parsed.policy).toBe('.sce/config/problem-closure-policy.json');
    expect(parsed.verifyReport).toBe('.sce/reports/studio/verify-job.json');
    expect(parsed.json).toBe(true);
    expect(parsed.failOnBlock).toBe(true);
  });

  test('skips when spec is not provided', async () => {
    const payload = await evaluateProblemClosureGate({
      stage: 'verify',
      projectPath: tempDir
    });

    expect(payload.passed).toBe(true);
    expect(payload.skipped).toBe(true);
    expect(payload.violations).toEqual([]);
  });

  test('blocks release when verify report is missing', async () => {
    const specId = '01-00-release-verify-missing';
    await prepareReadySpecFixture(tempDir, specId, 'scene.release-missing');

    const payload = await evaluateProblemClosureGate({
      stage: 'release',
      spec: specId,
      projectPath: tempDir
    });

    expect(payload.passed).toBe(false);
    expect(payload.blocked).toBe(true);
    expect(payload.violations).toContain('verify report is required for release convergence gate');
  });

  test('passes release gate when domain and convergence checks are satisfied', async () => {
    const specId = '01-01-release-pass';
    await prepareReadySpecFixture(tempDir, specId, 'scene.release-pass');

    const verifyReportPath = path.join(tempDir, '.sce', 'reports', 'studio', 'verify-job-001.json');
    await fs.ensureDir(path.dirname(verifyReportPath));
    await fs.writeJson(verifyReportPath, {
      mode: 'studio-verify',
      passed: true,
      steps: [
        { id: 'unit-tests', status: 'passed', required: true },
        { id: 'interactive-governance-report', status: 'passed', required: true }
      ]
    }, { spaces: 2 });

    const governanceReportPath = path.join(tempDir, '.sce', 'reports', 'interactive-governance-report.json');
    await fs.ensureDir(path.dirname(governanceReportPath));
    await fs.writeJson(governanceReportPath, {
      mode: 'interactive-governance-report',
      alerts: [
        { id: 'sample-warning', status: 'warning', severity: 'low' }
      ]
    }, { spaces: 2 });

    const payload = await runProblemClosureGateScript({
      stage: 'release',
      spec: specId,
      verifyReport: '.sce/reports/studio/verify-job-001.json',
      projectPath: tempDir,
      json: true,
      failOnBlock: true
    });

    expect(payload.passed).toBe(true);
    expect(payload.exit_code).toBe(0);
    expect(payload.checks.convergence.verify_report.passed).toBe(true);
    expect(payload.checks.convergence.governance.high_breach_count).toBe(0);
  });
});

