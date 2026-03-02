'use strict';

const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const { runErrorbookRecordCommand } = require('../../../lib/commands/errorbook');
const {
  parseArgs,
  runErrorbookReleaseGateScript
} = require('../../../scripts/errorbook-release-gate');

describe('errorbook-release-gate script', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-errorbook-release-gate-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  test('parseArgs supports core flags', () => {
    const parsed = parseArgs([
      '--min-risk', 'medium',
      '--min-quality', '65',
      '--include-verified',
      '--fail-on-block',
      '--json',
      '--project-path', tempDir
    ]);

    expect(parsed.minRisk).toBe('medium');
    expect(parsed.minQuality).toBe(65);
    expect(parsed.includeVerified).toBe(true);
    expect(parsed.failOnBlock).toBe(true);
    expect(parsed.json).toBe(true);
    expect(parsed.projectPath).toBe(path.resolve(tempDir));
  });

  test('passes when no unresolved high-risk candidate exists', async () => {
    const result = await runErrorbookReleaseGateScript({
      projectPath: tempDir,
      minRisk: 'high',
      failOnBlock: true,
      json: true
    });

    expect(result.mode).toBe('errorbook-release-gate');
    expect(result.passed).toBe(true);
    expect(result.blocked_count).toBe(0);
    expect(result.exit_code).toBe(0);
  });

  test('returns exit code 2 when high-risk candidate blocks release', async () => {
    await runErrorbookRecordCommand({
      title: 'Release blocker sample',
      symptom: 'Required release gate failed and blocked publish.',
      rootCause: 'Pending remediation for release blocker.',
      fixAction: ['Fix release gate failure'],
      tags: 'release-blocker,security',
      ontology: 'execution_flow,decision_policy',
      status: 'candidate',
      json: true
    }, {
      projectPath: tempDir
    });

    const result = await runErrorbookReleaseGateScript({
      projectPath: tempDir,
      minRisk: 'high',
      failOnBlock: true,
      json: true
    });

    expect(result.passed).toBe(false);
    expect(result.blocked_count).toBe(1);
    expect(result.exit_code).toBe(2);
  });

  test('blocks when temporary mitigation policy is expired', async () => {
    await runErrorbookRecordCommand({
      title: 'Expired mitigation gate fixture',
      symptom: 'Temporary mitigation stayed active beyond cleanup deadline.',
      rootCause: 'Fallback cleanup task was not completed on schedule.',
      fixAction: ['Complete cleanup task and remove fallback'],
      tags: 'ops',
      ontology: 'execution_flow',
      status: 'candidate',
      temporaryMitigation: true,
      mitigationReason: 'Emergency fallback for incident isolation',
      mitigationExit: 'Primary flow restored and validated',
      mitigationCleanup: 'spec/remove-emergency-fallback',
      mitigationDeadline: '2020-01-01T00:00:00Z',
      json: true
    }, {
      projectPath: tempDir
    });

    const result = await runErrorbookReleaseGateScript({
      projectPath: tempDir,
      minRisk: 'high',
      failOnBlock: true,
      json: true
    });

    expect(result.passed).toBe(false);
    expect(result.mitigation_blocked_count).toBe(1);
    expect(result.exit_code).toBe(2);
  });
});
