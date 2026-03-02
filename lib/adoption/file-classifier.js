/**
 * File Classifier
 * 
 * Automatically classifies files for smart conflict resolution.
 * Determines file categories based on path patterns to apply
 * appropriate resolution strategies.
 */

const path = require('path');

/**
 * File categories for classification
 */
const FileCategory = {
  TEMPLATE: 'template',           // steering/, tools/, README.md
  USER_CONTENT: 'user-content',   // specs/, custom files
  CONFIG: 'config',               // version.json, adoption-config.json, config/*.json
  GENERATED: 'generated'          // backups/, logs/, node_modules/
};

/**
 * Resolution actions for each category
 */
const ResolutionAction = {
  PRESERVE: 'preserve',   // Keep existing file
  UPDATE: 'update',       // Backup + update to latest
  MERGE: 'merge',         // Backup + merge changes
  SKIP: 'skip'            // Skip (regenerate if needed)
};

/**
 * File Classifier
 * 
 * Classifies files based on path patterns and applies
 * appropriate resolution rules.
 */
class FileClassifier {
  constructor() {
    // Template file patterns (relative to .sce/)
    this.templatePatterns = [
      'steering/CORE_PRINCIPLES.md',
      'steering/ENVIRONMENT.md',
      'steering/RULES_GUIDE.md',
      'tools/ultrawork_enhancer.py',
      'README.md',
      'ultrawork-application-guide.md',
      'ultrawork-integration-summary.md',
      'sisyphus-deep-dive.md'
    ];

    // Template directory patterns
    this.templateDirs = [
      'steering',
      'tools'
    ];

    // User content directory patterns
    this.userContentDirs = [
      'specs'
    ];

    // Config file patterns
    this.configPatterns = [
      'version.json',
      'adoption-config.json',
      'config/studio-security.json',
      'config/orchestrator.json',
      'config/errorbook-registry.json',
      'config/takeover-baseline.json',
      'config/session-governance.json',
      'config/spec-domain-policy.json',
      'config/problem-eval-policy.json',
      'config/problem-closure-policy.json'
    ];

    // Generated directory patterns
    this.generatedDirs = [
      'backups',
      'logs',
      'node_modules',
      '.git'
    ];

    // Special cases that always preserve
    this.alwaysPreserve = [
      'steering/CURRENT_CONTEXT.md'
    ];
  }

  /**
   * Classify a file based on its path
   * 
   * @param {string} filePath - File path relative to .sce/
   * @returns {string} FileCategory
   */
  classifyFile(filePath) {
    // Normalize path separators
    const normalizedPath = this.normalizePath(filePath);

    // Check special cases first (always preserve)
    if (this.isAlwaysPreserve(normalizedPath)) {
      return FileCategory.USER_CONTENT;
    }

    // Check if it's a generated file/directory
    if (this.isGenerated(normalizedPath)) {
      return FileCategory.GENERATED;
    }

    // Check if it's a config file
    if (this.isConfig(normalizedPath)) {
      return FileCategory.CONFIG;
    }

    // Check if it's user content
    if (this.isUserContent(normalizedPath)) {
      return FileCategory.USER_CONTENT;
    }

    // Check if it's a template file
    if (this.isTemplate(normalizedPath)) {
      return FileCategory.TEMPLATE;
    }

    // Default: treat unknown files as user content (safer)
    return FileCategory.USER_CONTENT;
  }

  /**
   * Get resolution rule for a file
   * 
   * @param {string} filePath - File path relative to .sce/
   * @returns {Object} Resolution rule
   */
  getResolutionRule(filePath) {
    const category = this.classifyFile(filePath);
    const normalizedPath = this.normalizePath(filePath);

    // Special case: CURRENT_CONTEXT.md always preserve
    if (this.isAlwaysPreserve(normalizedPath)) {
      return {
        category: FileCategory.USER_CONTENT,
        action: ResolutionAction.PRESERVE,
        requiresBackup: false,
        reason: 'User-specific context file'
      };
    }

    switch (category) {
      case FileCategory.TEMPLATE:
        return {
          category,
          action: ResolutionAction.UPDATE,
          requiresBackup: true,
          reason: 'Template file should be updated to latest version'
        };

      case FileCategory.USER_CONTENT:
        return {
          category,
          action: ResolutionAction.PRESERVE,
          requiresBackup: false,
          reason: 'User content should always be preserved'
        };

      case FileCategory.CONFIG:
        return {
          category,
          action: ResolutionAction.MERGE,
          requiresBackup: true,
          reason: 'Config file should be merged with updates'
        };

      case FileCategory.GENERATED:
        return {
          category,
          action: ResolutionAction.SKIP,
          requiresBackup: false,
          reason: 'Generated file can be recreated'
        };

      default:
        // Fallback: preserve unknown files
        return {
          category: FileCategory.USER_CONTENT,
          action: ResolutionAction.PRESERVE,
          requiresBackup: false,
          reason: 'Unknown file type, preserving for safety'
        };
    }
  }

