CREATE TABLE IF NOT EXISTS reading_entries (
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  analysis_id bigint NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  material_hash text NOT NULL,
  version text NOT NULL,
  receipt_id bigint NOT NULL UNIQUE REFERENCES receipts(id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (article_id, revision, analysis_id, material_hash, version)
);
