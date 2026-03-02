/**
 * Smart Adoption Orchestrator
 * 
 * Coordinates the entire adoption process without user interaction.
 * Implements zero-question, smart decision-making with mandatory backups.
 * 
 * Core Philosophy:
 * - Zero user interaction by default
 * - Smart automatic decisions
 * - Safety first (mandatory backups)
 * - Clear progress feedback
 * - Easy rollback
 */

const chalk = require('chalk');
const path = require('path');
const DetectionEngine = require('./detection-engine');
const { getAdoptionStrategy } = require('./adoption-strategy');
const BackupManager = require('./backup-manager');
const VersionManager = require('../version/version-manager');
const StrategySelector = require('./strategy-selector');
const ProgressReporter = require('./progress-reporter');
const SummaryGenerator = require('./summary-generator');
const ErrorFormatter = require('./error-formatter');
const GitignoreIntegration = require('../gitignore/gitignore-integration');

/**
 * Smart Adoption Orchestrator
 * Main coordinator for zero-interaction adoption
 */
class SmartOrchestrator {
  constructor(dependencies = {}) {
    // Support dependency injection for testing
    this.detectionEngine = dependencies.detectionEngine || new DetectionEngine();
    this.versionManager = dependencies.versionManager || new VersionManager();
    this.backupManager = dependencies.backupManager || new BackupManager();
    this.strategySelector = dependencies.strategySelector || new StrategySelector({
      versionManager: this.versionManager
    });
    this.progressReporter = null; // Will be initialized in orchestrate()
    // Note: SummaryGenerator and ErrorFormatter are used as utilities, not stored as instance properties
  }

