/**
 * Unit Tests for File Classifier
 */

const { FileClassifier, FileCategory, ResolutionAction } = require('../../../lib/adoption/file-classifier');

describe('FileClassifier', () => {
  let classifier;

  beforeEach(() => {
    classifier = new FileClassifier();
  });

  describe('FileCategory Constants', () => {
    test('should have all required categories', () => {
      expect(FileCategory.TEMPLATE).toBe('template');
      expect(FileCategory.USER_CONTENT).toBe('user-content');
      expect(FileCategory.CONFIG).toBe('config');
      expect(FileCategory.GENERATED).toBe('generated');
    });
  });

  describe('ResolutionAction Constants', () => {
    test('should have all required actions', () => {
      expect(ResolutionAction.PRESERVE).toBe('preserve');
      expect(ResolutionAction.UPDATE).toBe('update');
      expect(ResolutionAction.MERGE).toBe('merge');
      expect(ResolutionAction.SKIP).toBe('skip');
    });
  });

  describe('normalizePath', () => {
    test('should normalize paths correctly', () => {
      // Forward slashes
      expect(classifier.normalizePath('steering/CORE_PRINCIPLES.md'))
        .toBe('steering/CORE_PRINCIPLES.md');
      
      // Backslashes to forward slashes
      expect(classifier.normalizePath('steering\\CORE_PRINCIPLES.md'))
        .toBe('steering/CORE_PRINCIPLES.md');
      
      // Remove leading .sce/
      expect(classifier.normalizePath('.sce/steering/CORE_PRINCIPLES.md'))
        .toBe('steering/CORE_PRINCIPLES.md');
      
      // Mixed slashes
      expect(classifier.normalizePath('.sce\\steering/CORE_PRINCIPLES.md'))
        .toBe('steering/CORE_PRINCIPLES.md');
    });

    test('should handle edge cases', () => {
      expect(classifier.normalizePath('')).toBe('');
      expect(classifier.normalizePath(null)).toBe('');
      expect(classifier.normalizePath(undefined)).toBe('');
    });
  });

  describe('classifyFile - Template Files', () => {
    test('should classify template files correctly', () => {
      expect(classifier.classifyFile('steering/CORE_PRINCIPLES.md')).toBe(FileCategory.TEMPLATE);
      expect(classifier.classifyFile('steering/ENVIRONMENT.md')).toBe(FileCategory.TEMPLATE);
      expect(classifier.classifyFile('steering/RULES_GUIDE.md')).toBe(FileCategory.TEMPLATE);
      expect(classifier.classifyFile('tools/ultrawork_enhancer.py')).toBe(FileCategory.TEMPLATE);
      expect(classifier.classifyFile('README.md')).toBe(FileCategory.TEMPLATE);
    });

    test('should handle template files with different path formats', () => {
      expect(classifier.classifyFile('.sce/steering/CORE_PRINCIPLES.md')).toBe(FileCategory.TEMPLATE);
      expect(classifier.classifyFile('steering\\CORE_PRINCIPLES.md')).toBe(FileCategory.TEMPLATE);
    });
  });

  describe('classifyFile - User Content', () => {
    test('should classify user content correctly', () => {
      expect(classifier.classifyFile('steering/CURRENT_CONTEXT.md')).toBe(FileCategory.USER_CONTENT);
      expect(classifier.classifyFile('specs/01-00-feature/requirements.md')).toBe(FileCategory.USER_CONTENT);
      expect(classifier.classifyFile('specs/01-00-feature/design.md')).toBe(FileCategory.USER_CONTENT);
      expect(classifier.classifyFile('specs/01-00-feature/tasks.md')).toBe(FileCategory.USER_CONTENT);
      expect(classifier.classifyFile('unknown-file.txt')).toBe(FileCategory.USER_CONTENT);
    });
  });

  describe('classifyFile - Config and Generated Files', () => {
    test('should classify config files correctly', () => {
      expect(classifier.classifyFile('version.json')).toBe(FileCategory.CONFIG);
      expect(classifier.classifyFile('adoption-config.json')).toBe(FileCategory.CONFIG);
      expect(classifier.classifyFile('config/studio-security.json')).toBe(FileCategory.CONFIG);
      expect(classifier.classifyFile('config/orchestrator.json')).toBe(FileCategory.CONFIG);
      expect(classifier.classifyFile('config/errorbook-registry.json')).toBe(FileCategory.CONFIG);
      expect(classifier.classifyFile('config/problem-eval-policy.json')).toBe(FileCategory.CONFIG);
      expect(classifier.classifyFile('config/problem-closure-policy.json')).toBe(FileCategory.CONFIG);
    });

    test('should classify generated files correctly', () => {
      expect(classifier.classifyFile('backups/backup-20260127/file.txt')).toBe(FileCategory.GENERATED);
      expect(classifier.classifyFile('logs/adoption.log')).toBe(FileCategory.GENERATED);
      expect(classifier.classifyFile('node_modules/package/index.js')).toBe(FileCategory.GENERATED);
      expect(classifier.classifyFile('.git/config')).toBe(FileCategory.GENERATED);
    });
  });

  describe('getResolutionRule', () => {
    test('should return correct rules for each category', () => {
      // Template files
      const templateRule = classifier.getResolutionRule('steering/CORE_PRINCIPLES.md');
      expect(templateRule.action).toBe(ResolutionAction.UPDATE);
      expect(templateRule.requiresBackup).toBe(true);
      
      // User content
      const userRule = classifier.getResolutionRule('specs/01-00-feature/requirements.md');
      expect(userRule.action).toBe(ResolutionAction.PRESERVE);
      expect(userRule.requiresBackup).toBe(false);
      
      // Config files
      const configRule = classifier.getResolutionRule('version.json');
      expect(configRule.action).toBe(ResolutionAction.MERGE);
      expect(configRule.requiresBackup).toBe(true);
      
      // Generated files
      const generatedRule = classifier.getResolutionRule('backups/backup-20260127/file.txt');
      expect(generatedRule.action).toBe(ResolutionAction.SKIP);
      expect(generatedRule.requiresBackup).toBe(false);
    });
  });

  describe('Batch Operations', () => {
    test('should classify multiple files at once', () => {
      const files = [
        'steering/CORE_PRINCIPLES.md',
        'specs/01-00-feature/requirements.md',
        'version.json',
        'backups/backup-20260127/file.txt'
      ];

      const result = classifier.classifyFiles(files);

      expect(result['steering/CORE_PRINCIPLES.md']).toBe(FileCategory.TEMPLATE);
      expect(result['specs/01-00-feature/requirements.md']).toBe(FileCategory.USER_CONTENT);
      expect(result['version.json']).toBe(FileCategory.CONFIG);
      expect(result['backups/backup-20260127/file.txt']).toBe(FileCategory.GENERATED);
    });

    test('should get resolution rules for multiple files', () => {
      const files = [
        'steering/CORE_PRINCIPLES.md',
        'specs/01-00-feature/requirements.md',
        'version.json'
      ];

      const result = classifier.getResolutionRules(files);

      expect(result['steering/CORE_PRINCIPLES.md'].action).toBe(ResolutionAction.UPDATE);
      expect(result['specs/01-00-feature/requirements.md'].action).toBe(ResolutionAction.PRESERVE);
      expect(result['version.json'].action).toBe(ResolutionAction.MERGE);
    });

    test('should filter files by category and action', () => {
      const files = [
        'steering/CORE_PRINCIPLES.md',
        'specs/01-00-feature/requirements.md',
        'tools/ultrawork_enhancer.py',
        'version.json'
      ];

      const templates = classifier.getFilesByCategory(files, FileCategory.TEMPLATE);
      const updateFiles = classifier.getFilesByAction(files, ResolutionAction.UPDATE);

      expect(templates).toHaveLength(2);
      expect(updateFiles).toHaveLength(2);
    });

    test('should identify files requiring backup', () => {
      const files = [
        'steering/CORE_PRINCIPLES.md',
        'specs/01-00-feature/requirements.md',
        'version.json',
        'backups/backup-20260127/file.txt'
      ];

      const backupFiles = classifier.getFilesRequiringBackup(files);

      expect(backupFiles).toHaveLength(2);
      expect(backupFiles).toContain('steering/CORE_PRINCIPLES.md');
      expect(backupFiles).toContain('version.json');
    });
  });

  describe('Edge Cases and Integration', () => {
    test('should handle edge cases', () => {
      expect(classifier.classifyFile('specs/01-00-feature with spaces/requirements.md')).toBe(FileCategory.USER_CONTENT);
      expect(classifier.classifyFile('specs/01-00-feature/file.test.backup.md')).toBe(FileCategory.USER_CONTENT);
      expect(classifier.classifyFile('../specs/01-00-feature/requirements.md')).toBe(FileCategory.USER_CONTENT);
    });

    test('should handle complete adoption scenario', () => {
      const files = [
        'steering/CORE_PRINCIPLES.md',
        'steering/CURRENT_CONTEXT.md',
        'specs/01-00-feature/requirements.md',
        'version.json',
        'backups/backup-20260127/file.txt'
      ];

      const rules = classifier.getResolutionRules(files);

      expect(rules['steering/CORE_PRINCIPLES.md'].action).toBe(ResolutionAction.UPDATE);
      expect(rules['steering/CURRENT_CONTEXT.md'].action).toBe(ResolutionAction.PRESERVE);
      expect(rules['specs/01-00-feature/requirements.md'].action).toBe(ResolutionAction.PRESERVE);
      expect(rules['version.json'].action).toBe(ResolutionAction.MERGE);
      expect(rules['backups/backup-20260127/file.txt'].action).toBe(ResolutionAction.SKIP);
    });

    test('should always preserve CURRENT_CONTEXT.md', () => {
      const paths = [
        'steering/CURRENT_CONTEXT.md',
        '.sce/steering/CURRENT_CONTEXT.md',
        'steering\\CURRENT_CONTEXT.md'
      ];

      paths.forEach(path => {
        const rule = classifier.getResolutionRule(path);
        expect(rule.action).toBe(ResolutionAction.PRESERVE);
        expect(rule.requiresBackup).toBe(false);
      });
    });

    test('should handle large number of files efficiently', () => {
      const files = [];
      for (let i = 0; i < 1000; i++) {
        files.push(`specs/spec-${i}/requirements.md`);
      }

      const startTime = Date.now();
      const result = classifier.classifyFiles(files);
      const endTime = Date.now();

      expect(Object.keys(result)).toHaveLength(1000);
      expect(endTime - startTime).toBeLessThan(1000);
    });
  });
});
