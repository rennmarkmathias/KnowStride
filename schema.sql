-- Users
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Access table: start_time = when schedule starts, access_until = when paid access ends
CREATE TABLE IF NOT EXISTS access (
  user_id TEXT PRIMARY KEY,
  start_time INTEGER NOT NULL,
  access_until INTEGER NOT NULL
);

-- Stripe events/purchases for bookkeeping
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  stripe_event_id TEXT NOT NULL,
  stripe_session_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  amount_total INTEGER,
  currency TEXT,
  created_at INTEGER NOT NULL
);
