CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  visitor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  next_allowed_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','complete','failed','cooldown'))
);
CREATE INDEX IF NOT EXISTS requests_queue ON requests(status,created_at);
CREATE INDEX IF NOT EXISTS requests_visitor ON requests(visitor,created_at);
