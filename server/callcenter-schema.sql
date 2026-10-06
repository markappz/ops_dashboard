-- Call Center tables (Real Peptides first; brand column keeps it multi-brand).
-- Applied at boot like tracking-schema.sql — CREATE TABLE IF NOT EXISTS only,
-- plus idempotent ALTERs guarded by IF NOT EXISTS. All times UTC (timestamptz).

CREATE TABLE IF NOT EXISTS cc_contacts (
  id            BIGSERIAL PRIMARY KEY,
  brand         TEXT NOT NULL DEFAULT 'realpeptides',
  name          TEXT,
  business_name TEXT,
  phone_e164    TEXT,
  phone_raw     TEXT,
  email_norm    TEXT,
  email_raw     TEXT,
  -- a matching phone SUGGESTS a contact; verified = proven via a verification grant
  verification_state TEXT NOT NULL DEFAULT 'unverified', -- unverified | suggested | verified
  customer_links JSONB NOT NULL DEFAULT '{}'::jsonb,     -- {siteContactId, wholesaleClientId, ...}
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cc_contacts_phone_idx ON cc_contacts (brand, phone_e164);
CREATE INDEX IF NOT EXISTS cc_contacts_email_idx ON cc_contacts (brand, email_norm);

CREATE TABLE IF NOT EXISTS cc_conversations (
  id            BIGSERIAL PRIMARY KEY,
  provider      TEXT NOT NULL DEFAULT 'retell',
  workspace_id  TEXT,
  external_id   TEXT NOT NULL,                 -- Retell call_id / chat_id (canonical key)
  brand         TEXT NOT NULL DEFAULT 'realpeptides',
  channel       TEXT NOT NULL,                 -- voice | chat | sms
  call_type     TEXT,                          -- phone_call | web_call | chat
  direction     TEXT,                          -- inbound | outbound | web
  from_number   TEXT,
  to_number     TEXT,
  agent_id      TEXT,
  agent_version INTEGER,
  agent_name    TEXT,
  started_at    TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  duration_ms   INTEGER,
  provider_status   TEXT,                      -- registered | ongoing | ended | error ...
  disconnect_reason TEXT,
  summary       TEXT,
  transcript    TEXT,
  transcript_object JSONB,
  recording_url TEXT,
  analysis      JSONB,                         -- custom analysis fields, as evidence
  analysis_status TEXT NOT NULL DEFAULT 'pending', -- pending | received | error | n/a
  analyzed_at   TIMESTAMPTZ,
  intent        TEXT,
  issue_type    TEXT,
  contact_id    BIGINT REFERENCES cc_contacts(id),
  is_test       BOOLEAN NOT NULL DEFAULT FALSE,
  -- monotonic guards: never overwrite newer state with an older payload
  last_event_type TEXT,
  last_event_ts   BIGINT,                      -- provider ms timestamp of newest applied event
  transcript_version BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, external_id)
);
CREATE INDEX IF NOT EXISTS cc_conversations_brand_started_idx ON cc_conversations (brand, started_at DESC);
CREATE INDEX IF NOT EXISTS cc_conversations_contact_idx ON cc_conversations (contact_id);
CREATE INDEX IF NOT EXISTS cc_conversations_agent_idx ON cc_conversations (agent_id);

