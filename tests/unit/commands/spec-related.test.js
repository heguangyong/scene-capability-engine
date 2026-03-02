const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const { runSpecRelatedCommand } = require('../../../lib/commands/spec-related');
const { ensureSpecDomainArtifacts } = require('../../../lib/spec/domain-modeling');

describe('spec-related command', () => {
  let tempDir;
  let originalLog;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-spec-related-'));
    originalLog = console.log;
    console.log = jest.fn();

    await fs.ensureDir(path.join(tempDir, '.sce', 'specs', '140-00-order-inventory'));
    await fs.ensureDir(path.join(tempDir, '.sce', 'specs', '141-00-customer-ledger'));

    await ensureSpecDomainArtifacts(tempDir, '140-00-order-inventory', {
      fileSystem: fs,
      force: true,
      sceneId: 'scene.customer-order-inventory',
      problemStatement: 'Order inventory reconciliation drift in fulfillment',
      primaryFlow: 'Create order reserve inventory and settle'
    });
    await ensureSpecDomainArtifacts(tempDir, '141-00-customer-ledger', {
      fileSystem: fs,
      force: true,
      sceneId: 'scene.customer-ledger',
      problemStatement: 'Customer ledger mismatch in settlement'
    });
  });

  afterEach(async () => {
    console.log = originalLog;
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  test('finds related specs by query and scene context', async () => {
    const result = await runSpecRelatedCommand({
      query: 'inventory reconciliation',
      scene: 'scene.customer-order-inventory',
      limit: '5',
      json: true
    }, {
      projectPath: tempDir
    });

    expect(result.mode).toBe('spec-related');
    expect(result.success).toBe(true);
    expect(result.total_candidates).toBeGreaterThanOrEqual(1);
    expect(result.related_specs[0].spec_id).toBe('140-00-order-inventory');
  });

  test('supports --spec as query seed', async () => {
    const result = await runSpecRelatedCommand({
      spec: '140-00-order-inventory',
      limit: '5',
      json: true
    }, {
      projectPath: tempDir
    });

    expect(result.success).toBe(true);
    expect(result.source_spec_id).toBe('140-00-order-inventory');
    expect(result.total_candidates).toBeGreaterThanOrEqual(1);
  });

  test('requires at least one selector', async () => {
    await expect(runSpecRelatedCommand({
      json: true
    }, {
      projectPath: tempDir
    })).rejects.toThrow('At least one selector is required');
  });

  test('uses scene override mapping for specs without domain chain scene id', async () => {
    const specId = '150-00-legacy-unassigned';
    const specRoot = path.join(tempDir, '.sce', 'specs', specId);
    await fs.ensureDir(specRoot);
    await fs.writeFile(path.join(specRoot, 'requirements.md'), '# Legacy spec\n', 'utf8');

    await fs.ensureDir(path.join(tempDir, '.sce', 'spec-governance'));
    await fs.writeJson(path.join(tempDir, '.sce', 'spec-governance', 'spec-scene-overrides.json'), {
      schema_version: '1.0',
      mappings: {
        [specId]: {
          scene_id: 'scene.customer-order-inventory',
          source: 'unit-test'
        }
      }
    }, { spaces: 2 });

    const result = await runSpecRelatedCommand({
      query: 'legacy spec',
      scene: 'scene.customer-order-inventory',
      limit: '10',
      json: true
    }, {
      projectPath: tempDir
    });

    expect(result.related_specs.some((item) => item.spec_id === specId)).toBe(true);
  });
});
