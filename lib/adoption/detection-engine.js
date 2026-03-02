/**
 * Detection Engine
 * 
 * Analyzes project structure and determines the appropriate adoption strategy.
 * Detects project type, existing .sce/ components, and potential conflicts.
 */

const path = require('path');
const {
  pathExists,
  listFiles,
  readJSON
} = require('../utils/fs-utils');
const SteeringManager = require('../steering/steering-manager');

class DetectionEngine {
  constructor() {
    this.sceDir = '.sce';
    this.versionFile = 'version.json';
    this.specsDir = 'specs';
    this.steeringDir = 'steering';
    this.toolsDir = 'tools';
    this.steeringManager = new SteeringManager();
  }

  /**
   * Analyzes project directory and returns detection result
   * 
   * @param {string} projectPath - Absolute path to project root
   * @returns {Promise<DetectionResult>}
   */
  async analyze(projectPath) {
    try {
      const kiroPath = path.join(projectPath, this.sceDir);
      const hasKiroDir = await pathExists(kiroPath);
      
      let hasVersionFile = false;
      let hasSpecs = false;
      let hasSteering = false;
      let hasTools = false;
      let existingVersion = null;
      let steeringDetection = null;
      
      if (hasKiroDir) {
        // Check for version.json
        const versionPath = path.join(kiroPath, this.versionFile);
        hasVersionFile = await pathExists(versionPath);
        
        if (hasVersionFile) {
          try {
            const versionInfo = await readJSON(versionPath);
            existingVersion = versionInfo['sce-version'] || null;
          } catch (error) {
            // Invalid version file
            hasVersionFile = false;
          }
        }
        
        // Check for specs/
        const specsPath = path.join(kiroPath, this.specsDir);
        hasSpecs = await pathExists(specsPath);
        
        // Check for steering/ using SteeringManager
        steeringDetection = await this.steeringManager.detectSteering(projectPath);
        hasSteering = steeringDetection.hasExistingSteering;
        
        // Check for tools/
        const toolsPath = path.join(kiroPath, this.toolsDir);
        hasTools = await pathExists(toolsPath);
      }
      
      // Detect project type
      const projectType = await this.detectProjectType(projectPath);
      
      // Detect conflicts (only if we're going to add template files)
      const conflicts = hasKiroDir ? await this.detectConflicts(projectPath) : [];
      
      return {
        hasKiroDir,
        hasVersionFile,
        hasSpecs,
        hasSteering,
        hasTools,
        projectType,
        existingVersion,
        conflicts,
        steeringDetection // Add steering detection details
      };
    } catch (error) {
      throw new Error(`Failed to analyze project: ${error.message}`);
    }
  }

  /**
   * Determines which adoption strategy to use
   * 
   * @param {DetectionResult} result - Detection result from analyze()
   * @returns {AdoptionMode} - 'fresh', 'partial', or 'full'
   */
  determineStrategy(result) {
    // Fresh adoption: no .sce/ directory
    if (!result.hasKiroDir) {
      return 'fresh';
    }
    
    // Partial adoption: .sce/ exists but no version.json
    if (!result.hasVersionFile) {
      return 'partial';
    }
    
    // Full adoption: complete .sce/ with version.json
    return 'full';
  }

  /**
   * Detects project type (Node.js, Python, mixed, unknown)
   * 
   * @param {string} projectPath - Absolute path to project root
   * @returns {Promise<ProjectType>}
   */
  async detectProjectType(projectPath) {
    try {
      const hasPackageJson = await pathExists(path.join(projectPath, 'package.json'));
      const hasRequirementsTxt = await pathExists(path.join(projectPath, 'requirements.txt'));
      const hasPyprojectToml = await pathExists(path.join(projectPath, 'pyproject.toml'));
      const hasSetupPy = await pathExists(path.join(projectPath, 'setup.py'));
      
      const isNodeJs = hasPackageJson;
      const isPython = hasRequirementsTxt || hasPyprojectToml || hasSetupPy;
      
      if (isNodeJs && isPython) {
        return 'mixed';
      } else if (isNodeJs) {
        return 'nodejs';
      } else if (isPython) {
        return 'python';
      } else {
        return 'unknown';
      }
    } catch (error) {
      throw new Error(`Failed to detect project type: ${error.message}`);
    }
  }

