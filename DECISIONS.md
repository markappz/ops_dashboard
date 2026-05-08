# Ops Dashboard Decision Log

Record of every important decision so we don't revisit settled questions.

---

## 2026-05-06 — Auth model: Google OAuth + HMAC session cookie + email allowlist

**Decision:** Gate `/api/ops/*` (except `/api/ops/auth/*`) behind a Google sign-in flow. Email allowlist via `ADMIN_EMAILS` env. Session = HMAC-signed httpOnly cookie (`ops_session`), 7-day TTL, no DB row.

**Why this and not alternatives:**
- **vs. password auth:** Paul already uses Google. Zero new credentials to manage. SSO-quality without a vendor.
- **vs. JWT lib (jsonwebtoken):** HMAC via node's `crypto` is one less dep. Format identical in shape (`payload.sig`).
- **vs. DB-backed sessions:** No table, no migration, stateless verify. Logout = clear cookie (not server-side revoke). Acceptable for an internal tool with a tiny user count.
- **vs. tying to FitScript's Cognito:** Cognito is end-user auth for the consumer app. Mixing admin auth into it would muddy roles. Separate flow keeps blast radius small.

**How to apply:** New protected routes go under `/api/ops/*` and inherit gating automatically. Public ingest (tracking pixel, health) stays under `/api/t/*` or `/api/health`. Adding an admin = add their email to `ADMIN_EMAILS` and redeploy.

---

## 2026-05-06 — Raw SQL only, no Drizzle in this repo

**Decision:** All DB access uses `pool.query()` (raw SQL). `server/schema.ts` exists as a stub; do not grow it.

**Why:** Drizzle ORM crashed in the ops-dashboard runtime previously (logged in cross-project memory `feedback_ops_raw_sql`). Cost a debugging session. Raw SQL is also the pattern already used throughout `server/routes.ts`.

**How to apply:** New endpoints write SQL directly. Schema-of-record lives in the main FitScript repo's Drizzle schema; ops only reads from those tables.
