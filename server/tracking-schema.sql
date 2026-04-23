-- FitScript Tracking System — run once against production RDS
-- Tracks every visitor from first hit through lifetime value

-- Visitor sessions: every browser session with UTM data
CREATE TABLE IF NOT EXISTS visitor_sessions (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  visitor_id VARCHAR NOT NULL,              -- persistent cookie ID (survives sessions)
  user_id VARCHAR REFERENCES users(id),     -- null until signup/login
  session_id VARCHAR NOT NULL,              -- unique per browser session
  ip_address VARCHAR,
  user_agent TEXT,
  referrer TEXT,
  landing_page VARCHAR,
  exit_page VARCHAR,
  utm_source VARCHAR,
  utm_medium VARCHAR,
  utm_campaign VARCHAR,
  utm_content VARCHAR,
  utm_term VARCHAR,
  gclid VARCHAR,                            -- Google click ID
  fbclid VARCHAR,                           -- Meta click ID
  ttclid VARCHAR,                           -- TikTok click ID
  device_type VARCHAR,                      -- mobile, desktop, tablet
  country VARCHAR,
  region VARCHAR,
  city VARCHAR,
  page_count INTEGER DEFAULT 1,
  duration_seconds INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vs_visitor ON visitor_sessions(visitor_id);
CREATE INDEX IF NOT EXISTS idx_vs_user ON visitor_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_vs_created ON visitor_sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_vs_utm_source ON visitor_sessions(utm_source);
CREATE INDEX IF NOT EXISTS idx_vs_utm_campaign ON visitor_sessions(utm_campaign);

-- Touchpoints: every meaningful event in the customer journey
CREATE TABLE IF NOT EXISTS touchpoints (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  visitor_id VARCHAR NOT NULL,
  user_id VARCHAR REFERENCES users(id),
  session_id VARCHAR,
  event_type VARCHAR NOT NULL,              -- page_view, signup, subscription_started, lab_ordered, etc.
  event_data JSONB DEFAULT '{}',
  page_url VARCHAR,
  utm_source VARCHAR,
  utm_campaign VARCHAR,
  revenue DECIMAL(10,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tp_visitor ON touchpoints(visitor_id);
CREATE INDEX IF NOT EXISTS idx_tp_user ON touchpoints(user_id);
CREATE INDEX IF NOT EXISTS idx_tp_event ON touchpoints(event_type);
CREATE INDEX IF NOT EXISTS idx_tp_created ON touchpoints(created_at);

-- Attribution: computed per-user, links revenue to acquisition source
CREATE TABLE IF NOT EXISTS attribution (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id VARCHAR NOT NULL REFERENCES users(id) UNIQUE,
  first_touch_source VARCHAR,
  first_touch_medium VARCHAR,
  first_touch_campaign VARCHAR,
  first_touch_landing VARCHAR,
  first_touch_at TIMESTAMP,
  last_touch_source VARCHAR,
  last_touch_medium VARCHAR,
  last_touch_campaign VARCHAR,
  last_touch_landing VARCHAR,
  last_touch_at TIMESTAMP,
  converting_session VARCHAR,
  total_sessions INTEGER DEFAULT 0,
  days_to_convert INTEGER DEFAULT 0,
  total_touchpoints INTEGER DEFAULT 0,
  total_revenue DECIMAL(10,2) DEFAULT 0,
  first_payment_at TIMESTAMP,
  last_payment_at TIMESTAMP,
  subscription_tier VARCHAR,
  subscription_status VARCHAR,
  ltv_30d DECIMAL(10,2) DEFAULT 0,
  ltv_60d DECIMAL(10,2) DEFAULT 0,
  ltv_90d DECIMAL(10,2) DEFAULT 0,
  ltv_lifetime DECIMAL(10,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attr_source ON attribution(first_touch_source);
CREATE INDEX IF NOT EXISTS idx_attr_campaign ON attribution(first_touch_campaign);
CREATE INDEX IF NOT EXISTS idx_attr_ltv ON attribution(ltv_lifetime);

-- Campaigns: tracks all marketing campaigns for performance reporting
CREATE TABLE IF NOT EXISTS campaigns (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name VARCHAR NOT NULL,
  slug VARCHAR NOT NULL UNIQUE,             -- auto-generated from utm_campaign
  channel VARCHAR,                          -- google, meta, tiktok, email, organic, direct
  medium VARCHAR,                           -- cpc, organic, social, email
  status VARCHAR DEFAULT 'active',          -- active, paused, ended
  start_date DATE,
  end_date DATE,
  budget DECIMAL(10,2),
  spend DECIMAL(10,2) DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_camp_slug ON campaigns(slug);
CREATE INDEX IF NOT EXISTS idx_camp_status ON campaigns(status);

-- Daily metrics: pre-aggregated for fast dashboard queries
CREATE TABLE IF NOT EXISTS daily_metrics (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  date DATE NOT NULL UNIQUE,
  visitors INTEGER DEFAULT 0,
  new_visitors INTEGER DEFAULT 0,
  returning_visitors INTEGER DEFAULT 0,
  sessions INTEGER DEFAULT 0,
  page_views INTEGER DEFAULT 0,
  signups INTEGER DEFAULT 0,
  paid_conversions INTEGER DEFAULT 0,
  revenue DECIMAL(10,2) DEFAULT 0,
  refunds DECIMAL(10,2) DEFAULT 0,
  net_revenue DECIMAL(10,2) DEFAULT 0,
  active_subscribers INTEGER DEFAULT 0,
  churned INTEGER DEFAULT 0,
  mrr DECIMAL(10,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Channel daily metrics: per-channel breakdown
CREATE TABLE IF NOT EXISTS channel_daily_metrics (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  date DATE NOT NULL,
  channel VARCHAR NOT NULL,                 -- source/medium combo
  utm_campaign VARCHAR,
  visitors INTEGER DEFAULT 0,
  sessions INTEGER DEFAULT 0,
  signups INTEGER DEFAULT 0,
  paid_conversions INTEGER DEFAULT 0,
  revenue DECIMAL(10,2) DEFAULT 0,
  cost DECIMAL(10,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(date, channel, utm_campaign)
);

CREATE INDEX IF NOT EXISTS idx_cdm_date ON channel_daily_metrics(date);
CREATE INDEX IF NOT EXISTS idx_cdm_channel ON channel_daily_metrics(channel);
