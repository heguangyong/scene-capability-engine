const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const { runOrchestration } = require('./orchestrate');
const {
  parseSpecTargets,
  runMultiSpecViaOrchestrate
} = require('../spec/multi-spec-orchestrate');

const { ContextCollector } = require('../spec/bootstrap/context-collector');
const { QuestionnaireEngine } = require('../spec/bootstrap/questionnaire-engine');
const { DraftGenerator } = require('../spec/bootstrap/draft-generator');
const { TraceEmitter } = require('../spec/bootstrap/trace-emitter');
const { ensureSpecDomainArtifacts } = require('../spec/domain-modeling');
const { SessionStore } = require('../runtime/session-store');
const { resolveSpecSceneBinding } = require('../runtime/scene-session-binding');
const { bindMultiSpecSceneSession } = require('../runtime/multi-spec-scene-session');

async function runSpecBootstrap(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const sessionStore = dependencies.sessionStore || new SessionStore(projectPath);

  const specTargets = parseSpecTargets({
    spec: options.spec || options.name,
    specs: options.specs
  });

  if (specTargets.length > 1) {
    const executeOrchestration = dependencies.runOrchestration || runOrchestration;
    return bindMultiSpecSceneSession({
      specTargets,
      sceneId: options.scene,
      commandName: 'spec-bootstrap',
      commandLabel: 'Multi-spec bootstrap',
      commandOptions: options,
      runViaOrchestrate: () => runMultiSpecViaOrchestrate({
        specTargets,
        projectPath,
        commandOptions: options,
        runOrchestration: executeOrchestration,
        commandLabel: 'Multi-spec bootstrap',
        nextActionLabel: 'Multi-spec bootstrap defaulted to orchestrate mode.'
      })
    }, {
      projectPath,
      fileSystem: dependencies.fileSystem || fs,
      sessionStore
    });
  }

  const contextCollector = dependencies.contextCollector || new ContextCollector(projectPath);
  const questionnaireEngine = dependencies.questionnaireEngine || new QuestionnaireEngine({
    prompt: dependencies.prompt,
    maxQuestions: dependencies.maxQuestions
  });
  const draftGenerator = dependencies.draftGenerator || new DraftGenerator();
  const traceEmitter = dependencies.traceEmitter || new TraceEmitter();

  if (options.nonInteractive && specTargets.length === 0) {
    throw new Error('--name is required in non-interactive mode');
  }

  const context = await contextCollector.collect();
  const answers = await questionnaireEngine.collect({
    nonInteractive: options.nonInteractive,
    specName: specTargets[0] || options.name,
    profile: options.profile,
    template: options.template
  });

  const specName = (specTargets[0] || options.name || answers.specName || '').trim();
  if (!specName) {
    throw new Error('Spec name is required');
  }

  const sceneBinding = await resolveSpecSceneBinding({
    sceneId: options.scene,
    allowNoScene: false
  }, {
    projectPath,
    fileSystem: dependencies.fileSystem || fs,
    sessionStore
  });

  let specSession = null;
  if (sceneBinding && !options.dryRun) {
    const linked = await sessionStore.startSpecSession({
      sceneId: sceneBinding.scene_id,
      specId: specName,
      objective: `Spec bootstrap: ${specName}`
    });
    specSession = linked.spec_session;
  }

  try {
    const draft = draftGenerator.generate({
      specName,
      profile: options.profile || 'general',
      template: options.template || 'default',
      context,
      answers
    });

    const specPath = path.join(projectPath, '.sce', 'specs', specName);
    const files = {
      requirements: path.join(specPath, 'requirements.md'),
      design: path.join(specPath, 'design.md'),
      tasks: path.join(specPath, 'tasks.md')
    };

    if (!options.dryRun) {
      await fs.ensureDir(specPath);
      await fs.writeFile(files.requirements, draft.requirements, 'utf8');
      await fs.writeFile(files.design, draft.design, 'utf8');
      await fs.writeFile(files.tasks, draft.tasks, 'utf8');
    }

    const domainArtifacts = await ensureSpecDomainArtifacts(projectPath, specName, {
      dryRun: !!options.dryRun,
      sceneId: sceneBinding.scene_id,
      problemStatement: answers.problemStatement,
      primaryFlow: answers.primaryFlow,
      verificationPlan: answers.verificationPlan
    });

    const result = {
      success: true,
      specName,
      specPath: path.relative(projectPath, specPath),
      dryRun: !!options.dryRun,
      files: {
        requirements: path.relative(projectPath, files.requirements),
        design: path.relative(projectPath, files.design),
        tasks: path.relative(projectPath, files.tasks),
        domain_map: path.relative(projectPath, domainArtifacts.paths.domain_map),
        scene_spec: path.relative(projectPath, domainArtifacts.paths.scene_spec),
        domain_chain: path.relative(projectPath, domainArtifacts.paths.domain_chain)
      },
      trace: {
        template: options.template || 'default',
        profile: options.profile || 'general',
        parameters: {
          nonInteractive: !!options.nonInteractive,
          dryRun: !!options.dryRun,
          json: !!options.json
        },
        context: {
          totalSpecs: context.totalSpecs,
          preferredLanguage: context.preferredLanguage
        },
        mapping: draft.metadata.mapping
      },
      preview: {
        requirements: draft.requirements,
        design: draft.design,
        tasks: draft.tasks,
        domain_map: domainArtifacts.preview.domain_map,
        scene_spec: domainArtifacts.preview.scene_spec,
        domain_chain: domainArtifacts.preview.domain_chain
      },
      scene_session: sceneBinding
        ? {
          bound: true,
          scene_id: sceneBinding.scene_id,
          scene_cycle: sceneBinding.scene_cycle,
          scene_session_id: sceneBinding.scene_session_id,
          spec_session_id: specSession ? specSession.session_id : null,
          binding_source: sceneBinding.source
        }
        : {
          bound: false
        }
    };

    if (specSession) {
      await sessionStore.completeSpecSession({
        specSessionRef: specSession.session_id,
        status: 'completed',
        summary: `Spec bootstrap completed: ${specName}`,
        payload: {
          command: 'spec-bootstrap',
          spec: specName
        }
      });
    }

    traceEmitter.emit(result, { json: options.json });
    return result;
  } catch (error) {
    if (specSession) {
      await sessionStore.completeSpecSession({
        specSessionRef: specSession.session_id,
        status: 'failed',
        summary: `Spec bootstrap failed: ${specName}`,
        payload: {
          command: 'spec-bootstrap',
          spec: specName,
          error: error.message
        }
      });
    }
    throw error;
  }
}

function registerSpecBootstrapCommand(program) {
  program
    .command('spec-bootstrap')
    .description('Bootstrap requirements/design/tasks draft (use: sce spec bootstrap)')
    .option('--name <spec-name>', 'Spec name to generate')
    .option('--spec <name>', 'Alias of --name')
    .option('--specs <names>', 'Comma-separated Spec identifiers (multi-spec defaults to orchestrate mode)')
    .option('--template <template-id>', 'Template hint for draft generation')
    .option('--profile <profile-id>', 'Profile for default generation strategy')
    .option('--scene <scene-id>', 'Bind this spec bootstrap as a child session of an active scene')
    .option('--non-interactive', 'Disable prompts and use arguments/defaults only')
    .option('--dry-run', 'Preview generation result without writing files')
    .option('--json', 'Output machine-readable JSON')
    .option('--max-parallel <n>', 'Maximum parallel agents when orchestrate mode is used', parseInt)
    .action(async (options) => {
      try {
        await runSpecBootstrap(options);
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red('❌ Spec bootstrap failed:'), error.message);
        }
        process.exit(1);
      }
    });
}

module.exports = {
  registerSpecBootstrapCommand,
  runSpecBootstrap
};
