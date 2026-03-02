/**
 * Adoption Strategy
 * 
 * Implements different adoption strategies based on project state:
 * - Fresh: Create complete .sce/ structure from scratch
 * - Partial: Add missing components to existing .sce/
 * - Full: Upgrade existing complete .sce/ to current version
 */

const path = require('path');
const {
  pathExists,
  ensureDirectory,
  copyDirectory,
  safeCopy,
  listFiles,
  readJSON,
  writeJSON
} = require('../utils/fs-utils');
const VersionManager = require('../version/version-manager');

/**
 * Base class for adoption strategies
 */
class AdoptionStrategy {
  constructor() {
    this.versionManager = new VersionManager();
    this.sceDir = '.sce';
  }

  /**
   * Gets the path to .sce/ directory
   * 
   * @param {string} projectPath - Absolute path to project root
   * @returns {string}
   */
  getKiroPath(projectPath) {
    return path.join(projectPath, this.sceDir);
  }

  /**
   * Gets the path to template directory
   * This would be embedded in the sce package
   * 
   * @returns {string}
   */
  getTemplatePath() {
    // Template is at template/.sce/ in the package
    return path.join(__dirname, '../../template/.sce');
  }

  /**
   * Executes adoption strategy
   * Must be implemented by subclasses
   * 
   * @param {string} projectPath - Absolute path to project root
   * @param {AdoptionMode} mode - Adoption mode
   * @param {AdoptionOptions} options - Adoption options
   * @returns {Promise<AdoptionResult>}
   */
  async execute(projectPath, mode, options) {
    throw new Error('execute() must be implemented by subclass');
  }

  /**
   * Creates initial directory structure
   * 
   * @param {string} kiroPath - Path to .sce/ directory
   * @returns {Promise<void>}
   */
  async createDirectoryStructure(kiroPath) {
    await ensureDirectory(kiroPath);
    await ensureDirectory(path.join(kiroPath, 'specs'));
    await ensureDirectory(path.join(kiroPath, 'steering'));
    await ensureDirectory(path.join(kiroPath, 'tools'));
    await ensureDirectory(path.join(kiroPath, 'config'));
    await ensureDirectory(path.join(kiroPath, 'backups'));
    await ensureDirectory(path.join(kiroPath, 'hooks'));
  }

  /**
   * Copies template files to project
   * 
   * @param {string} projectPath - Absolute path to project root
   * @param {Object} options - Copy options
   * @param {boolean} options.overwrite - Whether to overwrite existing files
   * @param {string[]} options.skip - Files to skip
   * @param {Object} options.resolutionMap - Map of file paths to resolutions ('keep' | 'overwrite')
   * @returns {Promise<{created: string[], updated: string[], skipped: string[]}>}
   */
  async copyTemplateFiles(projectPath, options = {}) {
    const { overwrite = false, skip = [], resolutionMap = {} } = options;
    const kiroPath = this.getKiroPath(projectPath);
    const templatePath = this.getTemplatePath();
    
    const created = [];
    const updated = [];
    const skipped = [];
    
    // Check if template directory exists
    const templateExists = await pathExists(templatePath);
    if (!templateExists) {
      // Template directory doesn't exist yet - this is expected during development
      // In production, templates would be bundled with the package
      return { created, updated, skipped };
    }
    
    // Define template structure
    const templateFiles = [
      'README.md',
      'steering/CORE_PRINCIPLES.md',
      'steering/ENVIRONMENT.md',
      'steering/CURRENT_CONTEXT.md',
      'steering/RULES_GUIDE.md',
      'config/studio-security.json',
      'config/orchestrator.json',
      'config/errorbook-registry.json',
      'config/takeover-baseline.json',
      'config/session-governance.json',
      'config/spec-domain-policy.json',
      'config/problem-eval-policy.json',
      'config/problem-closure-policy.json',
      'specs/SPEC_WORKFLOW_GUIDE.md',
      'hooks/sync-tasks-on-edit.sce.hook',
      'hooks/check-spec-on-create.sce.hook',
      'hooks/run-tests-on-save.sce.hook'
    ];
    
    for (const file of templateFiles) {
      // Check if file should be skipped
      if (skip.includes(file)) {
        skipped.push(file);
        continue;
      }
      
      // Check resolution map for this file
      if (resolutionMap[file]) {
        if (resolutionMap[file] === 'keep') {
          skipped.push(file);
          continue;
        }
        // If 'overwrite', proceed with copying
      }
      
      const sourcePath = path.join(templatePath, file);
      const destPath = path.join(kiroPath, file);
      
      // Check if source exists
      const sourceExists = await pathExists(sourcePath);
      if (!sourceExists) {
        skipped.push(file);
        continue;
      }
      
      // Check if destination exists
      const destExists = await pathExists(destPath);
      
      // Determine if we should overwrite
      let shouldOverwrite = overwrite;
      if (resolutionMap[file] === 'overwrite') {
        shouldOverwrite = true;
      }
      
      if (destExists && !shouldOverwrite) {
        skipped.push(file);
        continue;
      }
      
      try {
        await safeCopy(sourcePath, destPath, { overwrite: shouldOverwrite });
        
        if (destExists) {
          updated.push(file);
        } else {
          created.push(file);
        }
      } catch (error) {
        // If copy fails, add to skipped
        skipped.push(file);
      }
    }
    
    return { created, updated, skipped };
  }
}

