-- Run against the existing D1 database (goldenbeemalaj-leads) that already
-- backs the `leads` table:
--   npx wrangler d1 execute goldenbeemalaj-leads --remote --file=d1/migrations.sql

CREATE TABLE IF NOT EXISTS pricing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  price_per_goldback_cents INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_session_id TEXT UNIQUE NOT NULL,
  series TEXT NOT NULL,
  denomination TEXT NOT NULL,
  face_value_gb REAL NOT NULL,
  quantity INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  customer_email TEXT,
  customer_name TEXT,
  shipping_address TEXT,
  status TEXT NOT NULL DEFAULT 'paid',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