CREATE TABLE IF NOT EXISTS cc_requests (
  id            BIGSERIAL PRIMARY KEY,
  brand         TEXT NOT NULL DEFAULT 'realpeptides',
  conversation_id BIGINT REFERENCES cc_conversations(id),
  contact_id    BIGINT REFERENCES cc_contacts(id),
  kind          TEXT NOT NULL DEFAULT 'support',  -- support | wholesale | sales_recovery | affiliate | education | triage
  reason        TEXT,                             -- callback | needs_quote | quote_question | payment_question | payment_review | paid_waiting_fulfillment | shipment_question | product_question | other
  queue         TEXT NOT NULL DEFAULT 'triage',   -- support | wholesale | sales_recovery | affiliate | triage
  concern       TEXT,
  intent        TEXT,
  product_refs  JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{productId, variantId, name, qty}]
  order_reference TEXT,
  wholesale_refs  JSONB NOT NULL DEFAULT '{}'::jsonb, -- {clientRef, orderRef, quoteRef, repRef}
  priority      TEXT NOT NULL DEFAULT 'normal',   -- low | normal | high | urgent
  state         TEXT NOT NULL DEFAULT 'new',      -- new | assigned | in_progress | awaiting_customer | scheduled | resolved | closed_no_action
  owner_email   TEXT,
  contact_permission BOOLEAN,                     -- explicit callback permission; NULL = unknown
  contact_channel    TEXT,                        -- phone | sms | email
  callback_window_raw TEXT,                       -- the customer's original wording, verbatim
  callback_at   TIMESTAMPTZ,                      -- normalized; NULL + needs_scheduling when ambiguous
  callback_tz   TEXT,
  needs_scheduling BOOLEAN NOT NULL DEFAULT FALSE,
  due_at        TIMESTAMPTZ,
  snoozed_until TIMESTAMPTZ,
  snooze_reason TEXT,
  resolution    TEXT,
  resolved_at   TIMESTAMPTZ,
  resolved_by   TEXT,
  source        TEXT NOT NULL DEFAULT 'staff',    -- live_tool | webhook_analysis | staff
  idempotency_key TEXT,
  -- staff touched it: stale webhook analysis must never reopen or rewrite it
  staff_locked  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS cc_requests_idem_idx ON cc_requests (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS cc_requests_state_idx ON cc_requests (brand, state, queue, due_at);
CREATE INDEX IF NOT EXISTS cc_requests_owner_idx ON cc_requests (owner_email, state);
CREATE INDEX IF NOT EXISTS cc_requests_conv_idx ON cc_requests (conversation_id);

CREATE TABLE IF NOT EXISTS cc_wholesale_inquiries (
  id            BIGSERIAL PRIMARY KEY,
  request_id    BIGINT NOT NULL REFERENCES cc_requests(id),
  business_name TEXT,
  contact_name  TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  lines         JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{product, variant, qty, notes}]
  labeling      JSONB NOT NULL DEFAULT '{}'::jsonb, -- {rpLabel, customLabel, coaNeeds, docs}
  timing        TEXT,
  stage         TEXT NOT NULL DEFAULT 'inquiry',    -- inquiry | draft_quote | approved_quote | order | payment
  quote_owner   TEXT,
  quote_ref     TEXT,                               -- existing site wholesale quote/order reference
  site_client_ref TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cc_wholesale_req_idx ON cc_wholesale_inquiries (request_id);

-- Durable webhook inbox: accept fast, process out of band, retry + dead-letter.
CREATE TABLE IF NOT EXISTS cc_webhook_inbox (
  id            BIGSERIAL PRIMARY KEY,
  provider      TEXT NOT NULL DEFAULT 'retell',
  event_type    TEXT NOT NULL,
  external_id   TEXT,                            -- call_id / chat_id
  dedupe_key    TEXT NOT NULL,                   -- event_type + external_id + payload digest/version
  payload       JSONB NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | processed | failed | dead
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ,
  UNIQUE (provider, dedupe_key)
);
CREATE INDEX IF NOT EXISTS cc_inbox_pending_idx ON cc_webhook_inbox (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS cc_inbox_external_idx ON cc_webhook_inbox (external_id);

-- Tool-call receipts: a timeout/retry after a successful commit returns the
-- ORIGINAL receipt instead of creating a second task.
CREATE TABLE IF NOT EXISTS cc_tool_calls (
  id            BIGSERIAL PRIMARY KEY,
  conversation_external_id TEXT,
  agent_id      TEXT,
  tool          TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  args          JSONB NOT NULL DEFAULT '{}'::jsonb,
  response      JSONB,
  status        TEXT NOT NULL DEFAULT 'ok',      -- ok | error
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tool, idempotency_key)
);
CREATE INDEX IF NOT EXISTS cc_tool_calls_conv_idx ON cc_tool_calls (conversation_external_id);

-- Order-access verification grants, bound to conversation + order + purpose + expiry.
CREATE TABLE IF NOT EXISTS cc_verifications (
  id            BIGSERIAL PRIMARY KEY,
  conversation_external_id TEXT NOT NULL,
  order_reference TEXT,
  purpose       TEXT NOT NULL DEFAULT 'order_status',
  channel       TEXT,                            -- email | sms (established channel on file)
  destination_masked TEXT,                       -- e.g. p***@g***.com — never the raw destination
  code_hash     TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  expires_at    TIMESTAMPTZ NOT NULL,
  verified_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cc_verifications_conv_idx ON cc_verifications (conversation_external_id, expires_at);

-- Human callback attempts: attempted | no_answer | voicemail | connected | failed.
CREATE TABLE IF NOT EXISTS cc_call_attempts (
  id            BIGSERIAL PRIMARY KEY,
  request_id    BIGINT REFERENCES cc_requests(id),
  contact_id    BIGINT REFERENCES cc_contacts(id),
  staff_email   TEXT NOT NULL,
  provider      TEXT NOT NULL DEFAULT 'manual',  -- manual (tel: fallback) | twilio | ...
  outcome       TEXT NOT NULL DEFAULT 'attempted',
  notes         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cc_call_attempts_req_idx ON cc_call_attempts (request_id);

-- Immutable activity timeline (staff actions, provider events, tool receipts, assignments).
CREATE TABLE IF NOT EXISTS cc_events (
  id            BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT REFERENCES cc_conversations(id),
  request_id    BIGINT REFERENCES cc_requests(id),
  actor_type    TEXT NOT NULL,                   -- provider | system | staff | agent_tool
  actor         TEXT,                            -- staff email / tool name / event type
  type          TEXT NOT NULL,
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cc_events_conv_idx ON cc_events (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS cc_events_req_idx ON cc_events (request_id, created_at);

-- Sync watermarks + catalog snapshot state + health markers.
CREATE TABLE IF NOT EXISTS cc_sync_state (
  key           TEXT PRIMARY KEY,
  value         JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Retell configuration snapshots (export-before-edit + rollback source).
CREATE TABLE IF NOT EXISTS cc_config_audit (
  id            BIGSERIAL PRIMARY KEY,
  kind          TEXT NOT NULL,                   -- agents | chat-agents | llms | diff | apply | rollback
  note          TEXT,
  actor         TEXT,
  snapshot      JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
