const chalk = require('chalk');

/**
 * ComplianceErrorReporter - Formats and displays compliance violations
 * 
 * Creates user-friendly error messages with clear sections,
 * violation details, and actionable fix suggestions.
 */
class ComplianceErrorReporter {
  /**
   * Format compliance violations into user-friendly message
   * 
   * @param {ComplianceViolation[]} violations - List of violations
   * @returns {string} Formatted error message
   */
  formatError(violations) {
    const disallowedFiles = violations.filter(v => v.type === 'disallowed_file');
    const subdirectories = violations.filter(v => v.type === 'subdirectory');

    let message = '\n';
    message += chalk.red.bold('❌ Steering Directory Compliance Check Failed') + '\n\n';
    message += 'The .sce/steering/ directory contains files or subdirectories that are not allowed.\n';
    message += 'This directory is automatically loaded in every AI session, so keeping it clean is critical.\n\n';

    message += chalk.yellow.bold('Violations Found:') + '\n';
    
    if (disallowedFiles.length > 0) {
      message += '  • ' + chalk.yellow('Disallowed files:') + '\n';
      disallowedFiles.forEach(v => {
        message += `    - ${v.name}\n`;
      });
    }
    
    if (subdirectories.length > 0) {
      message += '  • ' + chalk.yellow('Subdirectories (not allowed):') + '\n';
      subdirectories.forEach(v => {
        message += `    - ${v.name}/\n`;
      });
    }

    message += '\n' + chalk.green.bold('Allowed Files:') + '\n';
    message += '  ✓ CORE_PRINCIPLES.md\n';
    message += '  ✓ ENVIRONMENT.md\n';
    message += '  ✓ CURRENT_CONTEXT.md\n';
    message += '  ✓ RULES_GUIDE.md\n';
    message += '  ✓ manifest.yaml\n';
    message += '\n' + chalk.green.bold('Allowed Subdirectories:') + '\n';
    message += '  ✓ compiled/\n';
    message += '\n' + chalk.green.bold('Allowed Runtime Temp Files:') + '\n';
    message += '  ✓ *.lock\n';
    message += '  ✓ *.pending.<agentId>\n';

    message += '\n' + chalk.cyan.bold('Fix Suggestions:') + '\n';
    message += '  • Move analysis reports to: .sce/specs/{spec-name}/reports/\n';
    message += '  • Move historical data to: .sce/specs/{spec-name}/\n';
    message += '  • Move detailed docs to: docs/\n';
    message += '  • Delete temporary files\n';

    message += '\n' + chalk.gray('To bypass this check (not recommended):') + '\n';
    message += chalk.gray('  sce <command> --skip-steering-check') + '\n';

    return message;
  }

  /**
   * Display error and exit
   * 
   * @param {ComplianceViolation[]} violations - List of violations
   */
  reportAndExit(violations) {
    console.error(this.formatError(violations));
    process.exit(1);
  }
}

module.exports = ComplianceErrorReporter;