  /**
   * Detects conflicts between existing files and template files
   * 
   * @param {string} projectPath - Absolute path to project root
   * @returns {Promise<FileConflict[]>}
   */
  async detectConflicts(projectPath) {
    const conflicts = [];
    
    try {
      const kiroPath = path.join(projectPath, this.sceDir);
      
      // Define template files that might conflict
      const templateFiles = [
        'steering/CORE_PRINCIPLES.md',
        'steering/ENVIRONMENT.md',
        'steering/CURRENT_CONTEXT.md',
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
        'README.md',
        'ultrawork-application-guide.md',
        'ultrawork-integration-summary.md',
        'sisyphus-deep-dive.md'
      ];
      
      for (const templateFile of templateFiles) {
        const filePath = path.join(kiroPath, templateFile);
        const exists = await pathExists(filePath);
        
        if (exists) {
          conflicts.push({
            path: templateFile,
            type: 'file',
            existingContent: filePath,
            templateContent: `template:${templateFile}`
          });
        }
      }
      
      return conflicts;
    } catch (error) {
      throw new Error(`Failed to detect conflicts: ${error.message}`);
    }
  }

  /**
   * Categorizes conflicts by type for better display
   * 
   * @param {FileConflict[]} conflicts - Array of conflicts
   * @returns {CategorizedConflicts}
   */
  categorizeConflicts(conflicts) {
    return {
      steering: conflicts.filter(c => c.path.startsWith('steering/')),
      documentation: conflicts.filter(c => 
        c.path.endsWith('.md') && 
        !c.path.startsWith('steering/') && 
        !c.path.startsWith('tools/')
      ),
      tools: conflicts.filter(c => c.path.startsWith('tools/')),
      other: conflicts.filter(c => 
        !c.path.startsWith('steering/') && 
        !c.path.startsWith('tools/') && 
        !c.path.endsWith('.md')
      )
    };
  }

  /**
   * Validates that a project path is valid
   * 
   * @param {string} projectPath - Path to validate
   * @returns {Promise<boolean>}
   */
  async validateProjectPath(projectPath) {
    try {
      const exists = await pathExists(projectPath);
      if (!exists) {
        return false;
      }
      
      // Check if it's a directory
      const fs = require('fs-extra');
      const stats = await fs.stat(projectPath);
      return stats.isDirectory();
    } catch (error) {
      return false;
    }
  }

  /**
   * Gets a summary of the detection result for display
   * 
   * @param {DetectionResult} result - Detection result
   * @returns {string} - Human-readable summary
   */
  getSummary(result) {
    const lines = [];
    
    lines.push('Project Analysis:');
    lines.push(`  Project Type: ${result.projectType}`);
    lines.push(`  .sce/ Directory: ${result.hasKiroDir ? 'Yes' : 'No'}`);
    
    if (result.hasKiroDir) {
      lines.push(`  version.json: ${result.hasVersionFile ? 'Yes' : 'No'}`);
      if (result.existingVersion) {
        lines.push(`  Current Version: ${result.existingVersion}`);
      }
      lines.push(`  specs/: ${result.hasSpecs ? 'Yes' : 'No'}`);
      lines.push(`  steering/: ${result.hasSteering ? 'Yes' : 'No'}`);
      
      // Show steering details if available
      if (result.steeringDetection && result.steeringDetection.hasExistingSteering) {
        lines.push(`    Files: ${result.steeringDetection.count} file(s)`);
      }
      
      lines.push(`  tools/: ${result.hasTools ? 'Yes' : 'No'}`);
      
      if (result.conflicts.length > 0) {
        lines.push(`  Conflicts: ${result.conflicts.length} file(s)`);
      }
    }
    
    const strategy = this.determineStrategy(result);
    lines.push(`  Recommended Strategy: ${strategy}`);
    
    return lines.join('\n');
  }
}

module.exports = DetectionEngine;