  /**
   * Check if file should always be preserved
   * 
   * @param {string} normalizedPath - Normalized file path
   * @returns {boolean}
   */
  isAlwaysPreserve(normalizedPath) {
    return this.alwaysPreserve.some(pattern => 
      normalizedPath === pattern || normalizedPath.endsWith('/' + pattern)
    );
  }

  /**
   * Check if file is a template
   * 
   * @param {string} normalizedPath - Normalized file path
   * @returns {boolean}
   */
  isTemplate(normalizedPath) {
    // Check exact template file patterns
    if (this.templatePatterns.some(pattern => 
      normalizedPath === pattern || normalizedPath.endsWith('/' + pattern)
    )) {
      return true;
    }

    // Check if file is in a template directory
    const parts = normalizedPath.split('/');
    if (parts.length > 0) {
      const firstDir = parts[0];
      if (this.templateDirs.includes(firstDir)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if file is user content
   * 
   * @param {string} normalizedPath - Normalized file path
   * @returns {boolean}
   */
  isUserContent(normalizedPath) {
    const parts = normalizedPath.split('/');
    if (parts.length > 0) {
      const firstDir = parts[0];
      if (this.userContentDirs.includes(firstDir)) {
        return true;
      }
    }

    // Files not in any known directory are treated as user content
    return false;
  }

  /**
   * Check if file is a config file
   * 
   * @param {string} normalizedPath - Normalized file path
   * @returns {boolean}
   */
  isConfig(normalizedPath) {
    return this.configPatterns.some(pattern => 
      normalizedPath === pattern || normalizedPath.endsWith('/' + pattern)
    );
  }

  /**
   * Check if file is generated
   * 
   * @param {string} normalizedPath - Normalized file path
   * @returns {boolean}
   */
  isGenerated(normalizedPath) {
    const parts = normalizedPath.split('/');
    if (parts.length > 0) {
      const firstDir = parts[0];
      if (this.generatedDirs.includes(firstDir)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Normalize path separators to forward slashes
   * 
   * @param {string} filePath - File path
   * @returns {string} Normalized path
   */
  normalizePath(filePath) {
    if (!filePath) {
      return '';
    }

    // Convert backslashes to forward slashes
    let normalized = filePath.replace(/\\/g, '/');

    // Remove leading .sce/ if present
    if (normalized.startsWith('.sce/')) {
      normalized = normalized.substring('.sce/'.length);
    }

    // Remove leading slash
    if (normalized.startsWith('/')) {
      normalized = normalized.substring(1);
    }

    return normalized;
  }

  /**
   * Classify multiple files at once
   * 
   * @param {string[]} filePaths - Array of file paths
   * @returns {Object} Map of file paths to categories
   */
  classifyFiles(filePaths) {
    const result = {};
    
    for (const filePath of filePaths) {
      result[filePath] = this.classifyFile(filePath);
    }

    return result;
  }

  /**
   * Get resolution rules for multiple files
   * 
   * @param {string[]} filePaths - Array of file paths
   * @returns {Object} Map of file paths to resolution rules
   */
  getResolutionRules(filePaths) {
    const result = {};
    
    for (const filePath of filePaths) {
      result[filePath] = this.getResolutionRule(filePath);
    }

    return result;
  }

  /**
   * Get files by category
   * 
   * @param {string[]} filePaths - Array of file paths
   * @param {string} category - FileCategory to filter by
   * @returns {string[]} Files matching the category
   */
  getFilesByCategory(filePaths, category) {
    return filePaths.filter(filePath => 
      this.classifyFile(filePath) === category
    );
  }

  /**
   * Get files by action
   * 
   * @param {string[]} filePaths - Array of file paths
   * @param {string} action - ResolutionAction to filter by
   * @returns {string[]} Files matching the action
   */
  getFilesByAction(filePaths, action) {
    return filePaths.filter(filePath => {
      const rule = this.getResolutionRule(filePath);
      return rule.action === action;
    });
  }

  /**
   * Check if file requires backup
   * 
   * @param {string} filePath - File path
   * @returns {boolean}
   */
  requiresBackup(filePath) {
    const rule = this.getResolutionRule(filePath);
    return rule.requiresBackup;
  }

  /**
   * Get all files that require backup
   * 
   * @param {string[]} filePaths - Array of file paths
   * @returns {string[]} Files that require backup
   */
  getFilesRequiringBackup(filePaths) {
    return filePaths.filter(filePath => this.requiresBackup(filePath));
  }
}

// Export classes and constants
module.exports = {
  FileClassifier,
  FileCategory,
  ResolutionAction
};