/**
 * Fresh Adoption Strategy
 * Creates complete .sce/ structure from scratch
 */
class FreshAdoption extends AdoptionStrategy {
  /**
   * Executes fresh adoption
   * 
   * @param {string} projectPath - Absolute path to project root
   * @param {AdoptionMode} mode - Should be 'fresh'
   * @param {AdoptionOptions} options - Adoption options
   * @returns {Promise<AdoptionResult>}
   */
  async execute(projectPath, mode, options = {}) {
    const { sceVersion = '1.0.0', dryRun = false } = options;
    
    const filesCreated = [];
    const filesUpdated = [];
    const filesSkipped = [];
    const errors = [];
    const warnings = [];
    
    try {
      const kiroPath = this.getKiroPath(projectPath);
      
      // Check if .sce/ already exists
      const kiroExists = await pathExists(kiroPath);
      if (kiroExists) {
        throw new Error('.sce/ directory already exists - use partial or full adoption');
      }
      
      if (dryRun) {
        return {
          success: true,
          mode: 'fresh',
          filesCreated: ['(dry-run) .sce/ structure would be created'],
          filesUpdated: [],
          filesSkipped: [],
          backupId: null,
          errors: [],
          warnings: []
        };
      }
      
      // Create directory structure
      await this.createDirectoryStructure(kiroPath);
      filesCreated.push('.sce/');
      filesCreated.push('.sce/specs/');
      filesCreated.push('.sce/steering/');
      filesCreated.push('.sce/tools/');
      filesCreated.push('.sce/config/');
      filesCreated.push('.sce/backups/');
      filesCreated.push('.sce/hooks/');
      
      // Copy template files
      const copyResult = await this.copyTemplateFiles(projectPath, { overwrite: false });
      filesCreated.push(...copyResult.created);
      filesUpdated.push(...copyResult.updated);
      filesSkipped.push(...copyResult.skipped);
      
      // Create version.json
      const versionInfo = this.versionManager.createVersionInfo(sceVersion);
      await this.versionManager.writeVersion(projectPath, versionInfo);
      filesCreated.push('version.json');
      
      return {
        success: true,
        mode: 'fresh',
        filesCreated,
        filesUpdated,
        filesSkipped,
        backupId: null,
        errors,
        warnings
      };
    } catch (error) {
      errors.push(error.message);
      return {
        success: false,
        mode: 'fresh',
        filesCreated,
        filesUpdated,
        filesSkipped,
        backupId: null,
        errors,
        warnings
      };
    }
  }
}

