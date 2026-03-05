const ComplianceErrorReporter = require('../../../lib/steering/compliance-error-reporter');

describe('ComplianceErrorReporter', () => {
  let reporter;

  beforeEach(() => {
    reporter = new ComplianceErrorReporter();
  });

  describe('formatError', () => {
    test('formats error with only disallowed files', () => {
      const violations = [
        { type: 'disallowed_file', name: 'analysis.md', path: '/path/to/analysis.md' },
        { type: 'disallowed_file', name: 'temp.txt', path: '/path/to/temp.txt' }
      ];

      const message = reporter.formatError(violations);

      expect(message).toContain('Steering Directory Compliance Check Failed');
      expect(message).toContain('Disallowed files:');
      expect(message).toContain('analysis.md');
      expect(message).toContain('temp.txt');
      expect(message).not.toContain('Subdirectories (not allowed):');
      expect(message).toContain('Allowed Files:');
      expect(message).toContain('Fix Suggestions:');
    });

    test('formats error with only subdirectories', () => {
      const violations = [
        { type: 'subdirectory', name: 'archive', path: '/path/to/archive' },
        { type: 'subdirectory', name: 'old-rules', path: '/path/to/old-rules' }
      ];

      const message = reporter.formatError(violations);

      expect(message).toContain('Steering Directory Compliance Check Failed');
      expect(message).toContain('Subdirectories (not allowed):');
      expect(message).toContain('archive/');
      expect(message).toContain('old-rules/');
      expect(message).not.toContain('Disallowed files:');
      expect(message).toContain('Allowed Files:');
      expect(message).toContain('Fix Suggestions:');
    });

    test('formats error with both disallowed files and subdirectories', () => {
      const violations = [
        { type: 'disallowed_file', name: 'temp.txt', path: '/path/to/temp.txt' },
        { type: 'subdirectory', name: 'archive', path: '/path/to/archive' }
      ];

      const message = reporter.formatError(violations);

      expect(message).toContain('Disallowed files:');
      expect(message).toContain('temp.txt');
      expect(message).toContain('Subdirectories (not allowed):');
      expect(message).toContain('archive/');
    });

    test('includes allowlisted steering files and runtime entries in message', () => {
      const violations = [
        { type: 'disallowed_file', name: 'temp.txt', path: '/path/to/temp.txt' }
      ];

      const message = reporter.formatError(violations);

      expect(message).toContain('CORE_PRINCIPLES.md');
      expect(message).toContain('ENVIRONMENT.md');
      expect(message).toContain('CURRENT_CONTEXT.md');
      expect(message).toContain('RULES_GUIDE.md');
      expect(message).toContain('manifest.yaml');
      expect(message).toContain('compiled/');
      expect(message).toContain('*.lock');
      expect(message).toContain('*.pending.<agentId>');
    });

    test('includes fix suggestions', () => {
      const violations = [
        { type: 'disallowed_file', name: 'temp.txt', path: '/path/to/temp.txt' }
      ];

      const message = reporter.formatError(violations);

      expect(message).toContain('Fix Suggestions:');
      expect(message).toContain('.sce/specs/{spec-name}/reports/');
      expect(message).toContain('docs/');
      expect(message).toContain('Delete temporary files');
    });

    test('includes bypass option', () => {
      const violations = [
        { type: 'disallowed_file', name: 'temp.txt', path: '/path/to/temp.txt' }
      ];

      const message = reporter.formatError(violations);

      expect(message).toContain('--skip-steering-check');
    });
  });

  describe('reportAndExit', () => {
    test('calls formatError and exits with code 1', () => {
      const violations = [
        { type: 'disallowed_file', name: 'temp.txt', path: '/path/to/temp.txt' }
      ];

      // Mock console.error and process.exit
      const originalConsoleError = console.error;
      const originalProcessExit = process.exit;
      
      let errorMessage = '';
      let exitCode = null;
      
      console.error = (msg) => { errorMessage = msg; };
      process.exit = (code) => { exitCode = code; throw new Error('process.exit called'); };

      try {
        reporter.reportAndExit(violations);
      } catch (error) {
        // Expected to throw due to process.exit mock
      }

      // Restore originals
      console.error = originalConsoleError;
      process.exit = originalProcessExit;

      expect(errorMessage).toContain('Steering Directory Compliance Check Failed');
      expect(exitCode).toBe(1);
    });
  });
});
