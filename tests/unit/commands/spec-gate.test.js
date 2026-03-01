const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const {
  runSpecGate,
  generateSpecGatePolicyTemplate,
  _parseSpecTargets
} = require('../../../lib/commands/spec-gate');
const { SessionStore } = require('../../../lib/runtime/session-store');

describe('spec-gate command', () => {
  let tempDir;
  let originalLog;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-spec-gate-'));
    await fs.ensureDir(path.join(tempDir, '.sce', 'config'));

    const specPath = path.join(tempDir, '.sce', 'specs', '111-01-gate-contract-test');
    const specPath2 = path.join(tempDir, '.sce', 'specs', '111-02-gate-contract-test');
    await fs.ensureDir(specPath);
    await fs.ensureDir(specPath2);

    await fs.writeFile(path.join(specPath, 'requirements.md'), '# Requirements\n', 'utf8');
    await fs.writeFile(path.join(specPath, 'design.md'), '# Design\n## Requirement Mapping\n', 'utf8');
    await fs.writeFile(path.join(specPath, 'tasks.md'), '- [ ] 1. Test task\n  - **Requirement**: Requirement 1\n  - **Design**: Design 1\n  - **Validation**: Acceptance Criteria\n', 'utf8');
    await fs.ensureDir(path.join(specPath, 'custom'));
    await fs.writeFile(path.join(specPath, 'custom', 'problem-domain-map.md'), '# Problem Domain Mind Map\n## Root Problem\n## Domain Mind Map\n```mermaid\nmindmap\n  root((test))\n```\n## Layered Exploration Chain\n## Correction Loop\n', 'utf8');
    await fs.writeFile(path.join(specPath, 'custom', 'scene-spec.md'), '# Scene Spec\n## Scene Definition\n## Ontology Coverage\n## Decision & Execution Path\n## Acceptance & Gate\n', 'utf8');
    await fs.writeJson(path.join(specPath, 'custom', 'problem-domain-chain.json'), {
      api_version: 'sce.problem-domain-chain/v0.1',
      scene_id: 'scene.test-default',
      spec_id: '111-01-gate-contract-test',
      problem: { statement: 'test problem' },
      ontology: {
        entity: ['order'],
        relation: ['customer->order'],
        business_rule: ['order must have status'],
        decision_policy: ['approval policy'],
        execution_flow: ['submit -> approve']
      },
      hypotheses: [{ id: 'H1', statement: 'lock issue' }],
      risks: [{ id: 'R1', type: 'wrong-direction', statement: 'scope drift' }],
      decision_execution_path: [{ step: 1 }, { step: 2 }, { step: 3 }],
      correction_loop: { triggers: ['gate failure'], actions: ['refresh map'] },
      verification: { gates: ['spec-gate'] }
    }, { spaces: 2 });
    await fs.writeFile(path.join(specPath2, 'requirements.md'), '# Requirements\n', 'utf8');
    await fs.writeFile(path.join(specPath2, 'design.md'), '# Design\n## Requirement Mapping\n', 'utf8');
    await fs.writeFile(path.join(specPath2, 'tasks.md'), '- [ ] 1. Test task\n  - **Requirement**: Requirement 1\n  - **Design**: Design 1\n  - **Validation**: Acceptance Criteria\n', 'utf8');
    await fs.ensureDir(path.join(specPath2, 'custom'));
    await fs.writeFile(path.join(specPath2, 'custom', 'problem-domain-map.md'), '# Problem Domain Mind Map\n## Root Problem\n## Domain Mind Map\n```mermaid\nmindmap\n  root((test))\n```\n## Layered Exploration Chain\n## Correction Loop\n', 'utf8');
    await fs.writeFile(path.join(specPath2, 'custom', 'scene-spec.md'), '# Scene Spec\n## Scene Definition\n## Ontology Coverage\n## Decision & Execution Path\n## Acceptance & Gate\n', 'utf8');
    await fs.writeJson(path.join(specPath2, 'custom', 'problem-domain-chain.json'), {
      api_version: 'sce.problem-domain-chain/v0.1',
      scene_id: 'scene.test-default',
      spec_id: '111-02-gate-contract-test',
      problem: { statement: 'test problem' },
      ontology: {
        entity: ['order'],
        relation: ['customer->order'],
        business_rule: ['order must have status'],
        decision_policy: ['approval policy'],
        execution_flow: ['submit -> approve']
      },
      hypotheses: [{ id: 'H1', statement: 'lock issue' }],
      risks: [{ id: 'R1', type: 'wrong-direction', statement: 'scope drift' }],
      decision_execution_path: [{ step: 1 }, { step: 2 }, { step: 3 }],
      correction_loop: { triggers: ['gate failure'], actions: ['refresh map'] },
      verification: { gates: ['spec-gate'] }
    }, { spaces: 2 });

    originalLog = console.log;
    console.log = jest.fn();

    const sessionStore = new SessionStore(tempDir);
    await sessionStore.beginSceneSession({
      sceneId: 'scene.test-default',
      objective: 'default scene for spec-gate tests'
    });
  });

  afterEach(async () => {
    console.log = originalLog;
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  test('returns standard json contract and writes report file', async () => {
    const result = await runSpecGate({
      spec: '111-01-gate-contract-test',
      json: true,
      out: 'reports/spec-gate-result.json'
    }, {
      projectPath: tempDir
    });

    expect(result).toHaveProperty('spec_id', '111-01-gate-contract-test');
    expect(result).toHaveProperty('run_id');
    expect(result).toHaveProperty('decision');
    expect(result).toHaveProperty('score');
    expect(Array.isArray(result.failed_checks)).toBe(true);
    expect(Array.isArray(result.next_actions)).toBe(true);

    const outPath = path.join(tempDir, 'reports', 'spec-gate-result.json');
    expect(await fs.pathExists(outPath)).toBe(true);
  });

  test('generates policy template file', async () => {
    const outputPath = path.join(tempDir, 'policy', 'spec-gate-policy.json');

    const response = await generateSpecGatePolicyTemplate({
      out: outputPath,
      silent: true
    }, {
      projectPath: tempDir
    });

    expect(response.success).toBe(true);
    expect(await fs.pathExists(outputPath)).toBe(true);

    const content = await fs.readJson(outputPath);
    expect(content).toHaveProperty('rules.mandatory');
    expect(content).toHaveProperty('thresholds.go');
  });

  test('defaults to orchestrate mode for multi-spec targets', async () => {
    const runOrchestration = jest.fn(async () => ({
      status: 'completed',
      totalSpecs: 2,
      completedSpecs: 2,
      failedSpecs: 0
    }));

    const result = await runSpecGate({
      specs: '111-01-gate-contract-test,111-02-gate-contract-test',
      json: true,
      maxParallel: 3
    }, {
      projectPath: tempDir,
      runOrchestration
    });

    expect(runOrchestration).toHaveBeenCalledWith(expect.objectContaining({
      specs: '111-01-gate-contract-test,111-02-gate-contract-test',
      maxParallel: 3,
      silent: true
    }), expect.any(Object));

    expect(result.mode).toBe('orchestrate');
    expect(result.status).toBe('completed');
    expect(result.spec_ids).toEqual(['111-01-gate-contract-test', '111-02-gate-contract-test']);
  });

  test('parses --spec and --specs into de-duplicated targets', () => {
    const targets = _parseSpecTargets({
      spec: '111-01-gate-contract-test',
      specs: '111-01-gate-contract-test, 111-02-gate-contract-test , '
    });

    expect(targets).toEqual(['111-01-gate-contract-test', '111-02-gate-contract-test']);
  });

  test('binds gate run as a child session when scene primary session is active', async () => {
    const sessionStore = new SessionStore(tempDir);
    const sceneSession = await sessionStore.beginSceneSession({
      sceneId: 'scene.gate-integration',
      objective: 'gate scene'
    });

    const result = await runSpecGate({
      spec: '111-01-gate-contract-test',
      scene: 'scene.gate-integration',
      json: true
    }, {
      projectPath: tempDir,
      sessionStore
    });

    expect(result.scene_session).toEqual(expect.objectContaining({
      bound: true,
      scene_id: 'scene.gate-integration',
      scene_session_id: sceneSession.session.session_id
    }));
    expect(result.scene_session.spec_session_id).toBeTruthy();

    const parent = await sessionStore.getSession(sceneSession.session.session_id);
    expect(parent.children.spec_sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        spec_id: '111-01-gate-contract-test'
      })
    ]));
  });

  test('fails when no active scene primary session exists', async () => {
    const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-spec-gate-no-scene-'));
    const specId = '111-09-gate-no-scene';
    const specPath = path.join(isolated, '.sce', 'specs', specId);
    await fs.ensureDir(specPath);
    await fs.writeFile(path.join(specPath, 'requirements.md'), '# Requirements\n', 'utf8');
    await fs.writeFile(path.join(specPath, 'design.md'), '# Design\n## Requirement Mapping\n', 'utf8');
    await fs.writeFile(path.join(specPath, 'tasks.md'), '- [ ] 1. Test task\n', 'utf8');

    await expect(runSpecGate({
      spec: specId,
      json: true
    }, {
      projectPath: isolated
    })).rejects.toThrow('No active scene session found');

    await fs.remove(isolated);
  });

  test('returns no-go when mandatory domain/scene artifacts are missing', async () => {
    const specId = '111-03-gate-domain-missing';
    const specPath = path.join(tempDir, '.sce', 'specs', specId);
    await fs.ensureDir(specPath);
    await fs.writeFile(path.join(specPath, 'requirements.md'), '# Requirements\n', 'utf8');
    await fs.writeFile(path.join(specPath, 'design.md'), '# Design\n## Requirement Mapping\n', 'utf8');
    await fs.writeFile(path.join(specPath, 'tasks.md'), '- [ ] 1. Test task\n  - **Validation**: Acceptance Criteria\n', 'utf8');
    await fs.ensureDir(path.join(specPath, 'custom'));
    await fs.writeFile(path.join(specPath, 'custom', 'problem-domain-map.md'), '# Problem Domain Mind Map\n## Root Problem\n## Domain Mind Map\n```mermaid\nmindmap\n  root((test))\n```\n## Layered Exploration Chain\n## Correction Loop\n', 'utf8');
    await fs.writeFile(path.join(specPath, 'custom', 'scene-spec.md'), '# Scene Spec\n## Scene Definition\n## Ontology Coverage\n## Decision & Execution Path\n## Acceptance & Gate\n', 'utf8');

    const result = await runSpecGate({
      spec: specId,
      json: true
    }, {
      projectPath: tempDir
    });

    expect(result.decision).toBe('no-go');
    expect(result.failed_checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'domain_scene_modeling', hard_fail: true })
    ]));
  });
});
