# Magicball 任务质量治理对接说明（SCE）

> 适用于：Magicball AI 助手任务卡 UI 的质量治理增强与 SCE Task 质量闭环对接。

## 1. 背景与目标

任务由对话生成，容易出现「多事项混杂、目标不清晰、验收缺失」等问题，导致执行偏移或兜底编程。
SCE 新增「任务质量治理」闭环能力，保证每个任务可执行、可验收、可追踪。

目标：
- 让 Magicball UI 在**同一任务卡**内完成“草案 -> 评分 -> 修正 -> Promote”的闭环
- 通过质量门禁（Policy）强制任务可执行、可验收
- 保留用户原始输入，避免信息丢失

## 2. SCE 新增能力概览

新增 CLI：
- `sce task draft`
- `sce task consolidate`
- `sce task score`
- `sce task promote`

新增策略文件：
- `.sce/config/task-quality-policy.json`
- 支持 `--policy <path>` 覆盖

默认门禁（可配置）：
- acceptance_criteria 必须存在
- needs_split 必须为 false
- min_score >= 70

## 3. 推荐交互流程（最短闭环）

1. 用户输入 -> `sce task draft`
2. 多轮输入合并 -> `sce task consolidate`
3. 评分 -> `sce task score`
4. 通过门禁 -> `sce task promote`
5. 成功写入 `tasks.md`

## 4. 字段契约（建议 Magicball 消费）

核心字段：
- `task_ref`（草案阶段可为空）
- `title_norm`
- `raw_request`
- `goal`
- `sub_goals`
- `acceptance_criteria`
- `needs_split`
- `confidence`
- `next_action`
- `handoff`
- `score`

示例（草案阶段）：
```json
{
  "task_ref": null,
  "title_norm": "生成客户-订单-库存演示数据流程",
  "raw_request": "帮我做一个客户订单库存的demo",
  "goal": "生成可运行的客户-订单-库存演示流程",
  "sub_goals": ["定义实体关系", "生成测试数据", "配置页面展示"],
  "acceptance_criteria": [],
  "needs_split": true,
  "confidence": 0.68,
  "next_action": "split",
  "handoff": "needs_split=true, acceptance_criteria empty"
}
```

评分示例：
```json
{
  "score": 62,
  "missing_items": ["acceptance_criteria", "split_required"]
}
```

Promote 成功：
```json
{
  "success": true,
  "task_ref": "01.02.03",
  "message": "promoted"
}
```

Promote 失败：
```json
{
  "success": false,
  "message": "quality gate failed",
  "reasons": ["acceptance_criteria missing", "needs_split=true"]
}
```

## 5. UI 行为规范（强制）

- 草案页：默认显示**评分卡 + 缺失项**
- `needs_split=true`：必须拆分或补充，**禁止 promote**
- `acceptance_criteria` 为空：**阻断 promote**
- promote 失败时提示固定文案：**“质量门禁未通过”**

## 6. 基于现有任务 UI 的最小改动建议

当前 UI：单卡片 + 事件流 + 文件变更 + 错误信息。
在不改整体布局的前提下，建议：

1) 任务头部
- 显示 `title_norm`
- `raw_request` 置于标题下方（可折叠）
- 状态徽标：Draft / Needs Split / Missing Acceptance / Ready / Failed Gate

2) 评分卡（插入到事件流上方）
- 展示 `score / missing_items / next_action`
- 点击展开查看策略阈值与建议

3) 强制阻断逻辑
- needs_split 或 acceptance 缺失 => promote 按钮置灰
- 展示原因与修复入口

4) Promote 失败提示
- 固定文案 “质量门禁未通过”
- 展示失败原因列表

5) 原有事件流保留，增强复制能力
- 错误日志一键复制，便于诊断

## 7. 参考命令（Magicball 封装为 API 即可）

```bash
sce task draft --spec <specPath> --input "<user text>"
sce task consolidate --spec <specPath>
sce task score --spec <specPath>
sce task promote --spec <specPath>
```

## 8. 版本与发布说明

该能力自 **SCE v3.6.11** 开始提供，若 Magicball 需要兼容老版本，请做版本检测与能力降级处理。

---

如需进一步输出 UI 页面原型或字段映射表，可直接在此文档上增补。
## 9. 字段映射表（SCE -> Magicball UI）

| SCE 字段 | UI 位置 | 展示方式 | 规则 |
| --- | --- | --- | --- |
| task_ref | 任务卡标题前 | 小号标签 | 无则隐藏 |
| title_norm | 任务卡标题 | 主标题 | 必填 |
| raw_request | 标题下方 | 灰色可折叠 | 保留原文 |
| goal | 详情区 | 主目标段落 | 若空提示补齐 |
| sub_goals | 详情区 | 列表 | needs_split=true 时高亮 |
| acceptance_criteria | 详情区 | 验收列表 | 为空阻断 promote |
| needs_split | 状态徽标 | Needs Split | true 则阻断 |
| confidence | 评分卡 | 低/中/高 | <0.6 高亮 |
| score | 评分卡 | 数值 + 色阶 | <阈值红色 |
| missing_items | 评分卡 | 缺失列表 | 点击展开 |
| next_action | 评分卡 | 下一步 | 生成操作建议 |
| handoff | 详情区 | 灰色提示 | 展示门禁原因 |
| errors | 事件流 | 错误块 | 一键复制 |
| file_changes | 文件变更区 | 文件列表 | diff 快捷入口 |

## 10. 前端组件建议

### 10.1 TaskCard（现有卡片增强）
- Header：`task_ref + title_norm`，`raw_request` 折叠显示。
- StatusBadge：Draft / Needs Split / Missing Acceptance / Ready / Failed Gate。
- QuickActions：Score / Promote / Split / Fix Acceptance。

### 10.2 QualityScorePanel
- 固定显示 `score / missing_items / next_action`。
- 展开显示 policy 阈值与建议。
- 禁止 promote 时显示红色提示条。

### 10.3 AcceptanceEditor
- 为空时自动提示“请补齐验收标准”。
- 提供“自动补齐建议”按钮（由 SCE 生成）。

### 10.4 PromoteGuard
- 拦截条件：needs_split=true 或 acceptance_criteria 为空。
- 拦截弹窗文案固定：“质量门禁未通过”。

### 10.5 ErrorStream
- 事件流右侧增加复制按钮。
- 错误日志折叠/展开。

## 11. 建议的调用顺序（前端按钮）

- 点击“生成草案”：`sce task draft`
- 点击“合并输入”：`sce task consolidate`
- 点击“评分”：`sce task score`
- 点击“Promote”：`sce task promote`

---
