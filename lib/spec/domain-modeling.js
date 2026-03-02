const fs = require('fs-extra');
const path = require('path');

const DOMAIN_MAP_RELATIVE_PATH = path.join('custom', 'problem-domain-map.md');
const SCENE_SPEC_RELATIVE_PATH = path.join('custom', 'scene-spec.md');
const DOMAIN_CHAIN_RELATIVE_PATH = path.join('custom', 'problem-domain-chain.json');
const PROBLEM_CONTRACT_RELATIVE_PATH = path.join('custom', 'problem-contract.json');
const DOMAIN_CHAIN_API_VERSION = 'sce.problem-domain-chain/v0.1';
const DOMAIN_RESEARCH_DIMENSIONS = Object.freeze([
  'scene_boundary',
  'entity',
  'relation',
  'business_rule',
  'decision_policy',
  'execution_flow',
  'failure_signal',
  'debug_evidence_plan',
  'verification_gate'
]);

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function resolveSpecPaths(projectPath, specId) {
  const specPath = path.join(projectPath, '.sce', 'specs', specId);
  return {
    specPath,
    domainMapPath: path.join(specPath, DOMAIN_MAP_RELATIVE_PATH),
    sceneSpecPath: path.join(specPath, SCENE_SPEC_RELATIVE_PATH),
    domainChainPath: path.join(specPath, DOMAIN_CHAIN_RELATIVE_PATH),
    problemContractPath: path.join(specPath, PROBLEM_CONTRACT_RELATIVE_PATH)
  };
}

function buildProblemContract(specId, options = {}) {
  const sceneId = normalizeText(options.sceneId) || `scene.${specId.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`;
  const problemStatement = normalizeText(options.problemStatement) || 'TBD: describe the primary business problem';
  const verificationPlan = normalizeText(options.verificationPlan) || 'TBD: define validation and rollback criteria';
  return {
    schema_version: '1.0',
    spec_id: specId,
    scene_id: sceneId,
    issue_statement: problemStatement,
    expected_outcome: verificationPlan,
    reproduction_steps: [
      'Reproduce the issue along the failing scene path.',
      'Capture gate/test/runtime evidence for failed behavior.'
    ],
    impact_scope: `scene=${sceneId}`,
    forbidden_workarounds: [
      'Do not bypass mandatory gates or tests.',
      'Do not silence runtime errors without root-cause remediation.'
    ]
  };
}

function buildProblemDomainMindMap(specId, options = {}) {
  const sceneId = normalizeText(options.sceneId) || `scene.${specId.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`;
  const problemStatement = normalizeText(options.problemStatement) || 'TBD: describe the primary business problem';
  const primaryFlow = normalizeText(options.primaryFlow) || 'TBD: define core user/business flow';
  const verificationPlan = normalizeText(options.verificationPlan) || 'TBD: define validation and rollback criteria';

  return `# Problem Domain Mind Map

> Mandatory artifact: use this map to expand the problem domain before implementation.
> Policy: after two failed fix rounds, diagnostics must be added before the next patch round.

## Root Problem

- Scene: \`${sceneId}\`
- Spec: \`${specId}\`
- Problem Statement: ${problemStatement}
- Primary Flow: ${primaryFlow}

## Domain Mind Map

\`\`\`mermaid
mindmap
  root((${specId}))
    Problem
      Symptom
      Root Cause Hypothesis
      Constraints
    Ontology
      Entity
      Relation
      Business Rule
      Decision Policy
      Execution Flow
    Stakeholders
      User
      Operator
      Maintainer
    Risk
      Wrong Direction
      Data Integrity
      Security
      Rollback
    Validation
      Test Evidence
      Runtime Signal
      Gate Criteria
\`\`\`

## Layered Exploration Chain

1. Clarify symptom scope and affected boundaries.
2. Enumerate entities, relations, and rule constraints.
3. Identify decision points and execution paths.
4. Produce candidate fixes and risk tradeoffs.
5. Define verification path and measurable acceptance.

## Closed-Loop Research Coverage Matrix

| Dimension | Coverage Goal | Status |
| --- | --- | --- |
| Scene Boundary | Entry, scope, excluded boundaries are explicit | [ ] |
| Entity | Key entities are listed and scoped | [ ] |
| Relation | Entity relations and direction are explicit | [ ] |
| Business Rule | Enforceable rules are mapped | [ ] |
| Decision Policy | Decision branches and conditions are explicit | [ ] |
| Execution Flow | End-to-end action chain is explicit | [ ] |
| Failure Signal | Wrong-direction signals are listed | [ ] |
| Debug Evidence Plan | Debug-log/diagnostic evidence path is defined | [ ] |
| Verification Gate | Acceptance and gate criteria are explicit | [ ] |

## Correction Loop

- Expected Wrong-Direction Signals:
  - requirement drift
  - ontology mismatch
  - repeated failed remediation
- Correction Actions:
  - update this map
  - add debug evidence
  - adjust scene-spec contract before coding

## Verification Plan

- ${verificationPlan}
`;
}

