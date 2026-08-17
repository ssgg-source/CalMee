-- Store the user-edited meeting record as one Markdown document. The derived
-- blocks remain available for speaker/source relationships and AI rebuilding.
ALTER TABLE meeting_record_state ADD COLUMN document_markdown TEXT;