/**
 * Partial Adoption Strategy
 * Adds missing components to existing .sce/
 */
class PartialAdoption extends AdoptionStrategy {
  /**
   * Executes partial adoption
   * 
   * @param {string} projectPath - Absolute path to project root
   * @param {AdoptionMode} mode - Should be 'partial'
   * @param {AdoptionOptions} options - Adoption options
   * @returns {Promise<AdoptionResult>}
   */
  async execute(projectPath, mode, options = {}) {
    const { sceVersion = '1.0.0', dryRun = false, backupId = null, force = false, resolutionMap = {} } = options;
    
    const filesCreated = [];
    const filesUpdated = [];
    const filesSkipped = [];
    const errors = [];
    const warnings = [];
    
    try {
      const kiroPath = this.getKiroPath(projectPath);
      
      // Check if .sce/ exists
      const kiroExists = await pathExists(kiroPath);
      if (!kiroExists) {
        throw new Error('.sce/ directory does not exist - use fresh adoption');
      }
      
      // Check if version.json exists
      const versionPath = path.join(kiroPath, 'version.json');
      const versionExists = await pathExists(versionPath);
      if (versionExists) {
        warnings.push('version.json already exists - use full adoption for upgrades');
      }
      
      if (dryRun) {
        return {
          success: true,
          mode: 'partial',
          filesCreated: ['(dry-run) Missing components would be added'],
          filesUpdated: [],
          filesSkipped: [],
          backupId,
          errors: [],
          warnings
        };
      }
      
      // Ensure all required directories exist
      const specsPath = path.join(kiroPath, 'specs');
      const steeringPath = path.join(kiroPath, 'steering');
      const toolsPath = path.join(kiroPath, 'tools');
      const configPath = path.join(kiroPath, 'config');
      const backupsPath = path.join(kiroPath, 'backups');
      const hooksPath = path.join(kiroPath, 'hooks');
      
      if (!await pathExists(specsPath)) {
        await ensureDirectory(specsPath);
        filesCreated.push('specs/');
      }
      
      if (!await pathExists(steeringPath)) {
        await ensureDirectory(steeringPath);
        filesCreated.push('steering/');
      }
      
      if (!await pathExists(toolsPath)) {
        await ensureDirectory(toolsPath);
        filesCreated.push('tools/');
      }

      if (!await pathExists(configPath)) {
        await ensureDirectory(configPath);
        filesCreated.push('config/');
      }
      
      if (!await pathExists(backupsPath)) {
        await ensureDirectory(backupsPath);
        filesCreated.push('backups/');
      }
      
      if (!await pathExists(hooksPath)) {
        await ensureDirectory(hooksPath);
        filesCreated.push('hooks/');
      }
      
      // Copy template files (overwrite if force is enabled)
      const copyResult = await this.copyTemplateFiles(projectPath, { overwrite: force, resolutionMap });
      filesCreated.push(...copyResult.created);
      filesUpdated.push(...copyResult.updated);
      filesSkipped.push(...copyResult.skipped);
      
      // Create or update version.json
      if (!versionExists) {
        const versionInfo = this.versionManager.createVersionInfo(sceVersion);
        await this.versionManager.writeVersion(projectPath, versionInfo);
        filesCreated.push('version.json');
      } else {
        // Update existing version.json
        const versionInfo = await this.versionManager.readVersion(projectPath);
        if (versionInfo) {
          versionInfo['sce-version'] = sceVersion;
          versionInfo['template-version'] = sceVersion;
          versionInfo['last-upgraded'] = new Date().toISOString();
          await this.versionManager.writeVersion(projectPath, versionInfo);
          filesUpdated.push('version.json');
        }
      }
      
      return {
        success: true,
        mode: 'partial',
        filesCreated,
        filesUpdated,
        filesSkipped,
        backupId,
        errors,
        warnings
      };
    } catch (error) {
      errors.push(error.message);
      return {
        success: false,
        mode: 'partial',
        filesCreated,
        filesUpdated,
        filesSkipped,
        backupId,
        errors,
        warnings
      };
    }
  }
}