function buildSceneSpec(specId, options = {}) {
  const sceneId = normalizeText(options.sceneId) || `scene.${specId.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`;
  const problemStatement = normalizeText(options.problemStatement) || 'TBD';
  const primaryFlow = normalizeText(options.primaryFlow) || 'TBD';
  const verificationPlan = normalizeText(options.verificationPlan) || 'TBD';

  return `# Scene Spec

> Mandatory artifact: scene-oriented contract for implementation and gating.

## Scene Definition

- Scene ID: \`${sceneId}\`
- Spec ID: \`${specId}\`
- Objective: ${problemStatement}
- Primary Flow: ${primaryFlow}

## Scope & Boundaries

- In Scope:
  - core scene behavior
  - required integrations
- Out of Scope:
  - unrelated legacy refactors
  - uncontrolled workaround paths

## Ontology Coverage

| Layer | Required Mapping |
| --- | --- |
| Entity | list key domain entities |
| Relation | list key relations |
| Business Rule | list enforceable rules |
| Decision Policy | list decision points |
| Execution Flow | list end-to-end action chain |

## Decision & Execution Path

1. Trigger condition and entry point.
2. Decision policy branch(es).
3. Service/tool execution sequence.
4. Expected outputs and side effects.
5. Failure path and rollback criteria.

## Closed-Loop Research Contract

- This Scene Spec is invalid if the domain mind map coverage matrix is missing.
- Decision and execution statements must map to ontology fields in \`problem-domain-chain.json\`.
- If two remediation rounds fail, debug evidence and diagnostic logs are mandatory before another patch round.

## Acceptance & Gate

- Functional acceptance: define testable behaviors.
- Technical acceptance: define gate/test requirements.
- Verification Plan: ${verificationPlan}
`;
}