  /**
   * Main orchestration method - coordinates entire adoption process
   * 
   * @param {string} projectPath - Absolute path to project root
   * @param {Object} options - Orchestration options
   * @param {boolean} options.dryRun - Preview without executing
   * @param {boolean} options.verbose - Show detailed logs
   * @param {boolean} options.skipBackup - Skip backup (dangerous, not recommended)
   * @param {boolean} options.skipUpdate - Skip template updates
   * @returns {Promise<OrchestrationResult>}
   */
  async orchestrate(projectPath, options = {}) {
    const {
      dryRun = false,
      verbose = false,
      skipBackup = false,
      skipUpdate = false
    } = options;

    // Initialize progress reporter with options
    this.progressReporter = new ProgressReporter({ verbose, quiet: false });
    this.progressReporter.start();

    const result = {
      success: false,
      mode: null,
      backup: null,
      changes: {
        updated: [],
        created: [],
        deleted: [],
        preserved: []
      },
      errors: [],
      warnings: [],
      summary: null
    };

    try {
      // Stage 1: Analyze project
      this.progressReporter.reportStage('Analyzing project structure', 'in-progress');
      const detection = await this.detectionEngine.analyze(projectPath);
      this.progressReporter.reportStage('Analyzing project structure', 'complete');

      // Stage 2: Select strategy using StrategySelector
      this.progressReporter.reportStage('Creating adoption plan', 'in-progress');
      const projectState = await this.strategySelector.detectProjectState(projectPath);
      const mode = this.strategySelector.selectMode(projectState);
      result.mode = mode;

      // Check if adoption is needed
      if (mode === 'skip') {
        this.progressReporter.reportStage('Creating adoption plan', 'complete');
        result.success = true;
        result.warnings.push('Already at latest version - no action needed');
        this.progressReporter.reportInfo('Already at latest version - no action needed');
        this.progressReporter.end();
        return result;
      }

      // Classify files and determine actions
      const plan = await this._createAdoptionPlan(projectPath, detection, mode);
      this.progressReporter.reportStage('Creating adoption plan', 'complete');

      // Display plan using progress reporter
      this.progressReporter.displayPlan(plan);

      // Dry run mode - stop here
      if (dryRun) {
        result.success = true;
        result.changes = plan.changes;
        result.warnings.push('Dry run - no changes made');
        this.progressReporter.reportWarning('Dry run mode - no changes made');
        this.progressReporter.end();
        return result;
      }

      // Stage 3: Create mandatory backup
      if (!skipBackup && plan.requiresBackup) {
        this.progressReporter.reportStage('Creating backup', 'in-progress');
        
        try {
          const backup = await this.backupManager.createMandatoryBackup(
            projectPath,
            plan.filesToModify,
            { type: 'adopt-smart' }
          );
          
          result.backup = backup;
          this.progressReporter.reportStage('Creating backup', 'complete', backup.id);
          
          // Report backup details
          this.progressReporter.reportBackup(backup);
          
          // Backup validation is now done inside createMandatoryBackup
          this.progressReporter.reportValidation({
            success: true,
            filesVerified: backup.validationDetails.filesVerified
          });
          
        } catch (backupError) {
          this.progressReporter.reportStage('Creating backup', 'error');
          // Add simple error message for result
          result.errors.push(`Backup failed: ${backupError.message}`);
          result.errors.push('Aborting adoption for safety');
          // Display formatted error to user
          const formattedError = ErrorFormatter.formatBackupError(backupError);
          console.log(formattedError);
          this.progressReporter.displayErrorSummary(result);
          this.progressReporter.end();
          return result;
        }
      } else if (skipBackup && plan.requiresBackup) {
        result.warnings.push('⚠️  Backup skipped - changes cannot be undone!');
        this.progressReporter.reportWarning('Backup skipped - changes cannot be undone!');
      }

      // Stage 5: Execute adoption
      this.progressReporter.reportStage('Updating files', 'in-progress');
      
      const adoptionResult = await this._executeAdoption(
        projectPath,
        mode,
        plan,
        skipUpdate
      );

      if (!adoptionResult.success) {
        this.progressReporter.reportStage('Updating files', 'error');
        result.errors.push(...adoptionResult.errors);
        this.progressReporter.displayErrorSummary(result);
        this.progressReporter.end();
        return result;
      }

      // Report file operations
      adoptionResult.filesUpdated.forEach(file => {
        this.progressReporter.reportFileOperation('update', file);
      });
      adoptionResult.filesCreated.forEach(file => {
        this.progressReporter.reportFileOperation('create', file);
      });
      plan.filesToPreserve.forEach(file => {
        this.progressReporter.reportFileOperation('preserve', file);
      });

      result.changes = {
        updated: adoptionResult.filesUpdated,
        created: adoptionResult.filesCreated,
        deleted: [],
        preserved: plan.filesToPreserve
      };

      this.progressReporter.reportStage('Updating files', 'complete');

      // Stage 6: Finalize
      this.progressReporter.reportStage('Finalizing adoption', 'in-progress');
      
      // Update version info
      if (!skipUpdate) {
        await this._updateVersionInfo(projectPath, mode, detection);
      }

      this.progressReporter.reportStage('Finalizing adoption', 'complete');

      // Stage 7: Fix .gitignore for team collaboration
      this.progressReporter.reportStage('Checking .gitignore configuration', 'in-progress');
      
      try {
        const gitignoreIntegration = new GitignoreIntegration();
        const gitignoreResult = await gitignoreIntegration.integrateWithAdopt(projectPath);
        
        if (gitignoreResult.success) {
          if (gitignoreResult.action !== 'skipped') {
            this.progressReporter.reportFileOperation(gitignoreResult.action, '.gitignore');
            result.warnings.push(gitignoreResult.message);
          }
        } else {
          // Don't block adoption on .gitignore fix failure
          result.warnings.push(`⚠️  .gitignore fix failed: ${gitignoreResult.message}`);
          result.warnings.push('You can fix this manually with: sce doctor --fix-gitignore');
        }
        
        this.progressReporter.reportStage('Checking .gitignore configuration', 'complete');
      } catch (gitignoreError) {
        // Don't block adoption on .gitignore fix failure
        this.progressReporter.reportStage('Checking .gitignore configuration', 'error');
        result.warnings.push(`⚠️  .gitignore check failed: ${gitignoreError.message}`);
        result.warnings.push('You can fix this manually with: sce doctor --fix-gitignore');
      }

      // Success!
      result.success = true;
      result.warnings.push(...adoptionResult.warnings);

      // Display summary using progress reporter
      this.progressReporter.displaySummary(result);
      this.progressReporter.end();

      return result;

    } catch (error) {
      result.errors.push(`Orchestration failed: ${error.message}`);
      // Display formatted error to user
      const formattedError = ErrorFormatter.formatOrchestrationError(error);
      console.log(formattedError.message);
      this.progressReporter.displayErrorSummary(result);
      this.progressReporter.end();
      return result;
    }
  }

