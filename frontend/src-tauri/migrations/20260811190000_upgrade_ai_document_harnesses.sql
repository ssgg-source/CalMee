-- Upgrade the built-in smart-record templates without overwriting user templates.
UPDATE document_templates
SET name = 'Detailed Smart Record',
    description = 'A topic-organized, fact-rich record with overview, chapters, quotes, actions and speaker review.',
    prompt = 'Produce the full detailed smart-record structure defined by the system Harness. Prefer complete thematic coverage over brevity. Use information-dense topic sections with bold semantic labels; include recording overview, navigable chapter timeline, genuine quotes, explicit action items and evidence-based speaker review. Preserve side topics in proportion to their importance.',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'smart-detailed' AND kind = 'smart_record' AND builtin = 1;

UPDATE document_templates
SET name = 'Concise Smart Record',
    description = 'A shorter topic-organized record focused on conclusions, decisions and actions.',
    prompt = 'Use the smart-record structure defined by the system Harness, but keep topic descriptions concise. Prioritize conclusions, decisions, reasons, risks and action items. Keep the chapter timeline and omit the quotes section when no quote is genuinely valuable.',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'smart-clean' AND kind = 'smart_record' AND builtin = 1;