function buildProblemDomainChain(specId, options = {}) {
  const sceneId = normalizeText(options.sceneId) || `scene.${specId.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`;
  const problemStatement = normalizeText(options.problemStatement) || 'TBD: describe the primary business problem';
  const primaryFlow = normalizeText(options.primaryFlow) || 'TBD: define core user/business flow';
  const verificationPlan = normalizeText(options.verificationPlan) || 'TBD: define validation and rollback criteria';
  const now = new Date().toISOString();

  return {
    api_version: DOMAIN_CHAIN_API_VERSION,
    generated_at: now,
    scene_id: sceneId,
    spec_id: specId,
    problem: {
      statement: problemStatement,
      scope: 'TBD: define boundary and excluded domains',
      symptom: 'TBD: observable symptom and impact'
    },
    ontology: {
      entity: ['TBD: primary entity'],
      relation: ['TBD: key relation'],
      business_rule: ['TBD: enforceable business rule'],
      decision_policy: ['TBD: decision condition and policy'],
      execution_flow: ['TBD: action chain and side effects']
    },
    hypotheses: [
      {
        id: 'H1',
        statement: 'TBD: root-cause hypothesis',
        evidence: ['TBD: evidence or signal'],
        confidence: 'low'
      }
    ],
    risks: [
      {
        id: 'R1',
        type: 'wrong-direction',
        statement: 'TBD: direction drift risk',
        mitigation: 'TBD: correction checkpoint'
      }
    ],
    decision_execution_path: [
      {
        step: 1,
        action: 'entry',
        decision: 'TBD: trigger condition',
        expected_result: 'TBD: expected output'
      },
      {
        step: 2,
        action: 'route',
        decision: 'TBD: policy branch',
        expected_result: 'TBD: branch result'
      },
      {
        step: 3,
        action: 'execute',
        decision: 'TBD: execution rule',
        expected_result: 'TBD: side effect and data change'
      }
    ],
    research_coverage: {
      mode: 'scene-closed-loop',
      required_dimensions: [...DOMAIN_RESEARCH_DIMENSIONS],
      checklist: {
        scene_boundary: true,
        entity: true,
        relation: true,
        business_rule: true,
        decision_policy: true,
        execution_flow: true,
        failure_signal: true,
        debug_evidence_plan: true,
        verification_gate: true
      },
      status: 'draft'
    },
    correction_loop: {
      triggers: [
        'gate failure',
        'ontology mismatch',
        'two failed fix rounds'
      ],
      actions: [
        'refresh domain map',
        'attach debug evidence',
        'rebuild scene spec contract'
      ]
    },
    verification: {
      plan: verificationPlan,
      gates: [
        'spec-gate',
        'tests',
        'release preflight'
      ]
    },
    problem_contract: buildProblemContract(specId, options),
    ontology_evidence: {
      entity: ['Entity mapping evidence: model/schema reference'],
      relation: ['Relation mapping evidence: join/foreign-key or service linkage'],
      business_rule: ['Rule evidence: validation/policy check reference'],
      decision_policy: ['Decision evidence: branch condition and policy source'],
      execution_flow: ['Execution evidence: service/screen/runtime trace path']
    }
  };
}

