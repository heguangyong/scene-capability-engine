const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const SteeringComplianceChecker = require('../../../lib/steering/steering-compliance-checker');

describe('SteeringComplianceChecker', () => {
  let checker;
  let tempDir;

  beforeEach(() => {
    checker = new SteeringComplianceChecker();
    // Create a unique temp directory for each test
    tempDir = path.join(os.tmpdir(), `sce-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
  });

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.removeSync(tempDir);
    }
  });

  describe('getAllowedFiles', () => {
    test('returns expected allowed files including manifest', () => {
      const allowed = checker.getAllowedFiles();
      expect(allowed).toHaveLength(5);
      expect(allowed).toEqual([
        'CORE_PRINCIPLES.md',
        'ENVIRONMENT.md',
        'CURRENT_CONTEXT.md',
        'RULES_GUIDE.md',
        'manifest.yaml'
      ]);
    });
  });

  describe('getAllowedDirectories', () => {
    test('returns compiled as allowlisted steering directory', () => {
      const allowed = checker.getAllowedDirectories();
      expect(allowed).toEqual(['compiled']);
    });
  });

  describe('check', () => {
    test('non-existent directory is compliant', () => {
      const nonExistentPath = path.join(tempDir, 'does-not-exist');
      const result = checker.check(nonExistentPath);
      
      expect(result.compliant).toBe(true);
      expect(result.violations).toBeUndefined();
    });

    test('empty directory is compliant', () => {
      fs.mkdirSync(tempDir, { recursive: true });
      const result = checker.check(tempDir);
      
      expect(result.compliant).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    test('directory with only allowed files is compliant', () => {
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'CORE_PRINCIPLES.md'), '# Core Principles');
      fs.writeFileSync(path.join(tempDir, 'ENVIRONMENT.md'), '# Environment');
      fs.writeFileSync(path.join(tempDir, 'manifest.yaml'), 'schema_version: 1.0');
      fs.mkdirSync(path.join(tempDir, 'compiled'));
      
      const result = checker.check(tempDir);
      
      expect(result.compliant).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    test('directory with disallowed file is non-compliant', () => {
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'CORE_PRINCIPLES.md'), '# Core Principles');
      fs.writeFileSync(path.join(tempDir, 'analysis-report.md'), '# Analysis');
      
      const result = checker.check(tempDir);
      
      expect(result.compliant).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toEqual({
        type: 'disallowed_file',
        name: 'analysis-report.md',
        path: path.join(tempDir, 'analysis-report.md')
      });
    });

    test('directory with subdirectory is non-compliant', () => {
      fs.mkdirSync(tempDir, { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'archive'));
      
      const result = checker.check(tempDir);
      
      expect(result.compliant).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toEqual({
        type: 'subdirectory',
        name: 'archive',
        path: path.join(tempDir, 'archive')
      });
    });

    test('directory with both disallowed files and subdirectories reports both', () => {
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'temp.txt'), 'temp');
      fs.mkdirSync(path.join(tempDir, 'old-rules'));
      
      const result = checker.check(tempDir);
      
      expect(result.compliant).toBe(false);
      expect(result.violations).toHaveLength(2);
      
      const fileViolation = result.violations.find(v => v.type === 'disallowed_file');
      const dirViolation = result.violations.find(v => v.type === 'subdirectory');
      
      expect(fileViolation).toBeDefined();
      expect(fileViolation.name).toBe('temp.txt');
      expect(dirViolation).toBeDefined();
      expect(dirViolation.name).toBe('old-rules');
    });

    test('case sensitivity - core_principles.md is non-compliant', () => {
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'core_principles.md'), '# Core');
      
      const result = checker.check(tempDir);
      
      expect(result.compliant).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].name).toBe('core_principles.md');
    });

    test('hidden files are non-compliant', () => {
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, '.gitkeep'), '');
      
      const result = checker.check(tempDir);
      
      expect(result.compliant).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].name).toBe('.gitkeep');
    });

    test('runtime lock and pending files are compliant', () => {
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'CURRENT_CONTEXT.md.lock'), 'lock');
      fs.writeFileSync(path.join(tempDir, 'CURRENT_CONTEXT.md.pending.agent-1'), 'pending');

      const result = checker.check(tempDir);

      expect(result.compliant).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });
});
