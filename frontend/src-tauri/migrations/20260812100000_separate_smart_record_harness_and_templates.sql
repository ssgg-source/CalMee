-- Output structure belongs to the selected template. The editable Harness now
-- contains only reasoning workflow, knowledge use, and factual safeguards.
UPDATE document_templates
SET name = 'Detailed Smart Record',
    description = 'A topic-organized, fact-rich record with overview, chapters, quotes, actions and speaker review.',
    prompt = 'Create the following Markdown document. Translate all headings and field labels naturally when the requested output language is not Chinese.

# Meeting title

## 📑 智能记录

### 录音信息
- **录音时间**：start ~ end; write 未提供 when unavailable
- **时长**：human-readable duration
- **参与人数**：约 N 人
- **内容类型**：choose the most accurate type supported by the transcript

### 录音总结
Write one dense paragraph of 1–3 sentences covering the subject, central conclusions and immediate next step.

### Topic heading
- **Semantic label**：fact-rich explanation.
- **Semantic label**：fact-rich explanation.

Create as many topic sections as needed for complete coverage. Do not force a fixed count or create empty sections. Preserve substantive side topics in proportion to their importance.

## 📅 章节概要

### HH:MM:SS Chapter title
Write one compact paragraph describing this interval. Use only timestamps present in the input and create enough chapters to navigate the complete recording.

## ✨ 金句精选
- “Verbatim or minimally cleaned quote.”（分类）
Include 0–5 genuinely useful quotes. Omit this section when none qualify.

## 📋 待办事项
- **Owner**：action; deadline or condition when explicitly stated.
Include confirmed commitments and explicit requests only. If none exist, write “未明确形成待办事项”。

## 💡 发言回顾
When a speaker is explicitly marked “(我)”, title this section “我的发言回顾” and review that speaker. Otherwise review the principal speaker by name. Include role, speaking style, key outputs, and one evidence-based high point. Do not add unsupported personality judgments.

Return clean Markdown only.',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'smart-detailed' AND kind = 'smart_record' AND builtin = 1;

UPDATE document_templates
SET name = 'Concise Smart Record',
    description = 'A shorter topic-organized record focused on conclusions, decisions and actions.',
    prompt = 'Create a concise Markdown smart record with this structure:

# Meeting title
## 📑 智能记录
### 录音信息
### 录音总结
### Topic sections as needed
## 📅 章节概要
## 📋 待办事项

Prioritize conclusions, decisions, reasons, risks and confirmed actions. Use bold semantic labels inside topic sections. Keep the navigable chapter timeline. Add “## ✨ 金句精选” only when a quote is genuinely valuable. Do not include a speaker review. Translate headings naturally for non-Chinese output. Return clean Markdown only.',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'smart-clean' AND kind = 'smart_record' AND builtin = 1;
