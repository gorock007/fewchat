CREATE TABLE events (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY NOT NULL REFERENCES events(id),
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENDING','SENT','DELIVERY_UNKNOWN')),
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  message_id TEXT
);
CREATE INDEX deliveries_pending ON deliveries(status, created_at, id);
