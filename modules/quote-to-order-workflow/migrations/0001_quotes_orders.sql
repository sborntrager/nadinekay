CREATE TABLE IF NOT EXISTS quote_requests (
  id TEXT PRIMARY KEY,
  customer_email TEXT NOT NULL,
  customer_name TEXT,
  request_json TEXT NOT NULL,
  quote_json TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewing', 'quoted', 'accepted', 'declined', 'expired', 'converted')),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_quote_requests_status_created ON quote_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quote_requests_customer_email ON quote_requests(customer_email);

CREATE TABLE IF NOT EXISTS sales_orders (
  id TEXT PRIMARY KEY,
  quote_request_id TEXT NOT NULL UNIQUE REFERENCES quote_requests(id) ON DELETE RESTRICT,
  customer_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'fulfilled', 'cancelled')),
  total_cents INTEGER,
  order_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sales_orders_customer_email ON sales_orders(customer_email, created_at DESC);