  /**
   * Creates a detailed adoption plan
   * 
   * @param {string} projectPath - Project path
   * @param {DetectionResult} detection - Detection result
   * @param {string} mode - Adoption mode
   * @returns {Promise<AdoptionPlan>}
   * @private
   */
  async _createAdoptionPlan(projectPath, detection, mode) {
    const plan = {
      mode,
      requiresBackup: false,
      filesToModify: [],
      filesToPreserve: [],
      changes: {
        updated: [],
        created: [],
        deleted: [],
        preserved: []
      }
    };

    // Define template files
    const templateFiles = [
      'steering/CORE_PRINCIPLES.md',
      'steering/ENVIRONMENT.md',
      'steering/RULES_GUIDE.md',
      'tools/ultrawork_enhancer.py',
      'config/studio-security.json',
      'config/orchestrator.json',
      'config/errorbook-registry.json',
      'config/takeover-baseline.json',
      'config/session-governance.json',
      'config/spec-domain-policy.json',
      'config/problem-eval-policy.json',
      'config/problem-closure-policy.json',
      'README.md'
    ];

    // Define files to always preserve
    const preservePatterns = [
      'specs/',
      'steering/CURRENT_CONTEXT.md',
      'backups/'
    ];

    if (mode === 'fresh') {
      // Fresh adoption - create everything
      plan.changes.created = [
        '.sce/',
        '.sce/specs/',
        '.sce/steering/',
        '.sce/tools/',
        '.sce/config/',
        '.sce/backups/',
        ...templateFiles.map(f => `.sce/${f}`),
        '.sce/version.json'
      ];
      plan.requiresBackup = false;

    } else if (mode === 'smart-adopt' || mode === 'smart-update') {
      // Check which template files exist and differ
      const kiroPath = path.join(projectPath, '.sce');
      
      for (const templateFile of templateFiles) {
        const filePath = path.join(kiroPath, templateFile);
        const fs = require('fs-extra');
        
        if (await fs.pathExists(filePath)) {
          // File exists - will be updated
          plan.filesToModify.push(templateFile);
          plan.changes.updated.push(`.sce/${templateFile}`);
        } else {
          // File doesn't exist - will be created
          plan.changes.created.push(`.sce/${templateFile}`);
        }
      }

      // Identify preserved files
      if (detection.hasSpecs) {
        plan.filesToPreserve.push('specs/');
        plan.changes.preserved.push('specs/');
      }

      // Always preserve CURRENT_CONTEXT.md if it exists
      const currentContextPath = path.join(kiroPath, 'steering/CURRENT_CONTEXT.md');
      const fs = require('fs-extra');
      if (await fs.pathExists(currentContextPath)) {
        plan.filesToPreserve.push('steering/CURRENT_CONTEXT.md');
        plan.changes.preserved.push('steering/CURRENT_CONTEXT.md');
      }

      plan.requiresBackup = plan.filesToModify.length > 0;
    }

    return plan;
  }

  /**
   * Executes the adoption strategy
   * 
   * @param {string} projectPath - Project path
   * @param {string} mode - Adoption mode
   * @param {AdoptionPlan} plan - Adoption plan
   * @param {boolean} skipUpdate - Skip template updates
   * @returns {Promise<AdoptionResult>}
   * @private
   */
  async _executeAdoption(projectPath, mode, plan, skipUpdate) {
    try {
      // Map smart modes to strategy modes
      let strategyMode = mode;
      if (mode === 'smart-adopt') {
        strategyMode = 'partial';
      } else if (mode === 'smart-update') {
        strategyMode = 'full';
      }

      const strategy = getAdoptionStrategy(strategyMode);
      const packageJson = require('../../package.json');

      // Build resolution map - update all template files
      const resolutionMap = {};
      if (!skipUpdate) {
        plan.filesToModify.forEach(file => {
          resolutionMap[file] = 'overwrite';
        });
      }

      // Preserve user content
      plan.filesToPreserve.forEach(file => {
        resolutionMap[file] = 'keep';
      });

      const result = await strategy.execute(projectPath, strategyMode, {
        sceVersion: packageJson.version,
        dryRun: false,
        force: !skipUpdate,
        resolutionMap
      });

      return result;
    } catch (error) {
      return {
        success: false,
        errors: [error.message],
        warnings: [],
        filesCreated: [],
        filesUpdated: [],
        filesSkipped: []
      };
    }
  }

  /**
   * Updates version information
   * 
   * @param {string} projectPath - Project path
   * @param {string} mode - Adoption mode
   * @param {DetectionResult} detection - Detection result
   * @returns {Promise<void>}
   * @private
   */
  async _updateVersionInfo(projectPath, mode, detection) {
    const packageJson = require('../../package.json');
    const targetVersion = packageJson.version;

    if (mode === 'fresh' || mode === 'smart-adopt') {
      // Create new version info
      const versionInfo = this.versionManager.createVersionInfo(targetVersion);
      await this.versionManager.writeVersion(projectPath, versionInfo);
    } else if (mode === 'smart-update') {
      // Update existing version info
      const existingVersion = await this.versionManager.readVersion(projectPath);
      if (existingVersion) {
        const updatedVersion = this.versionManager.addUpgradeHistory(
          existingVersion,
          detection.existingVersion,
          targetVersion,
          true
        );
        await this.versionManager.writeVersion(projectPath, updatedVersion);
      }
    }
  }

  /**
   * Generates comprehensive summary using SummaryGenerator
   * 
   * @param {OrchestrationResult} result - Orchestration result
   * @returns {string} Formatted summary text
   */
  generateSummary(result) {
    // Create a new summary generator and populate it with result data
    const generator = new SummaryGenerator();
    generator.setMode(result.mode);
    
    if (result.backup) {
      generator.setBackup(result.backup);
    }
    
    // Add file changes
    if (result.changes) {
      generator.addFileChanges('create', result.changes.created || []);
      generator.addFileChanges('update', result.changes.updated || []);
      generator.addFileChanges('delete', result.changes.deleted || []);
      generator.addFileChanges('preserve', result.changes.preserved || []);
    }
    
    // Add warnings and errors
    if (result.warnings) {
      result.warnings.forEach(warning => generator.addWarning(warning));
    }
    if (result.errors) {
      result.errors.forEach(error => generator.addError(error));
    }
    
    // Generate text summary with verbose mode to show all details
    return generator.generateTextSummary({ verbose: true, color: true });
  }
}

module.exports = SmartOrchestrator;
