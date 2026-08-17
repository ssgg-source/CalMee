INSERT OR IGNORE INTO document_templates
    (id, kind, name, description, prompt, builtin, created_at, updated_at)
VALUES
    ('summary-actions', 'meeting_summary', 'Action Items',
     'A meeting summary of no more than 50 characters followed by concise action items.',
     'Output exactly two sections and no others.

## Meeting Summary
Write one plain paragraph of no more than 50 Chinese characters when the output language is Chinese, or no more than 50 words for a space-delimited language. Cover only the meeting subject and main conclusion.

## Action Items
List the work explicitly proposed, assigned, requested or committed for the next stage. Use one short bullet per task. Start with the owner only when explicitly known, then state the action and include the deadline only when explicitly stated. Do not include background, reasoning, discussion details, completed work, speculative suggestions or a table. Do not invent missing information. If no action item was formed, write one bullet stating that no action item was identified.',
     1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
