-- Recognition data management: keep user-provided person context separate from
-- future AI-derived portraits, and allow one hotword to belong to many groups.
ALTER TABLE people ADD COLUMN profile_context TEXT;
ALTER TABLE people ADD COLUMN profile_json TEXT;
ALTER TABLE people ADD COLUMN profile_updated_at TEXT;

ALTER TABLE hotwords ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';

UPDATE hotwords
SET tags = json_array(category)
WHERE TRIM(category) <> '' AND tags = '[]';
