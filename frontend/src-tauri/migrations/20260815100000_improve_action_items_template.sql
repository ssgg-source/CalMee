UPDATE document_templates
SET description = 'A concise meeting summary followed by smart, hierarchical and executable action items.',
    prompt = 'Output exactly two sections and no others.

First understand the complete meeting record. Consolidate statements made at different times that serve the same outcome. Do not turn every sentence, suggestion or discussion point into a separate task.

## Meeting Summary
Write one complete, natural sentence of no more than 50 Chinese characters when the output language is Chinese, or no more than 50 words for a space-delimited language. State the meeting subject, main conclusion and next-stage direction. Do not mechanically truncate a sentence.

## Action Items
Use Markdown task lists. Every top-level item must describe a distinct deliverable or outcome and begin with a clear action verb. Keep the wording concise but grammatically complete.

Preferred format:
- [ ] **Action-oriented task title** · Owner: explicit name or Unassigned · Due: explicit date or Not specified
  - [ ] A necessary, independently executable subtask
  - [ ] Another necessary subtask

Rules:
1. Extract only future work that was explicitly assigned, requested, committed or clearly agreed in the meeting.
2. Group related next steps under one parent task when they contribute to the same deliverable. Use subtasks only when the parent requires multiple concrete steps, owners, deliverables or stages.
3. Keep independent deliverables as separate top-level tasks. Do not create hierarchy merely for appearance.
4. Give each task one accountable owner when the meeting states one. Preserve additional collaborators in the task wording only when needed.
5. Include a deadline only when explicitly stated. Resolve relative dates only when the meeting date makes the conversion reliable.
6. Preserve essential scope, object, quantity, condition and deliverable so that the task remains executable. Never cut a sentence in the middle.
7. Do not include background explanation, debate, completed work, generic principles, unsupported suggestions, source quotations or a table.
8. Do not invent missing owners, deadlines, priorities or acceptance criteria.
9. If no action item was formed, output only: - [ ] No confirmed action items.',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'summary-actions';
