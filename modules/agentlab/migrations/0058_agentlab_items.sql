CREATE TABLE IF NOT EXISTS agentlab_items (
  external_id text PRIMARY KEY,
  article_id text UNIQUE REFERENCES articles (id) ON DELETE CASCADE,
  upstream_revision text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'suppressed', 'withdrawn')),
  reason text,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
