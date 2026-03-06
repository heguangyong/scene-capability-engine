const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const {
  runCapabilityExtractCommand,
  runCapabilityScoreCommand,
  runCapabilityMapCommand,
  runCapabilityRegisterCommand,
  runCapabilityInventoryCommand,
  enrichCapabilityTemplateForUi,
  filterCapabilityCatalogEntries,
  sortCapabilityInventoryEntries,
  buildCapabilityInventorySummaryStats
} = require('../../../lib/commands/capability');

describe('capability commands', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-capability-'));
    await fs.ensureDir(path.join(tempDir, '.sce', 'spec-governance'));
    await fs.ensureDir(path.join(tempDir, '.sce', 'specs', '01-00-demo'));
    await fs.ensureDir(path.join(tempDir, '.sce', 'specs', '02-00-partial'));

    await fs.writeJson(path.join(tempDir, '.sce', 'spec-governance', 'scene-index.json'), {
      schema_version: '1.0',
      generated_at: new Date().toISOString(),
      scene_filter: null,
      scenes: {
        'scene.demo': {
          total_specs: 1,
          active_specs: 1,
          completed_specs: 0,
          stale_specs: 0,
          spec_ids: ['01-00-demo'],
          active_spec_ids: ['01-00-demo'],
          stale_spec_ids: []
        },
        'scene.partial': {
          total_specs: 1,
          active_specs: 1,
          completed_specs: 0,
          stale_specs: 0,
          spec_ids: ['02-00-partial'],
          active_spec_ids: ['02-00-partial'],
          stale_spec_ids: []
        },
        'scene.demo': {
          total_specs: 1,
          active_specs: 1,
          completed_specs: 0,
          stale_specs: 0,
          spec_ids: ['01-00-demo'],
          active_spec_ids: ['01-00-demo'],
          stale_spec_ids: []
        }
      }
    }, { spaces: 2 });

    await fs.writeFile(
      path.join(tempDir, '.sce', 'specs', '01-00-demo', 'tasks.md'),
      [
        '- [x] 1. Prepare baseline',
        '- [ ] 2. Implement feature',
        '- [-] 3. Validate release'
      ].join('\n'),
      'utf8'
    );

    await fs.ensureDir(path.join(tempDir, '.sce', 'specs', '01-00-demo', 'custom'));
    await fs.writeJson(path.join(tempDir, '.sce', 'specs', '01-00-demo', 'custom', 'problem-domain-chain.json'), {
      api_version: 'sce.problem-domain-chain/v0.1',
      scene_id: 'scene.demo',
      spec_id: '01-00-demo',
      ontology: {
        entity: ['Order'],
        relation: ['Order->Customer'],
        business_rule: ['OrderApproval'],
        decision_policy: ['RiskPolicy']
      }
    }, { spaces: 2 });

    await fs.writeFile(
      path.join(tempDir, '.sce', 'specs', '02-00-partial', 'tasks.md'),
      [
        '- [ ] 1. Draft incomplete flow'
      ].join('\n'),
      'utf8'
    );

    await fs.ensureDir(path.join(tempDir, '.sce', 'specs', '02-00-partial', 'custom'));
    await fs.writeJson(path.join(tempDir, '.sce', 'specs', '02-00-partial', 'custom', 'problem-domain-chain.json'), {
      api_version: 'sce.problem-domain-chain/v0.1',
      scene_id: 'scene.partial',
      spec_id: '02-00-partial',
      ontology: {
        entity: ['DraftOrder'],
        relation: ['DraftOrder->Customer'],
        business_rule: [],
        decision_policy: []
      }
    }, { spaces: 2 });
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  test('extracts capability candidate from scene', async () => {
    const result = await runCapabilityExtractCommand({
      scene: 'scene.demo',
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs
    });

    expect(result.mode).toBe('capability-extract');
    expect(result.scene_id).toBe('scene.demo');
    expect(result.summary).toEqual(expect.objectContaining({
      spec_count: 1,
      task_total: 3,
      task_completed: 1,
      ontology_triads_ready: true
    }));
    expect(result.ontology_scope).toEqual(expect.objectContaining({
      entities: ['Order'],
      relations: ['Order->Customer'],
      business_rules: ['OrderApproval'],
      decisions: ['RiskPolicy']
    }));
  });

  test('scores, maps, and registers capability template', async () => {
    const candidate = await runCapabilityExtractCommand({
      scene: 'scene.demo',
      json: true,
      out: '.sce/reports/capability-iteration/scene.demo.candidate.json'
    }, {
      projectPath: tempDir,
      fileSystem: fs
    });

    const score = await runCapabilityScoreCommand({
      input: candidate.output_file,
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs
    });
    expect(score.mode).toBe('capability-score');
    expect(score.scores).toEqual(expect.objectContaining({
      value_score: expect.any(Number),
      ontology_core_score: 100
    }));
    expect(score.scores.ontology_core.ready).toBe(true);

    await fs.ensureDir(path.join(tempDir, '.sce', 'ontology'));
    await fs.writeJson(path.join(tempDir, '.sce', 'ontology', 'mapping.json'), {
      ontology_scope: {
        domains: ['commerce'],
        entities: ['Order'],
        relations: ['Order->Customer'],
        business_rules: ['OrderApproval'],
        decisions: ['RiskPolicy']
      }
    }, { spaces: 2 });

    const mapped = await runCapabilityMapCommand({
      input: candidate.output_file,
      mapping: '.sce/ontology/mapping.json',
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs
    });
    expect(mapped.mode).toBe('capability-map');
    expect(mapped.template.ontology_scope.entities).toContain('Order');
    expect(mapped.release_readiness.ready).toBe(true);

    const registered = await runCapabilityRegisterCommand({
      input: mapped.output_file,
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs
    });
    expect(registered.mode).toBe('capability-register');
    expect(registered.ontology_core.ready).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, registered.files[0]))).toBe(true);
  });

  test('exposes publish readiness UI state for capability templates', () => {
    const readyTemplate = enrichCapabilityTemplateForUi({
      id: 'ready-template',
      ontology_scope: {
        entities: ['Order'],
        relations: ['Order->Customer'],
        business_rules: ['OrderApproval'],
        decisions: ['RiskPolicy']
      }
    });
    expect(readyTemplate.release_readiness_ui).toEqual(expect.objectContaining({
      publish_ready: true,
      blocking_count: 0
    }));

    const blockedTemplate = enrichCapabilityTemplateForUi({
      id: 'blocked-template',
      ontology_scope: {
        entities: ['Order'],
        relations: ['Order->Customer'],
        business_rules: [],
        decisions: []
      }
    });
    expect(blockedTemplate.release_readiness_ui).toEqual(expect.objectContaining({
      publish_ready: false,
      blocking_count: 1,
      blocking_ids: expect.arrayContaining(['ontology-core-triads']),
      blocking_missing: expect.arrayContaining(['business_rules', 'decision_strategy'])
    }));
  });

  test('builds scene-level capability inventory with triad readiness', async () => {
    const inventory = await runCapabilityInventoryCommand({ json: true }, {
      projectPath: tempDir,
      fileSystem: fs
    });
    expect(inventory.mode).toBe('capability-inventory');
    expect(inventory.scene_total).toBe(2);
    expect(inventory.scene_count).toBe(2);
    expect(inventory.summary_stats).toEqual({
      publish_ready_count: 1,
      blocked_count: 1,
      missing_triads: {
        decision_strategy: 1,
        business_rules: 1,
        entity_relation: 0
      }
    });
    expect(inventory.query).toEqual(expect.objectContaining({
      protocol_version: '1.0',
      scene_id: null,
      limit: 2,
      sample_limit: 5,
      filters: { release_ready: null, missing_triad: null }
    }));
    expect(inventory.sort).toEqual(expect.objectContaining({
      strategy: 'publish_ready -> missing_triad_priority -> value_score_desc -> scene_id'
    }));
    expect(inventory.scenes.map((item) => item.scene_id)).toEqual(['scene.partial', 'scene.demo']);
    expect(inventory.scenes.find((item) => item.scene_id === 'scene.demo')).toEqual(expect.objectContaining({
      ontology_core_ui: expect.objectContaining({ ready: true }),
      release_readiness_ui: expect.objectContaining({ publish_ready: true })
    }));
    expect(inventory.scenes.find((item) => item.scene_id === 'scene.partial')).toEqual(expect.objectContaining({
      ontology_core_ui: expect.objectContaining({ ready: false }),
      release_readiness_ui: expect.objectContaining({ publish_ready: false })
    }));
  });

  test('summarizes capability inventory stats', () => {
    const summary = buildCapabilityInventorySummaryStats([
      { release_readiness_ui: { publish_ready: true, blocking_missing: [] } },
      { release_readiness_ui: { publish_ready: false, blocking_missing: ['decision_strategy', 'business_rules'] } },
      { release_readiness_ui: { publish_ready: false, blocking_missing: ['entity_relation'] } }
    ]);
    expect(summary).toEqual({
      publish_ready_count: 1,
      blocked_count: 2,
      missing_triads: {
        decision_strategy: 1,
        business_rules: 1,
        entity_relation: 1
      }
    });
  });

  test('sorts capability inventory entries by readiness, triad priority, and value score', () => {
    const sorted = sortCapabilityInventoryEntries([
      { scene_id: 'scene.ready-low', release_readiness_ui: { publish_ready: true, blocking_missing: [] }, score_preview: { value_score: 10 } },
      { scene_id: 'scene.blocked-business', release_readiness_ui: { publish_ready: false, blocking_missing: ['business_rules'] }, score_preview: { value_score: 90 } },
      { scene_id: 'scene.blocked-decision', release_readiness_ui: { publish_ready: false, blocking_missing: ['decision_strategy'] }, score_preview: { value_score: 20 } }
    ]);
    expect(sorted.map((item) => item.scene_id)).toEqual(['scene.blocked-decision', 'scene.blocked-business', 'scene.ready-low']);
  });

  test('filters capability inventory entries by publish readiness and missing triad', async () => {
    const inventory = await runCapabilityInventoryCommand({
      releaseReady: 'false',
      missingTriad: 'decision_strategy',
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs
    });
    expect(inventory.query.filters).toEqual({ release_ready: false, missing_triad: 'decision_strategy' });
    expect(inventory.scenes.map((item) => item.scene_id)).toEqual(['scene.partial']);
  });

  test('filters capability catalog entries by publish readiness and missing triad', () => {
    const templates = [
      enrichCapabilityTemplateForUi({
        id: 'ready-template',
        ontology_scope: {
          entities: ['Order'],
          relations: ['Order->Customer'],
          business_rules: ['OrderApproval'],
          decisions: ['RiskPolicy']
        }
      }),
      enrichCapabilityTemplateForUi({
        id: 'missing-decision',
        ontology_scope: {
          entities: ['Order'],
          relations: ['Order->Customer'],
          business_rules: ['OrderApproval'],
          decisions: []
        }
      })
    ];

    expect(filterCapabilityCatalogEntries(templates, { releaseReady: 'true' }).map((item) => item.id)).toEqual(['ready-template']);
    expect(filterCapabilityCatalogEntries(templates, { missingTriad: 'decision_strategy' }).map((item) => item.id)).toEqual(['missing-decision']);
  });

  test('blocks register when ontology triads are incomplete', async () => {
    const incompletePath = path.join(tempDir, '.sce', 'reports', 'capability-iteration', 'incomplete.template.json');
    await fs.ensureDir(path.dirname(incompletePath));
    await fs.writeJson(incompletePath, {
      template: {
        template_id: 'incomplete-demo',
        name: 'Incomplete Demo',
        description: 'Missing decision strategy',
        category: 'capability',
        scene_id: 'scene.demo',
        ontology_scope: {
          entities: ['Order'],
          relations: ['Order->Customer'],
          business_rules: ['OrderApproval'],
          decisions: []
        }
      }
    }, { spaces: 2 });

    await expect(runCapabilityRegisterCommand({
      input: '.sce/reports/capability-iteration/incomplete.template.json',
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs
    })).rejects.toMatchObject({
      code: 'CAPABILITY_REGISTER_BLOCKED',
      details: {
        release_readiness: expect.objectContaining({
          ready: false,
          blockers: expect.arrayContaining([
            expect.objectContaining({
              id: 'ontology-core-triads',
              severity: 'blocking',
              missing: expect.arrayContaining(['decision_strategy'])
            })
          ])
        })
      }
    });
  });
});