function validateProblemDomainMapContent(content = '') {
  const checks = {
    hasRootProblem: /##\s+Root Problem/i.test(content),
    hasMindMapBlock: /```mermaid[\s\S]*mindmap/i.test(content),
    hasLayeredExplorationChain: /##\s+Layered Exploration Chain/i.test(content),
    hasCoverageMatrix: /##\s+Closed-Loop Research Coverage Matrix/i.test(content),
    hasCorrectionLoop: /##\s+Correction Loop/i.test(content)
  };
  const passed = Object.values(checks).every(Boolean);
  return { passed, checks };
}

function validateSceneSpecContent(content = '') {
  const checks = {
    hasSceneDefinition: /##\s+Scene Definition/i.test(content),
    hasOntologyCoverage: /##\s+Ontology Coverage/i.test(content),
    hasDecisionExecutionPath: /##\s+Decision & Execution Path/i.test(content),
    hasClosedLoopResearchContract: /##\s+Closed-Loop Research Contract/i.test(content),
    hasAcceptanceGate: /##\s+Acceptance & Gate/i.test(content)
  };
  const passed = Object.values(checks).every(Boolean);
  return { passed, checks };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasNonEmptyStringArray(value) {
  return Array.isArray(value) && value.some((item) => isNonEmptyString(item));
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function isMeaningfulText(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }
  const normalized = value.trim();
  return !/^(tbd|todo|n\/a|na|待补|待定|待完善|placeholder)\b/i.test(normalized);
}

function hasMeaningfulStringArray(value) {
  return Array.isArray(value) && value.some((item) => isMeaningfulText(item));
}

function hasResearchCoverageChecklist(value) {
  if (!isObject(value)) {
    return false;
  }
  return DOMAIN_RESEARCH_DIMENSIONS.every((dimension) => typeof value[dimension] === 'boolean');
}

function hasResearchCoverageDimensions(value) {
  if (!Array.isArray(value)) {
    return false;
  }
  const normalized = new Set(value.map((item) => `${item || ''}`.trim()).filter(Boolean));
  return DOMAIN_RESEARCH_DIMENSIONS.every((dimension) => normalized.has(dimension));
}

function validateProblemDomainChainPayload(payload = {}, specId = '') {
  const researchCoverage = payload && isObject(payload.research_coverage)
    ? payload.research_coverage
    : null;
  const checks = {
    apiVersion: isNonEmptyString(payload.api_version),
    sceneId: isNonEmptyString(payload.scene_id),
    specId: isNonEmptyString(payload.spec_id) && (!specId || payload.spec_id === specId),
    problemStatement: isNonEmptyString(payload?.problem?.statement),
    ontologyEntity: hasNonEmptyStringArray(payload?.ontology?.entity),
    ontologyRelation: hasNonEmptyStringArray(payload?.ontology?.relation),
    ontologyBusinessRule: hasNonEmptyStringArray(payload?.ontology?.business_rule),
    ontologyDecisionPolicy: hasNonEmptyStringArray(payload?.ontology?.decision_policy),
    ontologyExecutionFlow: hasNonEmptyStringArray(payload?.ontology?.execution_flow),
    hasHypotheses: Array.isArray(payload.hypotheses) && payload.hypotheses.length > 0,
    hasRisks: Array.isArray(payload.risks) && payload.risks.length > 0,
    hasDecisionPath: Array.isArray(payload.decision_execution_path) && payload.decision_execution_path.length >= 3,
    hasResearchCoverageObject: Boolean(researchCoverage),
    hasResearchCoverageMode: isNonEmptyString(researchCoverage && researchCoverage.mode),
    hasResearchCoverageDimensions: hasResearchCoverageDimensions(researchCoverage && researchCoverage.required_dimensions),
    hasResearchCoverageChecklist: hasResearchCoverageChecklist(researchCoverage && researchCoverage.checklist),
    hasCorrectionTriggers: hasNonEmptyStringArray(payload?.correction_loop?.triggers),
    hasCorrectionActions: hasNonEmptyStringArray(payload?.correction_loop?.actions),
    hasVerificationGates: hasNonEmptyStringArray(payload?.verification?.gates)
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks
  };
}

function buildDomainCoverageItems(chainPayload = {}, validation = null) {
  const ontology = isObject(chainPayload && chainPayload.ontology) ? chainPayload.ontology : {};
  const correctionLoop = isObject(chainPayload && chainPayload.correction_loop) ? chainPayload.correction_loop : {};
  const verification = isObject(chainPayload && chainPayload.verification) ? chainPayload.verification : {};
  const researchCoverage = isObject(chainPayload && chainPayload.research_coverage)
    ? chainPayload.research_coverage
    : {};

  const structuralItems = [];
  if (validation && isObject(validation.details)) {
    structuralItems.push({
      id: 'map_structure',
      label: 'problem-domain-map structure',
      covered: Boolean(validation.details.domain_map && validation.details.domain_map.exists && validation.details.domain_map.checks && Object.values(validation.details.domain_map.checks).every(Boolean)),
      evidence: DOMAIN_MAP_RELATIVE_PATH
    });
    structuralItems.push({
      id: 'scene_structure',
      label: 'scene-spec structure',
      covered: Boolean(validation.details.scene_spec && validation.details.scene_spec.exists && validation.details.scene_spec.checks && Object.values(validation.details.scene_spec.checks).every(Boolean)),
      evidence: SCENE_SPEC_RELATIVE_PATH
    });
    structuralItems.push({
      id: 'chain_structure',
      label: 'problem-domain-chain structure',
      covered: Boolean(validation.details.domain_chain && validation.details.domain_chain.exists && validation.details.domain_chain.checks && Object.values(validation.details.domain_chain.checks).every(Boolean)),
      evidence: DOMAIN_CHAIN_RELATIVE_PATH
    });
  }

  const domainItems = [
    {
      id: 'scene_boundary',
      label: 'Scene boundary',
      covered: isMeaningfulText(chainPayload?.problem?.statement) && isMeaningfulText(chainPayload?.problem?.scope),
      evidence: 'problem.statement + problem.scope'
    },
    {
      id: 'entity',
      label: 'Ontology entity coverage',
      covered: hasMeaningfulStringArray(ontology.entity),
      evidence: 'ontology.entity[]'
    },
    {
      id: 'relation',
      label: 'Ontology relation coverage',
      covered: hasMeaningfulStringArray(ontology.relation),
      evidence: 'ontology.relation[]'
    },
    {
      id: 'business_rule',
      label: 'Business rule coverage',
      covered: hasMeaningfulStringArray(ontology.business_rule),
      evidence: 'ontology.business_rule[]'
    },
    {
      id: 'decision_policy',
      label: 'Decision policy coverage',
      covered: hasMeaningfulStringArray(ontology.decision_policy),
      evidence: 'ontology.decision_policy[]'
    },
    {
      id: 'execution_flow',
      label: 'Execution flow coverage',
      covered: hasMeaningfulStringArray(ontology.execution_flow),
      evidence: 'ontology.execution_flow[]'
    },
    {
      id: 'failure_signal',
      label: 'Failure-signal coverage',
      covered: hasMeaningfulStringArray(correctionLoop.triggers),
      evidence: 'correction_loop.triggers[]'
    },
    {
      id: 'debug_evidence_plan',
      label: 'Debug evidence plan',
      covered: Array.isArray(correctionLoop.actions)
        && correctionLoop.actions.some((item) => /debug|diagnostic|日志|evidence/i.test(`${item || ''}`)),
      evidence: 'correction_loop.actions[]'
    },
    {
      id: 'verification_gate',
      label: 'Verification gate coverage',
      covered: hasMeaningfulStringArray(verification.gates),
      evidence: 'verification.gates[]'
    },
    {
      id: 'research_contract',
      label: 'Research contract checklist',
      covered: hasResearchCoverageChecklist(researchCoverage.checklist)
        && hasResearchCoverageDimensions(researchCoverage.required_dimensions),
      evidence: 'research_coverage.required_dimensions + checklist'
    }
  ];

  return [...structuralItems, ...domainItems];
}

async function ensureSpecDomainArtifacts(projectPath, specId, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const dryRun = options.dryRun === true;
  const force = options.force === true;

  const paths = resolveSpecPaths(projectPath, specId);
  const domainMapContent = buildProblemDomainMindMap(specId, options);
  const sceneSpecContent = buildSceneSpec(specId, options);
  const domainChainPayload = buildProblemDomainChain(specId, options);
  const problemContractPayload = buildProblemContract(specId, options);

  const created = {
    domain_map: false,
    scene_spec: false,
    domain_chain: false,
    problem_contract: false
  };

  if (!dryRun) {
    await fileSystem.ensureDir(path.dirname(paths.domainMapPath));

    const hasDomainMap = await fileSystem.pathExists(paths.domainMapPath);
    if (force || !hasDomainMap) {
      await fileSystem.writeFile(paths.domainMapPath, domainMapContent, 'utf8');
      created.domain_map = true;
    }

    const hasSceneSpec = await fileSystem.pathExists(paths.sceneSpecPath);
    if (force || !hasSceneSpec) {
      await fileSystem.writeFile(paths.sceneSpecPath, sceneSpecContent, 'utf8');
      created.scene_spec = true;
    }

    const hasDomainChain = await fileSystem.pathExists(paths.domainChainPath);
    if (force || !hasDomainChain) {
      await fileSystem.writeJson(paths.domainChainPath, domainChainPayload, { spaces: 2 });
      created.domain_chain = true;
    }

    const hasProblemContract = await fileSystem.pathExists(paths.problemContractPath);
    if (force || !hasProblemContract) {
      await fileSystem.writeJson(paths.problemContractPath, problemContractPayload, { spaces: 2 });
      created.problem_contract = true;
    }
  } else {
    created.domain_map = true;
    created.scene_spec = true;
    created.domain_chain = true;
    created.problem_contract = true;
  }

  return {
    paths: {
      domain_map: paths.domainMapPath,
      scene_spec: paths.sceneSpecPath,
      domain_chain: paths.domainChainPath,
      problem_contract: paths.problemContractPath
    },
    created,
    preview: {
      domain_map: domainMapContent,
      scene_spec: sceneSpecContent,
      domain_chain: domainChainPayload,
      problem_contract: problemContractPayload
    }
  };
}

async function validateSpecDomainArtifacts(projectPath, specId, fileSystem = fs) {
  const paths = resolveSpecPaths(projectPath, specId);
  const warnings = [];
  const details = {
    domain_map: {
      path: paths.domainMapPath,
      exists: false,
      checks: {}
    },
    scene_spec: {
      path: paths.sceneSpecPath,
      exists: false,
      checks: {}
    },
    domain_chain: {
      path: paths.domainChainPath,
      exists: false,
      checks: {}
    }
  };

  let passedChecks = 0;
  const totalChecks = 3;

  const hasDomainMap = await fileSystem.pathExists(paths.domainMapPath);
  details.domain_map.exists = hasDomainMap;
  if (!hasDomainMap) {
    warnings.push(`Missing required artifact: ${DOMAIN_MAP_RELATIVE_PATH}`);
  } else {
    const content = await fileSystem.readFile(paths.domainMapPath, 'utf8');
    const evaluation = validateProblemDomainMapContent(content);
    details.domain_map.checks = evaluation.checks;
    if (evaluation.passed) {
      passedChecks += 1;
    } else {
      warnings.push(`Invalid ${DOMAIN_MAP_RELATIVE_PATH}: missing mandatory sections`);
    }
  }

  const hasSceneSpec = await fileSystem.pathExists(paths.sceneSpecPath);
  details.scene_spec.exists = hasSceneSpec;
  if (!hasSceneSpec) {
    warnings.push(`Missing required artifact: ${SCENE_SPEC_RELATIVE_PATH}`);
  } else {
    const content = await fileSystem.readFile(paths.sceneSpecPath, 'utf8');
    const evaluation = validateSceneSpecContent(content);
    details.scene_spec.checks = evaluation.checks;
    if (evaluation.passed) {
      passedChecks += 1;
    } else {
      warnings.push(`Invalid ${SCENE_SPEC_RELATIVE_PATH}: missing mandatory sections`);
    }
  }

  const hasDomainChain = await fileSystem.pathExists(paths.domainChainPath);
  details.domain_chain.exists = hasDomainChain;
  if (!hasDomainChain) {
    warnings.push(`Missing required artifact: ${DOMAIN_CHAIN_RELATIVE_PATH}`);
  } else {
    let payload = null;
    try {
      payload = await fileSystem.readJson(paths.domainChainPath);
    } catch (error) {
      warnings.push(`Invalid ${DOMAIN_CHAIN_RELATIVE_PATH}: malformed JSON (${error.message})`);
    }
    if (payload) {
      const evaluation = validateProblemDomainChainPayload(payload, specId);
      details.domain_chain.checks = evaluation.checks;
      if (evaluation.passed) {
        passedChecks += 1;
      } else {
        warnings.push(`Invalid ${DOMAIN_CHAIN_RELATIVE_PATH}: missing mandatory chain fields`);
      }
    }
  }

  return {
    passed: passedChecks === totalChecks,
    ratio: passedChecks / totalChecks,
    details,
    warnings
  };
}

async function analyzeSpecDomainCoverage(projectPath, specId, fileSystem = fs) {
  const validation = await validateSpecDomainArtifacts(projectPath, specId, fileSystem);
  const paths = resolveSpecPaths(projectPath, specId);
  let chainPayload = null;

  if (await fileSystem.pathExists(paths.domainChainPath)) {
    try {
      chainPayload = await fileSystem.readJson(paths.domainChainPath);
    } catch (_error) {
      chainPayload = null;
    }
  }

  const items = buildDomainCoverageItems(chainPayload || {}, validation);
  const coveredCount = items.filter((item) => item.covered).length;
  const totalCount = items.length;
  const uncovered = items.filter((item) => !item.covered).map((item) => item.id);

  return {
    passed: uncovered.length === 0,
    coverage_ratio: totalCount > 0 ? coveredCount / totalCount : 0,
    covered_count: coveredCount,
    total_count: totalCount,
    uncovered,
    items,
    validation
  };
}

module.exports = {
  DOMAIN_MAP_RELATIVE_PATH,
  SCENE_SPEC_RELATIVE_PATH,
  DOMAIN_CHAIN_RELATIVE_PATH,
  PROBLEM_CONTRACT_RELATIVE_PATH,
  DOMAIN_CHAIN_API_VERSION,
  DOMAIN_RESEARCH_DIMENSIONS,
  buildProblemDomainMindMap,
  buildSceneSpec,
  buildProblemDomainChain,
  buildProblemContract,
  ensureSpecDomainArtifacts,
  validateSpecDomainArtifacts,
  analyzeSpecDomainCoverage
};
