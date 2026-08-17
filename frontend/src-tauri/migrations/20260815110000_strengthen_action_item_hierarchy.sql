UPDATE document_templates
SET prompt = 'Output exactly two sections and no others.

First understand the complete meeting record. Consolidate statements made at different times that serve the same outcome. Do not turn every sentence, suggestion or discussion point into a separate task.

## Meeting Summary
Write one complete, natural sentence of no more than 40 Chinese characters when the output language is Chinese, or no more than 40 words for a space-delimited language. State the meeting subject, main conclusion and next-stage direction. Count before answering. Never cut a sentence or phrase in the middle.

## Action Items
Use Markdown task lists. Every top-level item must describe a distinct deliverable or outcome and begin with a clear action verb. Keep the wording concise but grammatically complete.

Required format:
- [ ] **Complete an explicit outcome or deliverable** · Owner: explicit overall owner or Unassigned · Due: explicit date or Not specified
  - [ ] Complete a necessary step · Owner: explicit owner or Unassigned · Due: explicit date or Not specified
  - [ ] Complete another necessary step · Owner: explicit owner or Unassigned · Due: explicit date or Not specified

Rules:
1. Extract only future work that was explicitly assigned, requested, committed or clearly agreed in the meeting.
2. When two or more actions contribute to the same explicitly stated outcome, project or deliverable, you MUST create one parent task for that outcome and nest those actions as subtasks. The parent is the shared result, not a duplicate action.
3. If the meeting explicitly names an overall accountable person, assign that person to the parent. Otherwise mark the parent owner as Unassigned. A subtask may have a different explicit owner and deadline.
4. Keep independent deliverables as separate top-level tasks. Do not create hierarchy merely for appearance.
5. Give each task one accountable owner when the meeting states one. Preserve collaborators only when necessary.
6. Include a deadline only when explicitly stated. Resolve relative dates only when the meeting date makes conversion reliable.
7. Preserve essential scope, object, quantity, condition and deliverable so the task remains executable. Never cut a sentence in the middle.
8. Do not include background explanation, debate, completed work, generic principles, unsupported suggestions, source quotations or a table.
9. Do not invent missing owners, deadlines, priorities or acceptance criteria.
10. If no action item was formed, output only: - [ ] No confirmed action items.',
    description = 'A concise summary followed by consolidated parent tasks and executable Markdown subtasks.',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'summary-actions';
