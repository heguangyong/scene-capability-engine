# Magicball 能力迭代 API 封装建议（基于 SCE CLI）

> 目标：把 SCE CLI 统一封装成 Magicball 内部 API，方便前端用标准 JSON 调用。

---

## 1. API 设计原则

- **一处封装**：统一执行 CLI，屏蔽差异
- **JSON 输出**：所有调用带 `--json`
- **可回放**：每一步的输出落盘并在 UI 可复用
- **错误可读**：将 stderr 错误结构化返回

---

## 2. 建议 API 列表

### 2.1 Inventory

```
POST /api/capability/inventory
```

请求：
```json
{
  "release_ready": false,
  "missing_triad": "decision_strategy"
}
```

执行 CLI：
```bash
sce capability inventory --release-ready false --missing-triad decision_strategy --json
```

响应：
- 返回 `capability-inventory` payload，重点消费 `scenes[].ontology_core_ui` 与 `scenes[].release_readiness_ui`

---

### 2.2 Extract

```
POST /api/capability/extract
```

请求：
```json
{
  "scene_id": "scene.customer-order",
  "specs": ["01-00-order", "01-01-inventory"],
  "sample_limit": 5
}
```

执行 CLI：
```bash
sce capability extract --scene <scene_id> --specs <specs> --sample-limit <n> --json
```

响应：
- 返回 `capability-extract` payload，重点消费 `ontology_core` 与 `summary.ontology_missing_triads`

---

### 2.3 Score

```
POST /api/capability/score
```

请求：
```json
{
  "candidate_file": ".sce/reports/capability-iteration/scene.customer-order.candidate.json"
}
```

执行 CLI：
```bash
sce capability score --input <candidate_file> --json
```

响应：
- 返回 `capability-score` payload，重点消费 `scores.ontology_core_score` 与 `scores.ontology_core`

---

### 2.4 Map

```
POST /api/capability/map
```

请求：
```json
{
  "candidate_file": ".sce/reports/capability-iteration/scene.customer-order.candidate.json",
  "ontology_file": ".sce/ontology/capability-mapping.json",
  "template_id": "scene.customer-order",
  "name": "Capability template: scene.customer-order",
  "description": "Derived from scene.customer-order"
}
```

执行 CLI：
```bash
sce capability map --input <candidate_file> --mapping <ontology_file> \
  --template-id <template_id> --name "<name>" --description "<desc>" --json
```

响应：
- 返回 `capability-map` payload，重点消费 `template.ontology_core` 与 `release_readiness`

---

### 2.5 Register

```
POST /api/capability/register
```

请求：
```json
{
  "template_file": ".sce/reports/capability-iteration/scene.customer-order.template.json",
  "risk_level": "medium",
  "difficulty": "intermediate"
}
```

执行 CLI：
```bash
sce capability register --input <template_file> --risk-level <level> --difficulty <level> --json
```

响应：
- 返回 `capability-register` payload，重点消费 `ontology_core` 与 `release_readiness`（入库 triad 审核结果）

---

## 3. 通用返回结构（建议）

```json
{
  "success": true,
  "data": { ...sce_payload },
  "stderr": null
}
```

失败：
```json
{
  "success": false,
  "data": null,
  "stderr": "error message from sce"
}
```

---

## 4. 前端调用建议

- 每一步 UI 都展示对应 `data.output_file`（如有）
- 支持“重新执行”按钮（调用同一 API）
- 失败时提示 `stderr`，并保留上一步数据可继续

---

## 5. 推荐顺序

1. `/api/capability/inventory`
2. `/api/capability/extract`
3. `/api/capability/score`
4. `/api/capability/map`
5. `/api/capability/register`


## 6. Inventory 固定查询协议

- `query.protocol_version`：前后端协议版本
- `query.scene_id`：单场景盘点时使用，否则为 `null`
- `query.limit`：场景返回上限
- `query.sample_limit`：每个 spec 抽样任务上限
- `query.filters.release_ready`：发布可用性过滤
- `query.filters.missing_triad`：triad 缺口过滤
- `summary_stats.publish_ready_count` / `summary_stats.blocked_count`：顶部统计卡
- `summary_stats.missing_triads.*`：triad 缺口计数卡
- `sort.strategy`：默认排序策略说明
- `sort.triad_priority`：triad 优先级数组
