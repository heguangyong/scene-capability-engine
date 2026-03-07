const { resolveLatestRecoverableBatchSummary, resolveLatestPendingControllerSession } = require('./recovery-selection-service');

﻿async function executeGovernanceAdvisoryRecover(projectPath, options = {}, dependencies = {}) {
  const {
    normalizeGovernanceAdvisoryRecoverMaxRounds,
    loadCloseLoopBatchSummaryPayload,
    resolveRecoveryMemoryScope,
    executeCloseLoopRecoveryCycle,
    readCloseLoopBatchSummaryEntries,
    buildCloseLoopBatchGoalsFromSummaryPayload
  } = dependencies;
  const recoverMaxRounds = normalizeGovernanceAdvisoryRecoverMaxRounds(options.recoverMaxRounds, 3);
  const dryRun = Boolean(options.dryRun);
  const summaryCandidate = typeof options.summary === 'string' && options.summary.trim()
    ? options.summary.trim()
    : 'latest';
  const explicitSummary = summaryCandidate.toLowerCase() !== 'latest';
  let sourceSummary = null;

  if (explicitSummary) {
    try {
      sourceSummary = await loadCloseLoopBatchSummaryPayload(projectPath, summaryCandidate);
    } catch (error) {
      return {
        id: 'recover-latest',
        status: 'failed',
        recover_max_rounds: recoverMaxRounds,
        dry_run: dryRun,
        error: error.message
      };
    }
  } else {
    sourceSummary = await resolveLatestRecoverableBatchSummary(projectPath, 'pending', {
      readCloseLoopBatchSummaryEntries,
      loadCloseLoopBatchSummaryPayload,
      buildCloseLoopBatchGoalsFromSummaryPayload
    });
  }

  if (!sourceSummary) {
    return {
      id: 'recover-latest',
      status: 'skipped',
      recover_max_rounds: recoverMaxRounds,
      dry_run: dryRun,
      error: 'No recoverable batch summary with pending goals was found.'
    };
  }

  try {
    const recoveryMemoryScope = await resolveRecoveryMemoryScope(projectPath, options.recoveryMemoryScope);
    const recoveryResult = await executeCloseLoopRecoveryCycle({
      projectPath,
      sourceSummary,
      baseOptions: {
        dryRun,
        run: dryRun ? false : undefined,
        resumeStrategy: 'pending',
        batchAutonomous: true,
        continueOnError: true
      },
      recoverAutonomousEnabled: true,
      resumeStrategy: 'pending',
      recoverUntilComplete: true,
      recoverMaxRounds,
      recoverMaxDurationMs: null,
      recoveryMemoryTtlDays: null,
      recoveryMemoryScope,
      actionCandidate: null
    });
    const recoverySummary = recoveryResult && recoveryResult.summary ? recoveryResult.summary : null;
    const recoveryStatus = `${recoverySummary && recoverySummary.status ? recoverySummary.status : ''}`.trim().toLowerCase();
    const failed = recoveryStatus === 'failed' || recoveryStatus === 'partial-failed';

    return {
      id: 'recover-latest',
      status: failed ? 'failed' : 'applied',
      recover_max_rounds: recoverMaxRounds,
      dry_run: dryRun,
      source_summary_file: sourceSummary.file,
      result: recoverySummary
        ? {
          status: recoverySummary.status,
          processed_goals: Number(recoverySummary.processed_goals) || 0,
          failed_goals: Number(recoverySummary.failed_goals) || 0,
          recovery_cycle: recoverySummary.recovery_cycle || null,
          batch_session_file: recoverySummary.batch_session && recoverySummary.batch_session.file
            ? recoverySummary.batch_session.file
            : null
        }
        : null,
      error: failed && recoverySummary
        ? `Recovery finished with status: ${recoverySummary.status}`
        : null
    };
  } catch (error) {
    return {
      id: 'recover-latest',
      status: 'failed',
      recover_max_rounds: recoverMaxRounds,
      dry_run: dryRun,
      source_summary_file: sourceSummary.file,
      error: error.message
    };
  }
}

async function executeGovernanceAdvisoryControllerResume(projectPath, options = {}, dependencies = {}) {
  const {
    normalizeGovernanceAdvisoryControllerMaxCycles,
    loadCloseLoopControllerSessionPayload,
    runCloseLoopController,
    readCloseLoopControllerSessionEntries
  } = dependencies;
  const maxCycles = normalizeGovernanceAdvisoryControllerMaxCycles(options.maxCycles, 20);
  const dryRun = Boolean(options.dryRun);
  const sessionCandidate = typeof options.session === 'string' && options.session.trim()
    ? options.session.trim()
    : 'latest';
  const explicitSession = sessionCandidate.toLowerCase() !== 'latest';
  let sourceSession = null;

  if (explicitSession) {
    try {
      sourceSession = await loadCloseLoopControllerSessionPayload(projectPath, sessionCandidate);
    } catch (error) {
      return {
        id: 'controller-resume-latest',
        status: 'failed',
        max_cycles: maxCycles,
        dry_run: dryRun,
        error: error.message
      };
    }
  } else {
    sourceSession = await resolveLatestPendingControllerSession(projectPath, {
      readCloseLoopControllerSessionEntries,
      loadCloseLoopControllerSessionPayload
    });
  }

  if (!sourceSession) {
    return {
      id: 'controller-resume-latest',
      status: 'skipped',
      max_cycles: maxCycles,
      dry_run: dryRun,
      error: 'No controller session with pending goals was found.'
    };
  }

  try {
    const controllerSummary = await runCloseLoopController(null, {
      maxCycles,
      dryRun,
      run: dryRun ? false : undefined,
      waitOnEmpty: false,
      stopOnGoalFailure: false,
      controllerPrintProgramSummary: false,
      controllerOut: null,
      out: null,
      json: false
    }, {
      projectPath,
      resumedSession: sourceSession
    });
    const controllerStatus = `${controllerSummary && controllerSummary.status ? controllerSummary.status : ''}`.trim().toLowerCase();
    const failed = controllerStatus === 'failed' || controllerStatus === 'partial-failed';

    return {
      id: 'controller-resume-latest',
      status: failed ? 'failed' : 'applied',
      max_cycles: maxCycles,
      dry_run: dryRun,
      source_controller_session_file: sourceSession.file,
      result: controllerSummary
        ? {
          status: controllerSummary.status,
          cycles_performed: Number(controllerSummary.cycles_performed) || 0,
          processed_goals: Number(controllerSummary.processed_goals) || 0,
          failed_goals: Number(controllerSummary.failed_goals) || 0,
          pending_goals: Number(controllerSummary.pending_goals) || 0,
          stop_reason: controllerSummary.stop_reason || null,
          controller_session_file: controllerSummary.controller_session && controllerSummary.controller_session.file
            ? controllerSummary.controller_session.file
            : null
        }
        : null,
      error: failed && controllerSummary
        ? `Controller resume finished with status: ${controllerSummary.status}`
        : null
    };
  } catch (error) {
    return {
      id: 'controller-resume-latest',
      status: 'failed',
      max_cycles: maxCycles,
      dry_run: dryRun,
      source_controller_session_file: sourceSession.file,
      error: error.message
    };
  }
}

module.exports = {
  executeGovernanceAdvisoryRecover,
  executeGovernanceAdvisoryControllerResume
};
