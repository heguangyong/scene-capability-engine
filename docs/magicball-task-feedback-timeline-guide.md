# Magicball Task Feedback + Timeline Integration Guide

> 目标：让 Magicball 在不直接消费底层事件流/快照原始结构的情况下，使用 SCE 的稳定任务反馈模型与时间线视图模型。

## 1. 任务反馈模型（来源：`sce studio events --json`）

Schema references:
- `docs/agent-runtime/magicball-status.schema.json`
- `docs/agent-runtime/magicball-task-feedback.schema.json`
- `docs/agent-runtime/magicball-timeline-view.schema.json`


SCE 现在在 `task` 下增加：
- `feedback_model.version`
- `feedback_model.problem`
- `feedback_model.execution`
- `feedback_model.diagnosis`
- `feedback_model.evidence`
- `feedback_model.next_step`

### 1.1 字段说明

- `problem.component`：当前问题所属组件/scene
- `problem.action`：当前动作或阶段
- `problem.expected`：期望结果
- `problem.actual`：实际结果

- `execution.stage`：当前阶段（plan/generate/apply/verify/release/rollback/events）
- `execution.status`：当前状态
- `execution.summary[]`：3 行以内摘要
- `execution.blocking_summary`：阻断摘要

- `diagnosis.hypothesis`：当前根因假设/错误摘要
- `diagnosis.chain_checkpoint`：定位链路检查点
- `diagnosis.root_cause_confidence`：根因判断置信度（low/medium/high）

- `evidence.file_count` / `evidence.file_paths[]`
- `evidence.command_count` / `evidence.error_count`
- `evidence.verification_result`
- `evidence.regression_scope[]`

- `next_step.recommended_action`：面向人的下一步建议
- `next_step.next_action`：动作 key
- `next_step.next_command`：推荐命令

### 1.2 Magicball UI 建议

任务卡默认显示：
1. `problem.expected / actual`
2. `execution.summary`
3. `execution.blocking_summary`
4. `next_step.recommended_action`
5. `evidence.file_paths`（最多前 3-5 个）

事件流 `event[]` 保留为“展开查看”，不再作为主视图。

## 2. 时间线视图模型（来源：`sce timeline list/show --json`）

SCE 现在在时间线命令中增加：
- `view_model.summary`
- `view_model.entries[]`（list）
- `view_model.snapshot`（show）
- `view_model.files_preview[]`（show）

### 2.1 timeline list

关键字段：
- `view_model.summary.total`
- `view_model.summary.latest_snapshot_id`
- `view_model.summary.latest_created_at`
- `view_model.summary.dirty_snapshot_count`
- `view_model.summary.scene_count`
- `view_model.summary.trigger_counts`
- `view_model.entries[]`

每个 entry：
- `snapshot_id`
- `title`
- `subtitle`
- `created_at`
- `scene_id`
- `file_count`
- `attention_level`
- `show_command`
- `restore_command`

### 2.2 timeline show

关键字段：
- `view_model.snapshot`
- `view_model.files_preview[]`
- `view_model.file_total`
- `view_model.restore_command`

### 2.3 Magicball UI 建议

时间线面板建议两层：
- 列表层：使用 `view_model.entries[]` 渲染时间线卡片
- 详情层：使用 `view_model.snapshot + files_preview` 渲染快照详情

默认展示：
- 快照标题
- 创建时间
- 关联 scene
- 文件数
- attention level
- “查看详情 / 恢复” 按钮

## 3. 推荐对接顺序

1. 任务面板先接 `task.feedback_model`
2. 再把 `event[]` 放到“高级模式”
3. 时间线首页接 `timeline list.view_model`
4. 时间线详情页接 `timeline show.view_model`

## 4. 最小接口清单

- `sce studio events --job <job-id> --json`
- `sce studio events --job <job-id> --openhands-events <path> --json`
- `sce timeline list --limit 20 --json`
- `sce timeline show <snapshot-id> --json`

## 5. 设计原则

- 主视图优先展示“人可判断信息”，不是原始事件流
- 事件流保留为审计层，不作为第一视图
- 时间线优先展示“可恢复、可比较、可追踪”的节点信息
- 所有字段都以 SCE 输出为准，Magicball 不自行推断


## 6. Magicball 统一状态语言

SCE 现在会在任务反馈模型中提供 `mb_status`：
- `attention_level`
- `status_tone`
- `status_label`
- `blocking_summary`
- `recommended_action`

Magicball 可直接用这组字段控制颜色、图标、提示文案。
