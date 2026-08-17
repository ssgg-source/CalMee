UPDATE document_templates
SET prompt = replace(
        prompt,
        'Count before answering. Never cut a sentence or phrase in the middle.',
        'Silently count before answering, but never display a character count, word count or any meta-commentary. Never cut a sentence or phrase in the middle.'
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'summary-actions';
