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

-- Poster orders (Stripe -> webhook -> Prodigi)
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now')),
  email TEXT,
  clerk_user_id TEXT,
  poster_id TEXT NOT NULL,
  poster_title TEXT,
  size TEXT NOT NULL,
  paper TEXT NOT NULL,
  mode TEXT DEFAULT 'STRICT',
  currency TEXT DEFAULT 'usd',
  amount_total REAL,
  stripe_session_id TEXT,
  prodigi_order_id TEXT,
  status TEXT DEFAULT 'paid',
  -- Optional fulfillment fields (updated later by Prodigi webhooks)
  prodigi_status TEXT,
  tracking_number TEXT,
  tracking_url TEXT,
  shipped_at TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_clerk_user_id ON orders(clerk_user_id);
CREATE INDEX IF NOT EXISTS idx_orders_stripe_session_id ON orders(stripe_session_id);

-- Idempotency: en Stripe checkout session ska bara ge en order.
-- Detta gör att webhook-retries / "Resend" inte kan skapa duplicates i DB.
CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_stripe_session_id ON orders(stripe_session_id);

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


-- BOLO licenses
CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  email TEXT,
  clerk_user_id TEXT,
  license_key TEXT NOT NULL,
  license_fingerprint TEXT,
  plan TEXT NOT NULL,
  period_months INTEGER NOT NULL,
  seats INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  stripe_session_id TEXT NOT NULL,
  stripe_payment_intent_id TEXT,
  stripe_invoice_id TEXT,
  stripe_invoice_url TEXT
);

CREATE INDEX IF NOT EXISTS idx_licenses_clerk_user_id ON licenses(clerk_user_id);
CREATE INDEX IF NOT EXISTS idx_licenses_email ON licenses(email);
CREATE INDEX IF NOT EXISTS idx_licenses_expires_at ON licenses(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_licenses_stripe_session_id ON licenses(stripe_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_licenses_fingerprint ON licenses(license_fingerprint);