/**
 * Full Adoption Strategy
 * Upgrades existing complete .sce/ to current version
 */
class FullAdoption extends AdoptionStrategy {
  /**
   * Executes full adoption (upgrade)
   * 
   * @param {string} projectPath - Absolute path to project root
   * @param {AdoptionMode} mode - Should be 'full'
   * @param {AdoptionOptions} options - Adoption options
   * @returns {Promise<AdoptionResult>}
   */
  async execute(projectPath, mode, options = {}) {
    const { sceVersion = '1.0.0', dryRun = false, backupId = null } = options;
    
    const filesCreated = [];
    const filesUpdated = [];
    const filesSkipped = [];
    const errors = [];
    const warnings = [];
    
    try {
      const kiroPath = this.getKiroPath(projectPath);
      
      // Check if .sce/ exists
      const kiroExists = await pathExists(kiroPath);
      if (!kiroExists) {
        throw new Error('.sce/ directory does not exist - use fresh adoption');
      }
      
      // Read existing version
      const existingVersion = await this.versionManager.readVersion(projectPath);
      if (!existingVersion) {
        throw new Error('version.json not found - use partial adoption');
      }
      
      const currentVersion = existingVersion['sce-version'];
      
      // Check if upgrade is needed
      if (!this.versionManager.needsUpgrade(currentVersion, sceVersion)) {
        warnings.push(`Already at version ${sceVersion} - no upgrade needed`);
        return {
          success: true,
          mode: 'full',
          filesCreated: [],
          filesUpdated: [],
          filesSkipped: [],
          backupId,
          errors: [],
          warnings
        };
      }
      
      if (dryRun) {
        return {
          success: true,
          mode: 'full',
          filesCreated: [],
          filesUpdated: [`(dry-run) Would upgrade from ${currentVersion} to ${sceVersion}`],
          filesSkipped: [],
          backupId,
          errors: [],
          warnings
        };
      }
      
      // Copy template files (overwrite template files, preserve user content)
      // User content is in specs/ and any custom files
      const copyResult = await this.copyTemplateFiles(projectPath, { 
        overwrite: true,
        skip: [] // Don't skip anything - we want to update templates
      });
      filesCreated.push(...copyResult.created);
      filesUpdated.push(...copyResult.updated);
      filesSkipped.push(...copyResult.skipped);
      
      // Update version.json with upgrade history
      const updatedVersion = this.versionManager.addUpgradeHistory(
        existingVersion,
        currentVersion,
        sceVersion,
        true
      );
      await this.versionManager.writeVersion(projectPath, updatedVersion);
      filesUpdated.push('version.json');
      
      return {
        success: true,
        mode: 'full',
        filesCreated,
        filesUpdated,
        filesSkipped,
        backupId,
        errors,
        warnings
      };
    } catch (error) {
      errors.push(error.message);
      return {
        success: false,
        mode: 'full',
        filesCreated,
        filesUpdated,
        filesSkipped,
        backupId,
        errors,
        warnings
      };
    }
  }
}

/**
 * Factory function to get the appropriate strategy
 * 
 * @param {AdoptionMode} mode - Adoption mode ('fresh', 'partial', 'full')
 * @returns {AdoptionStrategy}
 */
function getAdoptionStrategy(mode) {
  switch (mode) {
    case 'fresh':
      return new FreshAdoption();
    case 'partial':
      return new PartialAdoption();
    case 'full':
      return new FullAdoption();
    default:
      throw new Error(`Unknown adoption mode: ${mode}`);
  }
}

module.exports = {
  AdoptionStrategy,
  FreshAdoption,
  PartialAdoption,
  FullAdoption,
  getAdoptionStrategy
};
