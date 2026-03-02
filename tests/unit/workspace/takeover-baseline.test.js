const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {
  applyTakeoverBaseline,
  TAKEOVER_DEFAULTS
} = require('../../../lib/workspace/takeover-baseline');

describe('takeover-baseline', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-takeover-baseline-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  test('applies baseline defaults for adopted projects and writes report', async () => {
    await fs.ensureDir(path.join(tempDir, '.sce'));
    await fs.writeJson(path.join(tempDir, '.sce', 'version.json'), {
      'sce-version': '3.3.0',
      'template-version': '3.3.0'
    }, { spaces: 2 });

    const report = await applyTakeoverBaseline(tempDir, {
      apply: true,
      writeReport: true,
      sceVersion: '3.4.0'
    });

    expect(report.detected_project).toBe(true);
    expect(report.apply).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.drift_count).toBe(0);
    expect(report.summary.created).toBeGreaterThan(0);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'adoption-config.json'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'auto', 'config.json'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'config', 'takeover-baseline.json'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'config', 'session-governance.json'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'config', 'spec-domain-policy.json'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'config', 'problem-eval-policy.json'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'config', 'problem-closure-policy.json'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'steering', 'manifest.yaml'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'reports', 'takeover-baseline-latest.json'))).toBe(true);

    const adoptionConfig = await fs.readJson(path.join(tempDir, '.sce', 'adoption-config.json'));
    expect(adoptionConfig.takeover).toEqual(expect.objectContaining({
      managed: true,
      auto_detect_on_startup: true,
      legacy_kiro_supported: false
    }));
    expect(adoptionConfig.defaults).toEqual(TAKEOVER_DEFAULTS);

    const autoConfig = await fs.readJson(path.join(tempDir, '.sce', 'auto', 'config.json'));
    expect(autoConfig.mode).toBe('aggressive');
    expect(autoConfig.takeover).toEqual(expect.objectContaining({
      managed: true,
      require_step_confirmation: false,
      apply_all_work_by_default: true
    }));
  });

  test('audit mode reports drift without mutating project files', async () => {
    await fs.ensureDir(path.join(tempDir, '.sce'));

    const report = await applyTakeoverBaseline(tempDir, {
      apply: false,
      writeReport: false,
      sceVersion: '3.4.0'
    });

    expect(report.detected_project).toBe(true);
    expect(report.apply).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.drift_count).toBeGreaterThan(0);
    expect(report.summary.pending).toBeGreaterThan(0);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'adoption-config.json'))).toBe(false);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'steering', 'manifest.yaml'))).toBe(false);
    expect(report.files.some((item) => item.status === 'pending')).toBe(true);
  });

  test('is idempotent after baseline is already aligned', async () => {
    await fs.ensureDir(path.join(tempDir, '.sce'));

    const first = await applyTakeoverBaseline(tempDir, {
      apply: true,
      writeReport: false,
      sceVersion: '3.4.0'
    });
    expect(first.passed).toBe(true);

    const second = await applyTakeoverBaseline(tempDir, {
      apply: true,
      writeReport: false,
      sceVersion: '3.4.0'
    });

    expect(second.detected_project).toBe(true);
    expect(second.passed).toBe(true);
    expect(second.summary.created).toBe(0);
    expect(second.summary.updated).toBe(0);
    expect(second.summary.pending).toBe(0);
    expect(second.files.every((item) => item.status === 'unchanged')).toBe(true);
  });

  test('skips takeover when .sce directory is missing', async () => {
    const report = await applyTakeoverBaseline(tempDir, {
      apply: true,
      writeReport: true,
      sceVersion: '3.4.0'
    });

    expect(report.detected_project).toBe(false);
    expect(report.passed).toBe(true);
    expect(report.files).toHaveLength(0);
  });
});
