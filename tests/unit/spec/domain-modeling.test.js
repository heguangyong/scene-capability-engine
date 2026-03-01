const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const {
  DOMAIN_MAP_RELATIVE_PATH,
  SCENE_SPEC_RELATIVE_PATH,
  DOMAIN_CHAIN_RELATIVE_PATH,
  DOMAIN_CHAIN_API_VERSION,
  buildProblemDomainMindMap,
  buildSceneSpec,
  buildProblemDomainChain,
  ensureSpecDomainArtifacts,
  validateSpecDomainArtifacts
} = require('../../../lib/spec/domain-modeling');

describe('spec domain modeling', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-spec-domain-modeling-'));
    await fs.ensureDir(path.join(tempDir, '.sce', 'specs', '120-01-domain-test'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  test('builds deterministic mind map and scene spec templates', () => {
    const map = buildProblemDomainMindMap('120-01-domain-test', {
      sceneId: 'scene.customer-order',
      problemStatement: 'Need stable order approval flow'
    });
    const sceneSpec = buildSceneSpec('120-01-domain-test', {
      sceneId: 'scene.customer-order'
    });

    expect(map).toContain('# Problem Domain Mind Map');
    expect(map).toContain('```mermaid');
    expect(map).toContain('mindmap');
    expect(sceneSpec).toContain('# Scene Spec');
    expect(sceneSpec).toContain('## Ontology Coverage');
  });

  test('builds deterministic domain chain payload', () => {
    const chain = buildProblemDomainChain('120-01-domain-test', {
      sceneId: 'scene.customer-order'
    });
    expect(chain.api_version).toBe(DOMAIN_CHAIN_API_VERSION);
    expect(chain.scene_id).toBe('scene.customer-order');
    expect(chain.spec_id).toBe('120-01-domain-test');
    expect(Array.isArray(chain.decision_execution_path)).toBe(true);
    expect(chain.decision_execution_path.length).toBeGreaterThanOrEqual(3);
  });

  test('ensures required artifacts under spec custom directory', async () => {
    const result = await ensureSpecDomainArtifacts(tempDir, '120-01-domain-test', {
      sceneId: 'scene.customer-order'
    });

    expect(result.created.domain_map).toBe(true);
    expect(result.created.scene_spec).toBe(true);
    expect(result.created.domain_chain).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'specs', '120-01-domain-test', DOMAIN_MAP_RELATIVE_PATH))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'specs', '120-01-domain-test', SCENE_SPEC_RELATIVE_PATH))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'specs', '120-01-domain-test', DOMAIN_CHAIN_RELATIVE_PATH))).toBe(true);
  });

  test('validates required artifacts and mandatory sections', async () => {
    await ensureSpecDomainArtifacts(tempDir, '120-01-domain-test', {
      sceneId: 'scene.customer-order'
    });

    const validated = await validateSpecDomainArtifacts(tempDir, '120-01-domain-test');
    expect(validated.passed).toBe(true);
    expect(validated.ratio).toBe(1);
    expect(validated.warnings).toEqual([]);
  });

  test('fails validation when artifacts are missing', async () => {
    const validated = await validateSpecDomainArtifacts(tempDir, '120-01-domain-test');
    expect(validated.passed).toBe(false);
    expect(validated.ratio).toBe(0);
    expect(validated.warnings.length).toBeGreaterThanOrEqual(1);
  });
});
