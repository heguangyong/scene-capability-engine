const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const {
  resolveErrorbookPaths,
  DEFAULT_ERRORBOOK_REGISTRY_CACHE,
  normalizeOntologyTags,
  runErrorbookRecordCommand,
  runErrorbookExportCommand,
  runErrorbookSyncRegistryCommand,
  runErrorbookRegistryHealthCommand,
  runErrorbookIncidentListCommand,
  runErrorbookIncidentShowCommand,
  runErrorbookListCommand,
  runErrorbookShowCommand,
  runErrorbookFindCommand,
  runErrorbookPromoteCommand,
  runErrorbookReleaseGateCommand,
  runErrorbookDeprecateCommand,
  runErrorbookRequalifyCommand
} = require('../../../lib/commands/errorbook');

describe('errorbook command workflow', () => {
  let tempDir;
  let originalLog;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-errorbook-'));
    originalLog = console.log;
    console.log = jest.fn();
  });

  afterEach(async () => {
    console.log = originalLog;
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  test('records curated entry and persists index contract', async () => {
    const result = await runErrorbookRecordCommand({
      title: 'Order approval timeout',
      symptom: 'Order approval API returned 504 during peak hour traffic.',
      rootCause: 'Moqui order service lock timeout was too low under contention.',
      fixAction: ['Increase lock timeout to 15s', 'Add bounded retry for idempotent requests'],
      tags: 'moqui,order',
      ontology: 'entity,relation,business_rule',
      status: 'candidate',
      json: true
    }, {
      projectPath: tempDir
    });

    expect(result.mode).toBe('errorbook-record');
    expect(result.created).toBe(true);
    expect(result.entry.id).toContain('eb-');
    expect(result.entry.quality_score).toBeGreaterThanOrEqual(70);
    expect(result.incident_loop).toBeDefined();
    expect(result.incident_loop.incident.state).toBe('open');
    expect(result.incident_loop.incident.attempt_count).toBe(1);
    expect(result.incident_loop.latest_attempt.attempt_no).toBe(1);

    const paths = resolveErrorbookPaths(tempDir);
    const index = await fs.readJson(paths.indexFile);
    expect(index.total_entries).toBe(1);
    expect(index.entries[0].fingerprint).toBe(result.entry.fingerprint);
    const incidentIndex = await fs.readJson(paths.incidentIndexFile);
    expect(incidentIndex.total_incidents).toBe(1);
    const incidentFile = path.join(paths.incidentsDir, `${incidentIndex.incidents[0].id}.json`);
    expect(await fs.pathExists(incidentFile)).toBe(true);
  });

  test('deduplicates by fingerprint and merges remediation details', async () => {
    const first = await runErrorbookRecordCommand({
      title: 'Inventory reservation stale lock',
      symptom: 'Reservation transaction hangs under concurrent edits.',
      rootCause: 'Stale transaction lock was not released in rollback path.',
      fixAction: ['Release lock in rollback hook'],
      tags: 'inventory',
      ontology: 'entity',
      json: true
    }, {
      projectPath: tempDir
    });

    const second = await runErrorbookRecordCommand({
      title: 'Inventory reservation stale lock',
      symptom: 'Reservation transaction hangs under concurrent edits.',
      rootCause: 'Stale transaction lock was not released in rollback path.',
      fixAction: ['Add lock expiration metric alert'],
      verification: ['npm run test -- inventory-locks'],
      tags: 'inventory,ops',
      ontology: 'relation',
      json: true
    }, {
      projectPath: tempDir
    });

    expect(second.created).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.occurrences).toBe(2);
    expect(second.entry.fix_actions).toContain('Release lock in rollback hook');
    expect(second.entry.fix_actions).toContain('Add lock expiration metric alert');
    expect(second.entry.verification_evidence).toContain('npm run test -- inventory-locks');
    expect(second.entry.ontology_tags).toEqual(expect.arrayContaining(['entity', 'relation']));
  });

  test('tracks every record attempt in staging incidents and auto-resolves on verified status', async () => {
    const first = await runErrorbookRecordCommand({
      title: 'Customer profile merge conflict',
      symptom: 'Customer merge intermittently fails with optimistic lock mismatch.',
      rootCause: 'Profile update and merge write path races on version field.',
      fixAction: ['Serialize merge path writes'],
      tags: 'customer',
      ontology: 'entity,relation',
      status: 'candidate',
      json: true
    }, {
      projectPath: tempDir
    });

    const second = await runErrorbookRecordCommand({
      title: 'Customer profile merge conflict',
      symptom: 'Customer merge intermittently fails with optimistic lock mismatch.',
      rootCause: 'Profile update and merge write path races on version field.',
      fixAction: ['Add retry with optimistic version refresh'],
      tags: 'customer',
      ontology: 'entity,relation',
      status: 'candidate',
      json: true
    }, {
      projectPath: tempDir
    });

    const third = await runErrorbookRecordCommand({
      title: 'Customer profile merge conflict',
      symptom: 'Customer merge intermittently fails with optimistic lock mismatch.',
      rootCause: 'Profile update and merge write path races on version field.',
      fixAction: ['Add deterministic merge queue'],
      verification: ['Merge concurrency test passed with 500 parallel requests'],
      tags: 'customer,debug-evidence',
      ontology: 'entity,relation,business_rule',
      status: 'verified',
      json: true
    }, {
      projectPath: tempDir
    });

    expect(first.incident_loop.incident.state).toBe('open');
    expect(second.incident_loop.incident.attempt_count).toBe(2);
    expect(third.incident_loop.incident.state).toBe('resolved');
    expect(third.incident_loop.incident.linked_entry_id).toBe(third.entry.id);

    const listed = await runErrorbookIncidentListCommand({
      state: 'resolved',
      json: true
    }, {
      projectPath: tempDir
    });
    expect(listed.mode).toBe('errorbook-incident-list');
    expect(listed.total_results).toBe(1);
    expect(listed.incidents[0].attempt_count).toBe(3);

    const shown = await runErrorbookIncidentShowCommand({
      id: listed.incidents[0].id,
      json: true
    }, {
      projectPath: tempDir
    });
    expect(shown.mode).toBe('errorbook-incident-show');
    expect(shown.incident.state).toBe('resolved');
    expect(shown.incident.attempts).toHaveLength(3);

    const paths = resolveErrorbookPaths(tempDir);
    const resolvedSnapshotPath = path.join(paths.resolvedDir, `${listed.incidents[0].id}.json`);
    expect(await fs.pathExists(resolvedSnapshotPath)).toBe(true);
  });

  test('enforces debug evidence from third repeated fix attempt onward', async () => {
    await runErrorbookRecordCommand({
      title: 'Order lock contention unresolved',
      symptom: 'Order approve call times out under lock contention.',
      rootCause: 'Lock order conflict between approval and reservation.',
      fixAction: ['Adjust lock order'],
      tags: 'order',
      ontology: 'entity,relation',
      status: 'candidate',
      json: true
    }, {
      projectPath: tempDir
    });

    await runErrorbookRecordCommand({
      title: 'Order lock contention unresolved',
      symptom: 'Order approve call times out under lock contention.',
      rootCause: 'Lock order conflict between approval and reservation.',
      fixAction: ['Tune lock timeout'],
      tags: 'order',
      ontology: 'entity,relation',
      status: 'candidate',
      json: true
    }, {
      projectPath: tempDir
    });

    await expect(runErrorbookRecordCommand({
      title: 'Order lock contention unresolved',
      symptom: 'Order approve call times out under lock contention.',
      rootCause: 'Lock order conflict between approval and reservation.',
      fixAction: ['Retry queue fallback'],
      tags: 'order',
      ontology: 'entity,relation',
      status: 'candidate',
      json: true
    }, {
      projectPath: tempDir
    })).rejects.toThrow('two failed fix rounds detected');

    const withDebugEvidence = await runErrorbookRecordCommand({
      title: 'Order lock contention unresolved',
      symptom: 'Order approve call times out under lock contention.',
      rootCause: 'Lock order conflict between approval and reservation.',
      fixAction: ['Apply lock graph rewrite'],
      verification: ['debug: captured lock wait graph and deadlock trace id=dl-001'],
      tags: 'order,debug-evidence',
      ontology: 'entity,relation,decision_policy',
      status: 'candidate',
      json: true
    }, {
      projectPath: tempDir
    });

    expect(withDebugEvidence.created).toBe(false);
    expect(withDebugEvidence.deduplicated).toBe(true);
    expect(withDebugEvidence.entry.occurrences).toBe(3);
    expect(withDebugEvidence.entry.tags).toEqual(expect.arrayContaining(['debug-evidence']));
    expect(withDebugEvidence.entry.verification_evidence.some((item) => item.startsWith('debug:'))).toBe(true);
  });

  test('promote gate rejects entries without verification evidence', async () => {
    const recorded = await runErrorbookRecordCommand({
      title: 'Payment callback signature mismatch',
      symptom: 'Callbacks failed signature verification after provider rotation.',
      rootCause: 'Gateway key rotation was not propagated to verifier config.',
      fixAction: ['Reload verifier config after key rotation'],
      tags: 'payment',
      ontology: 'business_rule',
      json: true
    }, {
      projectPath: tempDir
    });

    await expect(runErrorbookPromoteCommand({
      id: recorded.entry.id,
      json: true
    }, {
      projectPath: tempDir
    })).rejects.toThrow('verification_evidence');
  });

  test('record rejects temporary mitigation without governance metadata', async () => {
    await expect(runErrorbookRecordCommand({
      title: 'Temporary fallback without governance metadata',
      symptom: 'Fallback path was enabled to bypass transient failures.',
      rootCause: 'Primary root cause is identified but not yet removed from critical path.',
      fixAction: ['Restore primary path after root cause fix'],
      temporaryMitigation: true,
      json: true
    }, {
      projectPath: tempDir
    })).rejects.toThrow('--mitigation-exit');
  });

  test('promotes verified high-quality entry', async () => {
    const recorded = await runErrorbookRecordCommand({
      title: 'Order approval queue saturation',
      symptom: 'Order approval queue backlog exceeded SLA and delayed approvals.',
      rootCause: 'Queue workers were under-provisioned and retry policy amplified load.',
      fixAction: ['Increase worker pool from 4 to 8', 'Reduce retry burst window from 30s to 10s'],
      verification: ['npm run test -- order-approval', 'Load test confirms p95 below threshold'],
      tags: 'order,performance',
      ontology: 'entity,relation,decision',
      status: 'verified',
      json: true
    }, {
      projectPath: tempDir
    });

    const promoted = await runErrorbookPromoteCommand({
      id: recorded.entry.id,
      json: true
    }, {
      projectPath: tempDir
    });

    expect(promoted.mode).toBe('errorbook-promote');
    expect(promoted.promoted).toBe(true);
    expect(promoted.entry.status).toBe('promoted');
    expect(promoted.entry.promoted_at).toBeTruthy();
    expect(promoted.entry.quality_score).toBeGreaterThanOrEqual(75);
  });

  test('list supports status and quality filtering', async () => {
    const promotedCandidate = await runErrorbookRecordCommand({
      title: 'Catalog index drift',
      symptom: 'Search ranking drifted after index refresh job.',
      rootCause: 'Refresh job skipped synonym analyzer rebuild.',
      fixAction: ['Force synonym analyzer rebuild before re-index'],
      verification: ['Search relevance smoke test passed'],
      tags: 'catalog',
      ontology: 'entity,rule',
      status: 'verified',
      json: true
    }, {
      projectPath: tempDir
    });
    await runErrorbookPromoteCommand({
      id: promotedCandidate.entry.id,
      json: true
    }, {
      projectPath: tempDir
    });

    await runErrorbookRecordCommand({
      title: 'Minor docs typo',
      symptom: 'Command help text has typo in one flag description.',
      rootCause: 'Manual edit skipped spell-check.',
      fixAction: ['Correct typo'],
      tags: 'docs',
      status: 'candidate',
      json: true
    }, {
      projectPath: tempDir
    });

    const listed = await runErrorbookListCommand({
      status: 'promoted',
      minQuality: 75,
      json: true
    }, {
      projectPath: tempDir
    });

    expect(listed.mode).toBe('errorbook-list');
    expect(listed.total_results).toBe(1);
    expect(listed.entries[0].status).toBe('promoted');
    expect(listed.entries[0].quality_score).toBeGreaterThanOrEqual(75);
  });

  test('find ranks entries by match score and quality/status signals', async () => {
    const promoted = await runErrorbookRecordCommand({
      title: 'Approve order command timeout',
      symptom: 'Approve order command timed out with lock contention.',
      rootCause: 'Deadlock happened on order approval and inventory reservation.',
      fixAction: ['Reorder lock acquisition sequence'],
      verification: ['Order approval concurrency test passed'],
      tags: 'order',
      ontology: 'entity,relation,decision_policy',
      status: 'verified',
      json: true
    }, {
      projectPath: tempDir
    });
    await runErrorbookPromoteCommand({
      id: promoted.entry.id,
      json: true
    }, {
      projectPath: tempDir
    });

    await runErrorbookRecordCommand({
      title: 'Approve order button misalignment',
      symptom: 'Approve order button text shifted on small screen.',
      rootCause: 'CSS class override changed button padding.',
      fixAction: ['Restore button padding token'],
      tags: 'frontend',
      ontology: 'execution',
      status: 'candidate',
      json: true
    }, {
      projectPath: tempDir
    });

    const found = await runErrorbookFindCommand({
      query: 'approve order',
      limit: 2,
      json: true
    }, {
      projectPath: tempDir
    });

    expect(found.mode).toBe('errorbook-find');
    expect(found.total_results).toBe(2);
    expect(found.entries[0].status).toBe('promoted');
    expect(found.entries[0].match_score).toBeGreaterThan(found.entries[1].match_score);
  });

  test('exports promoted entries for external registry', async () => {
    const promoted = await runErrorbookRecordCommand({
      title: 'Exportable promoted entry',
      symptom: 'Approved order flow timeout under high concurrency.',
      rootCause: 'Lock ordering issue in approval + inventory transaction.',
      fixAction: ['Reorder lock acquisition'],
      verification: ['Concurrency regression suite passed'],
      tags: 'order',
      ontology: 'entity,relation,decision_policy',
      status: 'verified',
      json: true
    }, {
      projectPath: tempDir
    });
    await runErrorbookPromoteCommand({
      id: promoted.entry.id,
      json: true
    }, {
      projectPath: tempDir
    });

    await runErrorbookRecordCommand({
      title: 'Candidate only entry',
      symptom: 'Low priority docs mismatch sample.',
      rootCause: 'Draft documentation not updated.',
      fixAction: ['Update docs'],
      tags: 'docs',
      ontology: 'execution_flow',
      status: 'candidate',
      json: true
    }, {
      projectPath: tempDir
    });

    const outPath = path.join(tempDir, '.sce', 'errorbook', 'exports', 'registry.json');
    const result = await runErrorbookExportCommand({
      out: outPath,
      status: 'promoted',
      minQuality: 75,
      json: true
    }, {
      projectPath: tempDir
    });

    expect(result.mode).toBe('errorbook-export');
    expect(result.total_entries).toBe(1);
    const payload = await fs.readJson(outPath);
    expect(payload.api_version).toBe('sce.errorbook.registry/v0.1');
    expect(payload.total_entries).toBe(1);
    expect(payload.entries[0].status).toBe('promoted');
  });

  test('syncs external registry from local json source', async () => {
    const sourcePath = path.join(tempDir, 'registry-source.json');
    await fs.writeJson(sourcePath, {
      api_version: 'sce.errorbook.registry/v0.1',
      entries: [{
        id: 'rg-001',
        title: 'Registry sample entry',
        symptom: 'Order approve fails with stale lock.',
        root_cause: 'Transaction lock wait timeout too low.',
        fix_actions: ['Increase lock timeout'],
        verification_evidence: ['Lock test passed'],
        tags: ['order'],
        ontology_tags: ['entity', 'decision_policy'],
        status: 'promoted',
        quality_score: 90,
        updated_at: '2026-02-27T00:00:00Z'
      }]
    }, { spaces: 2 });

    const cachePath = path.join(tempDir, '.sce', 'errorbook', 'registry-cache.json');
    const result = await runErrorbookSyncRegistryCommand({
      source: sourcePath,
      sourceName: 'central-registry',
      cache: cachePath,
      json: true
    }, {
      projectPath: tempDir
    });

    expect(result.mode).toBe('errorbook-sync-registry');
    expect(result.total_entries).toBe(1);
    const cachePayload = await fs.readJson(cachePath);
    expect(cachePayload.api_version).toBe('sce.errorbook.registry-cache/v0.1');
    expect(cachePayload.total_entries).toBe(1);
    expect(cachePayload.entries[0].entry_source).toBe('registry');
  });

  test('find supports include-registry with cached external entries', async () => {
    const cachePath = path.join(tempDir, DEFAULT_ERRORBOOK_REGISTRY_CACHE);
    await fs.ensureDir(path.dirname(cachePath));
    await fs.writeJson(cachePath, {
      api_version: 'sce.errorbook.registry-cache/v0.1',
      synced_at: new Date().toISOString(),
      source: {
        name: 'central',
        uri: 'local-fixture'
      },
      entries: [{
        id: 'reg-approve-1',
        fingerprint: 'fp-reg-approve-1',
        title: 'Registry approve order timeout',
        symptom: 'Approve order request timed out under lock contention.',
        root_cause: 'Approval lock sequence caused deadlock.',
        fix_actions: ['Reorder lock sequence'],
        verification_evidence: ['Approve lock test passed'],
        tags: ['order'],
        ontology_tags: ['entity', 'decision_policy'],
        status: 'promoted',
        quality_score: 92,
        updated_at: '2026-02-27T00:00:00Z'
      }]
    }, { spaces: 2 });

    const result = await runErrorbookFindCommand({
      query: 'approve order timeout',
      includeRegistry: true,
      registryCache: cachePath,
      json: true
    }, {
      projectPath: tempDir
    });

    expect(result.include_registry).toBe(true);
    expect(result.total_results).toBeGreaterThanOrEqual(1);
    expect(result.source_breakdown.registry_results).toBeGreaterThanOrEqual(1);
    expect(result.entries.some((item) => item.entry_source === 'registry-cache')).toBe(true);
  });

  test('health-registry validates local source and index successfully', async () => {
    const shardPath = path.join(tempDir, 'registry', 'shards', 'order.json');
    const sourcePath = path.join(tempDir, 'registry', 'errorbook-registry.json');
    const indexPath = path.join(tempDir, 'registry', 'errorbook-registry.index.json');
    const configPath = path.join(tempDir, '.sce', 'config', 'errorbook-registry.json');

    await fs.ensureDir(path.dirname(shardPath));
    await fs.ensureDir(path.dirname(configPath));

    await fs.writeJson(shardPath, {
      api_version: 'sce.errorbook.registry/v0.1',
      entries: [{
        id: 'reg-health-1',
        fingerprint: 'fp-reg-health-1',
        title: 'Health check fixture entry',
        symptom: 'Order approve timeout due to lock contention.',
        root_cause: 'Approval transaction lock ordering issue.',
        fix_actions: ['Reorder lock sequence'],
        verification_evidence: ['lock regression suite passed'],
        tags: ['order'],
        ontology_tags: ['entity', 'decision_policy'],
        status: 'promoted',
        quality_score: 95,
        updated_at: '2026-02-27T00:00:00Z'
      }]
    }, { spaces: 2 });

    await fs.writeJson(sourcePath, {
      api_version: 'sce.errorbook.registry/v0.1',
      entries: [{
        id: 'reg-health-summary-1',
        fingerprint: 'fp-reg-health-summary-1',
        title: 'Registry summary fixture',
        symptom: 'Summary entry for registry source validation.',
        root_cause: 'Fixture payload for health check command.',
        fix_actions: ['Use deterministic fixture'],
        verification_evidence: ['unit test fixture validated'],
        tags: ['fixture'],
        ontology_tags: ['execution_flow'],
        status: 'promoted',
        quality_score: 90,
        updated_at: '2026-02-27T00:00:00Z'
      }]
    }, { spaces: 2 });

    await fs.writeJson(indexPath, {
      api_version: 'sce.errorbook.registry-index/v0.1',
      min_token_length: 2,
      token_to_bucket: {
        order: 'order',
        approve: 'order'
      },
      buckets: {
        order: shardPath
      }
    }, { spaces: 2 });

    await fs.writeJson(configPath, {
      enabled: true,
      search_mode: 'remote',
      cache_file: '.sce/errorbook/registry-cache.json',
      sources: [{
        name: 'central-fixture',
        enabled: true,
        url: sourcePath,
        index_url: indexPath
      }]
    }, { spaces: 2 });

    const result = await runErrorbookRegistryHealthCommand({
      config: configPath,
      maxShards: 4,
      shardSample: 2,
      json: true
    }, {
      projectPath: tempDir
    });

    expect(result.mode).toBe('errorbook-health-registry');
    expect(result.passed).toBe(true);
    expect(result.error_count).toBe(0);
    expect(result.config.source_count).toBe(1);
    expect(result.sources[0].source_ok).toBe(true);
    expect(result.sources[0].index_ok).toBe(true);
    expect(result.sources[0].source_entries).toBeGreaterThan(0);
  });

  test('health-registry reports failure for broken source path', async () => {
    const configPath = path.join(tempDir, '.sce', 'config', 'errorbook-registry.json');
    await fs.ensureDir(path.dirname(configPath));
    await fs.writeJson(configPath, {
      enabled: true,
      search_mode: 'remote',
      sources: [{
        name: 'broken-source',
        enabled: true,
        url: path.join(tempDir, 'registry', 'missing.json')
      }]
    }, { spaces: 2 });

    const result = await runErrorbookRegistryHealthCommand({
      config: configPath,
      json: true
    }, {
      projectPath: tempDir
    });

    expect(result.mode).toBe('errorbook-health-registry');
    expect(result.passed).toBe(false);
    expect(result.error_count).toBeGreaterThan(0);
    expect(result.errors.some((item) => item.includes('failed to load source'))).toBe(true);
  });

  test('find supports remote indexed registry search without local full sync', async () => {
    const shardPath = path.join(tempDir, 'registry', 'shards', 'order.json');
    const indexPath = path.join(tempDir, 'registry', 'errorbook-registry.index.json');
    await fs.ensureDir(path.dirname(shardPath));
    await fs.writeJson(shardPath, {
      api_version: 'sce.errorbook.registry/v0.1',
      entries: [{
        id: 'reg-remote-1',
        fingerprint: 'fp-reg-remote-1',
        title: 'Remote approve order lock timeout',
        symptom: 'Approve order API timed out under concurrent lock contention.',
        root_cause: 'Lock sequence deadlock in approval transaction.',
        fix_actions: ['Reorder lock sequence'],
        verification_evidence: ['approve-order-lock test passed'],
        tags: ['order'],
        ontology_tags: ['entity', 'decision_policy'],
        status: 'promoted',
        quality_score: 95,
        updated_at: '2026-02-27T00:00:00Z'
      }]
    }, { spaces: 2 });
    await fs.writeJson(indexPath, {
      api_version: 'sce.errorbook.registry-index/v0.1',
      min_token_length: 2,
      token_to_bucket: {
        approve: 'order',
        order: 'order'
      },
      buckets: {
        order: shardPath
      }
    }, { spaces: 2 });

    const result = await runErrorbookFindCommand({
      query: 'approve order timeout',
      includeRegistry: true,
      registryMode: 'remote',
      registrySource: path.join(tempDir, 'registry', 'errorbook-registry.json'),
      registryIndex: indexPath,
      json: true
    }, {
      projectPath: tempDir
    });

    expect(result.include_registry).toBe(true);
    expect(result.source_breakdown.registry_remote_results).toBeGreaterThanOrEqual(1);
    expect(result.source_breakdown.registry_cache_results).toBe(0);
    expect(result.entries.some((item) => item.entry_source === 'registry-remote')).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test('show supports id prefix resolution', async () => {
    const recorded = await runErrorbookRecordCommand({
      title: 'Shipment webhook duplicate delivery',
      symptom: 'Webhook event processed twice and duplicated shipment updates.',
      rootCause: 'Consumer lacked deduplication key check.',
      fixAction: ['Add idempotency key guard'],
      verification: ['Webhook replay test passed'],
      tags: 'shipping',
      ontology: 'execution_flow',
      status: 'verified',
      json: true
    }, {
      projectPath: tempDir
    });

    const prefix = recorded.entry.id.slice(0, 10);
    const shown = await runErrorbookShowCommand({
      id: prefix,
      json: true
    }, {
      projectPath: tempDir
    });

    expect(shown.mode).toBe('errorbook-show');
    expect(shown.entry.id).toBe(recorded.entry.id);
    expect(shown.entry.title).toBe('Shipment webhook duplicate delivery');
  });

  test('deprecate marks entry as deprecated with reason', async () => {
    const recorded = await runErrorbookRecordCommand({
      title: 'Legacy cache flush mismatch',
      symptom: 'Cache flush endpoint no longer aligns with new routing policy.',
      rootCause: 'Legacy endpoint path kept old prefix after router refactor.',
      fixAction: ['Use new endpoint route and remove legacy alias'],
      verification: ['Endpoint contract tests passed'],
      tags: 'cache',
      ontology: 'execution_flow',
      status: 'verified',
      json: true
    }, {
      projectPath: tempDir
    });

    const deprecated = await runErrorbookDeprecateCommand({
      id: recorded.entry.id,
      reason: 'Superseded by scene-runtime routing baseline',
      json: true
    }, {
      projectPath: tempDir
    });

    expect(deprecated.mode).toBe('errorbook-deprecate');
    expect(deprecated.deprecated).toBe(true);
    expect(deprecated.entry.status).toBe('deprecated');
    expect(deprecated.entry.deprecation.reason).toContain('Superseded');
  });

  test('requalify restores deprecated entry to verified when evidence exists', async () => {
    const recorded = await runErrorbookRecordCommand({
      title: 'Order reindex stale cursor',
      symptom: 'Reindex skipped latest order updates under concurrent writes.',
      rootCause: 'Cursor snapshot mode was stale under lock retries.',
      fixAction: ['Switch to monotonic cursor checkpoint'],
      verification: ['Reindex replay test passed'],
      tags: 'order,index',
      ontology: 'entity,relation',
      status: 'verified',
      json: true
    }, {
      projectPath: tempDir
    });

    await runErrorbookDeprecateCommand({
      id: recorded.entry.id,
      reason: 'Temporarily deprecated for policy rewrite',
      json: true
    }, {
      projectPath: tempDir
    });

    const requalified = await runErrorbookRequalifyCommand({
      id: recorded.entry.id,
      status: 'verified',
      json: true
    }, {
      projectPath: tempDir
    });

    expect(requalified.mode).toBe('errorbook-requalify');
    expect(requalified.requalified).toBe(true);
    expect(requalified.entry.status).toBe('verified');
    expect(requalified.entry.deprecation).toBeUndefined();
  });

  test('requalify rejects invalid status transitions', async () => {
    const recorded = await runErrorbookRecordCommand({
      title: 'Temp fixture quality sample',
      symptom: 'Fixture sample for transition validation.',
      rootCause: 'Test transition guard coverage.',
      fixAction: ['Guard transition in command'],
      verification: ['unit test'],
      tags: 'test',
      ontology: 'entity',
      status: 'verified',
      json: true
    }, {
      projectPath: tempDir
    });

    await expect(runErrorbookRequalifyCommand({
      id: recorded.entry.id,
      status: 'promoted',
      json: true
    }, {
      projectPath: tempDir
    })).rejects.toThrow('does not accept status=promoted');
  });

  test('release gate blocks unresolved high-risk candidate entries', async () => {
    await runErrorbookRecordCommand({
      title: 'Critical release gate failure',
      symptom: 'Required release preflight step failed during deployment pipeline.',
      rootCause: 'Pending root-cause analysis for release blocker.',
      fixAction: ['Investigate failing release preflight command'],
      tags: 'release-blocker,security',
      ontology: 'execution_flow,decision_policy',
      status: 'candidate',
      json: true
    }, {
      projectPath: tempDir
    });

    const gate = await runErrorbookReleaseGateCommand({
      minRisk: 'high',
      json: true
    }, {
      projectPath: tempDir
    });

    expect(gate.mode).toBe('errorbook-release-gate');
    expect(gate.passed).toBe(false);
    expect(gate.blocked_count).toBe(1);
    expect(gate.blocked_entries[0].risk).toBe('high');

    await expect(runErrorbookReleaseGateCommand({
      minRisk: 'high',
      failOnBlock: true,
      json: true
    }, {
      projectPath: tempDir
    })).rejects.toThrow('release gate blocked');
  });

  test('release gate passes after candidate is deprecated', async () => {
    const recorded = await runErrorbookRecordCommand({
      title: 'Legacy blocker sample',
      symptom: 'Legacy release gate blocker sample for deprecate path.',
      rootCause: 'Known obsolete blocker sample.',
      fixAction: ['Mark as deprecated'],
      tags: 'release-blocker',
      ontology: 'execution_flow',
      status: 'candidate',
      json: true
    }, {
      projectPath: tempDir
    });

    await runErrorbookDeprecateCommand({
      id: recorded.entry.id,
      reason: 'obsolete sample',
      json: true
    }, {
      projectPath: tempDir
    });

    const gate = await runErrorbookReleaseGateCommand({
      minRisk: 'high',
      failOnBlock: true,
      json: true
    }, {
      projectPath: tempDir
    });

    expect(gate.passed).toBe(true);
    expect(gate.blocked_count).toBe(0);
  });

  test('release gate blocks expired temporary mitigation policy violations', async () => {
    await runErrorbookRecordCommand({
      title: 'Expired temporary fallback for order approval',
      symptom: 'Temporary fallback route remains active in order approval path.',
      rootCause: 'Primary approval lock sequencing fix was delayed.',
      fixAction: ['Ship lock sequencing patch and remove fallback route'],
      tags: 'order',
      ontology: 'decision_policy,execution_flow',
      status: 'candidate',
      temporaryMitigation: true,
      mitigationReason: 'Emergency stop-bleeding fallback',
      mitigationExit: 'Primary lock sequencing patch is deployed and verified',
      mitigationCleanup: 'spec/cleanup-order-approval-fallback',
      mitigationDeadline: '2020-01-01T00:00:00Z',
      json: true
    }, {
      projectPath: tempDir
    });

    const gate = await runErrorbookReleaseGateCommand({
      minRisk: 'high',
      json: true
    }, {
      projectPath: tempDir
    });

    expect(gate.passed).toBe(false);
    expect(gate.mitigation_blocked_count).toBe(1);
    expect(gate.blocked_entries[0].policy_violations).toEqual(
      expect.arrayContaining(['temporary_mitigation.deadline_at:expired'])
    );
  });

  test('release gate allows active temporary mitigation with valid governance metadata', async () => {
    const futureDeadline = new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)).toISOString();
    await runErrorbookRecordCommand({
      title: 'Bounded temporary mitigation for low-risk docs command',
      symptom: 'Temporary fallback branch keeps docs command alive during refactor.',
      rootCause: 'Refactor split requires phased migration before deleting fallback path.',
      fixAction: ['Complete refactor and remove fallback branch'],
      tags: 'docs',
      ontology: 'execution_flow',
      status: 'candidate',
      temporaryMitigation: true,
      mitigationReason: 'Short-lived migration safeguard',
      mitigationExit: 'Refactor migration tests pass on new path',
      mitigationCleanup: 'spec/cleanup-docs-fallback',
      mitigationDeadline: futureDeadline,
      json: true
    }, {
      projectPath: tempDir
    });

    const gate = await runErrorbookReleaseGateCommand({
      minRisk: 'high',
      json: true
    }, {
      projectPath: tempDir
    });

    expect(gate.passed).toBe(true);
    expect(gate.mitigation_blocked_count).toBe(0);
  });

  test('promote resolves active temporary mitigation metadata', async () => {
    const futureDeadline = new Date(Date.now() + (14 * 24 * 60 * 60 * 1000)).toISOString();
    const recorded = await runErrorbookRecordCommand({
      title: 'Approval fallback cleanup promotion sample',
      symptom: 'Approval fallback path was used during incident handling.',
      rootCause: 'Approval lock contention on primary path.',
      fixAction: ['Fix lock ordering', 'Delete fallback path'],
      verification: ['Approval lock regression suite passed'],
      tags: 'order,release-blocker',
      ontology: 'entity,decision_policy,execution_flow',
      status: 'verified',
      temporaryMitigation: true,
      mitigationReason: 'Incident containment fallback',
      mitigationExit: 'Primary path validated under concurrency test',
      mitigationCleanup: 'spec/remove-approval-fallback',
      mitigationDeadline: futureDeadline,
      json: true
    }, {
      projectPath: tempDir
    });

    const promoted = await runErrorbookPromoteCommand({
      id: recorded.entry.id,
      json: true
    }, {
      projectPath: tempDir
    });

    expect(promoted.entry.status).toBe('promoted');
    expect(promoted.entry.temporary_mitigation.enabled).toBe(true);
    expect(promoted.entry.temporary_mitigation.resolved_at).toBeTruthy();
  });

  test('normalizes ontology aliases into canonical tags', () => {
    const normalized = normalizeOntologyTags('entities,rules,decision,workflow,foo');
    expect(normalized).toEqual(['entity', 'business_rule', 'decision_policy', 'execution_flow']);
  });
});
