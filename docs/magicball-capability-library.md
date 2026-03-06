# Magicball 能力库复用对接说明（SCE）

> 目标：在 Magicball UI 中提供“能力库检索/匹配/使用”闭环，加速场景能力落地。

Schema reference: `docs/agent-runtime/magicball-status.schema.json`

## 1. 能力库复用流程

能力模板进入能力库前，默认要求补齐本体三项核心能力：
- 实体关系
- 业务规则
- 决策策略


1. **查询**能力库（列表/搜索）
2. **匹配**当前 spec 的问题域（基于 problem-domain-chain 里的 ontology）
3. **使用**能力模板（生成可执行的 usage plan）

## 2. SCE CLI 支持（对 Magicball 的最小封装）

### 2.1 查询与搜索

```bash
sce capability catalog list --json
sce capability catalog list --release-ready true --json
sce capability catalog list --missing-triad decision_strategy --json
sce capability catalog search "customer order" --release-ready false --json
sce capability catalog show <template-id> --json
```

### 2.2 匹配（基于 spec ontology）

```bash
sce capability match --spec <spec-id> --json
sce capability match --spec <spec-id> --query "订单 库存" --limit 5 --json
```

匹配会读取：
- `.sce/specs/<spec>/custom/problem-domain-chain.json`

若该文件缺失，默认仍返回结果，但 `warnings` 中会标记缺失。

### 2.3 使用（生成 usage plan）

```bash
sce capability use --template <template-id> --spec <spec-id> --json
```

输出：`capability-use-plan`（用于 UI 展示和后续手工应用）。

如需直接写入 spec 任务：

```bash
sce capability use --template <template-id> --spec <spec-id> --apply --json
```

## 3. API 封装建议（CLI -> HTTP）

建议 Magicball 后端封装为：

- `POST /api/sce/capability/catalog/list`
- `POST /api/sce/capability/catalog/search`
- `POST /api/sce/capability/catalog/show`
- `POST /api/sce/capability/match`
- `POST /api/sce/capability/use`

请求体示例：

```json
{
  "specId": "01-02-customer-order",
  "query": "订单 库存",
  "limit": 5
}
```

## 4. UI 行为建议（Magicball）

### 4.1 能力库入口
- 顶部图标入口
- Tabs：`能力库` / `匹配结果` / `使用计划`

### 4.2 能力库列表
- 支持筛选：category / risk / source
- 展示关键信息：`name` / `description` / `ontology_scope` / `ontology_core`

### 4.3 匹配结果
- 展示 `score` + `score_components` + `ontology_core.ready`
- 支持一键生成 usage plan

### 4.4 使用计划
- 展示 `recommended_tasks`
- 可手工转为当前 spec 的任务

## 5. 输出结构（关键字段）

列表、详情、匹配、使用计划里的模板对象都应直接消费：
- `ontology_core`
- `ontology_core_ui.ready`
- `ontology_core_ui.coverage_percent`
- `ontology_core_ui.missing`
- `ontology_core_ui.triads.entity_relation|business_rules|decision_strategy`


### capability-match
```json
{
  "mode": "capability-match",
  "spec_id": "01-02-customer-order",
  "scene_id": "scene.customer-order",
  "match_count": 12,
  "matches": [
    {
      "template_id": "customer-order-core",
      "ontology_core_ui": {
        "ready": true,
        "coverage_percent": 100,
        "missing": [],
        "triads": {
          "entity_relation": true,
          "business_rules": true,
          "decision_strategy": true
        }
      },
      "score": 82,
      "score_components": {
        "ontology": 0.72,
        "scenario": 1,
        "keyword": 0.35
      }
    }
  ]
}
```

### capability-use-plan
```json
{
  "mode": "capability-use-plan",
  "template": {"id": "customer-order-core", "name": "Customer Order Core"},
  "spec_id": "01-02-customer-order",
  "recommended_tasks": [
    {"title": "Define order entity"},
    {"title": "Implement order lifecycle"}
  ]
}
```

---

若需要“自动落地写入 spec 任务”的强制执行模式，可以在后续版本加 `--apply` 开关。

### release_readiness_ui（列表状态）
```json
{
  "publish_ready": false,
  "blocking_count": 1,
  "blocking_ids": ["ontology-core-triads"],
  "blocking_reasons": ["missing required ontology triads"],
  "blocking_missing": ["decision_strategy"]
}
```

### release_readiness（发布阻断原因）
```json
{
  "ready": false,
  "blockers": [
    {
      "id": "ontology-core-triads",
      "severity": "blocking",
      "reason": "missing required ontology triads",
      "missing": ["decision_strategy"],
      "missing_labels": ["decision_strategy"],
      "remediation": [
        "补齐实体关系（entities + relations）",
        "补齐业务规则（business_rules）",
        "补齐决策策略（decisions)"
      ]
    }
  ]
}
```

### mb_status（统一状态语言）
```json
{
  "attention_level": "critical",
  "status_tone": "danger",
  "status_label": "blocked",
  "blocking_summary": "缺决策策略，暂不可发布",
  "recommended_action": "补齐决策策略"
}
```
