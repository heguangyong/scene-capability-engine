# Magicball 能力迭代管理（SCE 对接说明）

> 适用于：Magicball AI 助手页面新增顶部图标入口，内部用页签切换。
> 目标：从历史 `scene/spec/task` 中提炼可复用能力模板，并完成本体映射，形成可发布的能力资产。

---

## 1. 目标与范围

- 目标：从历史 `scene/spec/task` 中提炼能力模板，并完成 ontology 映射闭环。
- 范围：Magicball UI 新增「能力迭代」入口（顶部图标），内部用页签完成全流程。

---

## 2. UI 草图（文字版）

### 2.1 能力迭代首页（Scene 盘点）
```
┌─────────────────────────────────────────────────────────────┐
│ 能力迭代                                                    │
│ [筛选：时间 | 完成率 | 风险] [搜索：scene id]                │
├─────────────────────────────────────────────────────────────┤
│ Scene卡片：scene.customer-order                              │
│ - spec: 3  tasks: 42  completed: 36  pending: 6             │
│ - triad: 2/3  missing: decision_strategy                    │
│ - score: 未评估                                              │
│ [进入评估]                                                   │
├─────────────────────────────────────────────────────────────┤
│ Scene卡片：scene.inventory-reconcile                          │
│ - spec: 2  tasks: 18  completed: 18  pending: 0             │
│ [进入评估]                                                   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 评估页（Spec/Task + 评分卡）
```
┌───────────────┬─────────────────────────────────────────────┐
│ Spec列表      │ 评分卡                                        │
│ - 01-00-demo  │ value: 78  reuse: 66  stability: 85  risk: 20 │
│ - 01-01-check │ completion: 0.86  ontology_core: 67           │
│ - 01-02-order │ missing: business_rules                       │
├───────────────┼─────────────────────────────────────────────┤
│ Task摘要      │ [生成模板候选]                                │
│ total: 42     │                                               │
│ completed:36  │                                               │
│ pending: 6    │                                               │
└───────────────┴─────────────────────────────────────────────┘
```

### 2.3 模板构建页（元信息 + 本体映射）
```
┌─────────────────────────────────────────────────────────────┐
│ 模板信息                                                    │
│ name: [Capability template: scene.customer-order]            │
│ desc: [模板描述 ...]                                         │
│ tags: [order, customer, inventory]                           │
├─────────────────────────────────────────────────────────────┤
│ 本体映射                                                     │
│ domains: [commerce]                                          │
│ entities: [Order, Customer]                                  │
│ relations: [Order->Customer]                                 │
│ business_rules: [OrderApproval]                              │
│ decisions: [RiskPolicy]                                      │
├─────────────────────────────────────────────────────────────┤
│ [保存映射] [进入发布]                                        │
└─────────────────────────────────────────────────────────────┘
```

### 2.4 发布页（模板包生成）
```
┌─────────────────────────────────────────────────────────────┐
│ 发布结果                                                    │
│ template_id: scene.customer-order                             │
│ output_dir: .sce/templates/exports/capability-scene_customer… │
│ files:                                                      │
│ - capability-template.json                                  │
│ - template-registry.json                                    │
│ [复制路径] [推送模板库]                                     │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 推荐 UI 架构（顶部图标 + 页签）

顶部图标入口：`能力迭代`

内部页签建议：
1. `Scene 盘点`
2. `评估`
3. `模板构建`
4. `发布`

状态机建议：
`extract -> score -> map -> register`

---

## 4. SCE 接口参数（CLI 可封装）

### 4.1 Scene 盘点首页聚合
```bash
sce capability inventory --json
sce capability inventory --release-ready false --missing-triad decision_strategy --json
```

### 4.2 提取候选能力
```bash
sce capability extract --scene <sceneId> --json
```
可选参数：
- `--specs <spec-id, spec-id>`
- `--out <path>`
- `--sample-limit <n>`

### 4.2 评分
```bash
sce capability score --input <candidate.json> --json
```

### 4.3 本体映射
```bash
sce capability map --input <candidate.json> --mapping <ontology.json> --json
```
可选参数：
- `--template-id <id>`
- `--name <name>`
- `--description <desc>`
- `--category <category>`
- `--tags <tag1,tag2>`

### 4.4 发布模板包
```bash
sce capability register --input <template.json> --json
```
可选参数：
- `--out <dir>`
- `--risk-level <low|medium|high|critical>`
- `--difficulty <beginner|intermediate|advanced>`
- `--tags <tag1,tag2>`
- `--applicable-scenarios <scene1,scene2>`

---

## 5. 数据契约（前端对接）

- UI 契约：`docs/agent-runtime/capability-iteration-ui.schema.json`
- 本体映射 schema：`docs/ontology/capability-mapping.schema.json`

---

## 6. 前端适配建议

### 6.1 状态管理
- 采用步骤式状态机：`extract -> score -> map -> register`
- 每一步输出的 JSON 都持久化，便于回放/复用

### 6.2 体验优化
- Scene 首页显示完成率、待处理数、triad 覆盖率、缺失项入口
- 评分卡统一可视化（value/reuse/stability/risk/ontology_core）
- 盘点页支持按 triad 缺口排序：优先显示缺失 `decision_strategy` / `business_rules` / `entity_relation` 的 scene
- 本体映射表单应支持快速导入与默认推荐值

### 6.3 错误处理
- CLI 失败时直接展示错误原因
- `task_error` 存在时提示 spec 任务文件缺失或解析失败
- 保留上一步产物可继续重试

### 6.4 权限与治理
- 若涉及写入本体或发布模板，建议通过 SCE auth lease 授权

---

## 7. 推荐路由

- `/capability` Scene 首页  
- `/capability/scene/:sceneId` 评估页  
- `/capability/scene/:sceneId/template` 模板构建页  
- `/capability/scene/:sceneId/release` 发布页  


## 8. 推荐排序字段

- `ontology_core_ui.ready`
- `ontology_core_ui.coverage_percent`
- `ontology_core_ui.missing`
- `summary.ontology_triads_ready`
- `summary.ontology_missing_triads`

## 9. 发布阻断提示

- 发布页直接消费 `release_readiness.ready`
- 若为 `false`，展示 `blockers[].reason`、`blockers[].missing`、`blockers[].remediation`
- 默认阻断文案：`能力模板未达到发布条件`

## 10. 默认排序

- 先显示 `release_readiness_ui.publish_ready = false` 的 scene
- 再按 triad 缺口优先级排序：`decision_strategy` -> `business_rules` -> `entity_relation`
- 再按 `score_preview.value_score` 降序
- 最后按 `scene_id` 升序

## 11. 首页固定查询协议

- 使用 `capability-inventory` 返回的 `query` 作为首页请求回显
- 使用 `sort` 作为排序策略展示来源
- 首页筛选器应直接映射：`query.filters.release_ready`、`query.filters.missing_triad`
- 首页顶部可显示：`scene_total` / `scene_count` / `summary_stats`

## 12. 顶部统计卡

- `summary_stats.publish_ready_count`：可发布 scene 数
- `summary_stats.blocked_count`：被阻断 scene 数
- `summary_stats.missing_triads.decision_strategy`：缺决策策略数量
- `summary_stats.missing_triads.business_rules`：缺业务规则数量
- `summary_stats.missing_triads.entity_relation`：缺实体关系数量
