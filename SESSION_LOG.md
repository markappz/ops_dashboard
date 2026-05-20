# Ops Dashboard Session Log

Running history of every development session. Autom reads this at the start of each session.

---

## 2026-05-06 — Admin auth gate + project memory scaffolds

**Worked on:** P0 security fix — every `/api/ops/*` route was wide open to the public.

**Changed:**
- `server/admin-auth.ts` (new) — Google OAuth login flow (openid/email/profile only), HMAC-signed session cookie (`ops_session`), `requireAdmin` + `opsGate` middleware, `ADMIN_EMAILS` allowlist. No new deps (HMAC via node `crypto`).
- `server/index.ts` — registers `registerAdminAuthRoutes` before mounting `opsGate`. `/api/health` and `/api/t/*` (tracking pixel) stay public; everything else under `/api/ops/*` requires admin session.
- `client/src/App.tsx` — adds `useAdminSession()` hook hitting `/api/ops/auth/me`. Renders `<Login />` when unauthenticated.
- `client/src/pages/login.tsx` (new) — "Sign in with Google" button → `/api/ops/auth/login`.
- `client/src/components/layout/ops-layout.tsx` — admin email + sign-out in top bar.
- `CLAUDE.md`, `SESSION_LOG.md`, `DECISIONS.md` (new) — repo memory per project standard.

**Verified:** `npx tsc --noEmit` shows zero errors in new files. `vite build` + `esbuild server/index.ts` both compile clean.

**Pre-existing TS errors NOT addressed** (not in scope for auth gate, but on the punch list):
- `server/google-auth.ts:277,288,296,307` — `ga4properties.runReport` typings drifted; needs property/dimensions cast fixes.
- `server/routes.ts:406` — `current_period_end` removed from Stripe Subscription; access via `items.data[0]`.
- `shared/schema.ts:2404` — drizzle call signature mismatch (schema is unused in this repo, candidate for deletion).

**Pending — set these env vars before deploying:**
- `OPS_ADMIN_REDIRECT_URI=https://ops.fitscript.me/api/ops/auth/callback`
- `OPS_SESSION_SECRET=<random 32+ byte secret>`
- `ADMIN_EMAILS=paulclotar@gmail.com,...`
- Add the new redirect URI to the Google OAuth client's Authorized Redirect URIs in GCP console.

**Pending — not pushed yet** per "don't push without approval" rule. Need to test with .env locally before pushing.

**Next session:** verify locally with real .env, then push, then move to P1 connectors (Klaviyo first).

---

## 2026-05-06 (continued) — TS cleanup, drizzle removed

**Worked on:** Cleared every pre-existing TypeScript error so we have a clean baseline going forward.

**Changed:**
- Deleted `shared/schema.ts` (2400+ lines of unused Drizzle schema) and `server/schema.ts` (re-export stub). Confirmed via grep that no runtime code imported either — `db` (the drizzle instance) was exported from `server/db.ts` but never used; every consumer imports `pool`.
- `server/db.ts` — removed `drizzle` import + `db` export. Now only exports `pool` and `verifyConnection`.
- `server/routes.ts:406` — Stripe moved `current_period_end` from `Subscription` to `SubscriptionItem` in the 2025 API version. Now reads `sub.items.data[0]?.current_period_end`.
- `server/google-auth.ts:284,303` — googleapis `runReport.limit` expects string, not number. Changed `20` → `"20"`, `15` → `"15"`.
- `client/src/vite-env.d.ts` (new) — ambient declarations for `*.png` / `*.jpg` / `*.svg` imports so `tsc --noEmit` doesn't choke on the logo asset.
- `package.json` — removed `drizzle-orm`, `drizzle-zod`, `zod` (zero usage after schema deletion).

**Verified:** `npx tsc --noEmit` exits 0. `vite build` + `esbuild server/index.ts` both succeed. Server bundle dropped from 137.7kb → 53.6kb after dropping drizzle.

---

## 2026-05-08 — Klaviyo connector v1 (read-only) + dev DX overhaul

**Worked on:** P1 in the autonomy roadmap — first external connector. Plus a few dev-environment fixes that came out of testing locally.

**Klaviyo connector (server):**
- `server/klaviyo.ts` (new) — `KlaviyoClient` style fetch wrapper with rate-limit-aware 429 retry, pinned API revision `2025-04-15`, key from `KLAVIYO_API_KEY`. Endpoints: `/api/ops/klaviyo/status`, `/campaigns`, `/flows`, `/lists`, `/segments`. All gated by the existing admin gate. Also exports `trackKlaviyoEvent()` for future server-side autonomy jobs (not yet exposed via HTTP).
- `server/index.ts` — registers Klaviyo routes after the gate.

**Klaviyo connector (client):**
- `client/src/pages/email.tsx` (new) — fills in the previously-empty `/email` sidebar slot. Connection status chip, 4-stat strip (campaigns / sent / live flows / lists+segments), tabbed Campaigns/Flows/Lists tables. Graceful "not connected" state when `KLAVIYO_API_KEY` is unset.
- `client/src/App.tsx` — wired the `/email` route.
- `client/src/pages/integrations.tsx` — replaced the "Coming soon" Klaviyo tile with live status (Connected / Not configured / Connection error).

**Dev DX changes:**
- `server/index.ts` — Vite is now mounted as Express middleware in dev mode (single-port `npm run dev` on 5001 with full HMR). No more dual `tsx` + `vite` setup, no proxy. Prod path unchanged.
- `server/db.ts` — SSL config now `rejectUnauthorized: false` for any URL not opting out via `sslmode=disable`. Local Node didn't trust the AWS RDS cert chain; this matches how the existing Neon path already worked.
- `.gitignore` — added `.env.*` so backup .env files from local cleanup don't show up in `git status`.

**Verified:** `tsc --noEmit` clean. `vite build` + esbuild green. Login flow tested locally end-to-end (Google OAuth → callback → cookie → dashboard). Klaviyo Email page renders the "not connected" placeholder when key is absent (was the local state during testing).

**Lesson learned for memory:** the AWS Console "Plaintext → copy" of a JSON secret pastes the contents *with their JSON syntax* — every value ends up wrapped in `"` and followed by `,` when piped into a `.env`. Three concrete bugs from this on Paul's local .env: corrupted `DATABASE_URL` (URL parse failure → garbage hostname), corrupted `OPS_PORT` → NaN crash on `app.listen`, corrupted `GOOGLE_CLIENT_ID` → Google "invalid_client" rejection. Also created duplicate keys (last write wins via dotenv), with the corrupted copy winning. Future .env builds from prod secrets must dedupe + strip both wrapping quotes AND trailing commas.

---

## 2026-05-08 (continued) — Klaviyo send capability (Option A: template trigger)

**Worked on:** Promoted Klaviyo from read-only to send-capable. Dashboard becomes the action layer; Klaviyo stays the design layer.

**Server (`server/klaviyo.ts`):**
- `GET /api/ops/klaviyo/templates` — list email templates with editor type + updated time
- `GET /api/ops/klaviyo/templates/:id/html` — fetch raw template HTML for preview iframe
- `POST /api/ops/klaviyo/audience-size` — given list/segment IDs, returns total + breakdown via `additional-fields[list]=profile_count` and `additional-fields[segment]=profile_count`. Documented as upper-bound (Klaviyo dedups at send time).
- `POST /api/ops/klaviyo/send` — multi-step orchestration: create campaign + message → assign-template → submit send-job. Validates inputs, writes audit row to `ops_campaign_sends` BEFORE attempting send, updates row with `status=submitted` + Klaviyo campaign ID on success or `status=failed` + error on failure. Logs `[OPS][KLAVIYO] send submitted by ${admin}`.
- `GET /api/ops/klaviyo/sends` — recent 50 audit rows for the dashboard's Recent Sends tab.
- `ensureSendsTable()` — creates `ops_campaign_sends(id, admin_email, klaviyo_campaign_id, name, subject, audience_summary jsonb, send_method, scheduled_for, recipient_count, status, error, created_at, updated_at)` lazily on first call.

**Client (`client/src/pages/email-send.tsx`, new):**
- 4-step composer at `/email/send`: Template → Audience → Compose → Confirm.
- Step 2 shows live audience-size estimate as user toggles lists/segments + per-audience breakdown + optional excluded segments.
- Step 4 shows side-by-side: send summary (template, recipient count, when, from) + email preview rendered via `srcdoc` iframe.
- **Safety rail**: if recipient count ≥1000, requires typed "SEND" string before the send button enables. Threshold tunable via constant.
- Default sender pre-fills from Klaviyo account info.

**Email page (`client/src/pages/email.tsx`):**
- Header gains a "Send campaign" CTA (only shown when Klaviyo is connected).
- New 4th tab "Recent sends" — surfaces the audit log with admin email, status (queued/submitted/failed), method, recipients, error.

**Verified:** `tsc --noEmit` clean. `vite build` + `esbuild` green. Server bundle now 67.8kb.

**Local browser test (paulclotar@gmail.com → 1-person Internal Test list):** end-to-end send works. Email arrived in inbox. Audit log row recorded with `status=submitted` and Klaviyo campaign id.

**Six Klaviyo API gotchas surfaced during testing — all fixed:**

1. `/templates/` page[size] caps at **10** (other endpoints allow 50-100). Was using 100 → 400 "Page size must be an integer between 1 and 10".
2. `/lists/` page[size] caps at **10**. Was 100 → same error. Lists are paginated; cap stays low.
3. `/segments/` page[size] caps at **10**. Same.
4. `/flows/` page[size] caps at **50**. Was 100 → "Page size must be an integer between 1 and 50".
5. `/campaigns/` sort field allowlist is `[scheduled_at, created_at, updated_at, id, name]` — **`send_time` is NOT valid** despite being a returned attribute. Switched to `-scheduled_at`.
6. `/campaigns/{id}/campaign-messages/` sparse fieldset rejects `label` — `label` lives inside `definition`, not as a top-level field. Dropped the fields filter; we only need `id` anyway.

Plus two send-orchestration path bugs:

7. `assign-template` is **NOT** at `/campaign-messages/{id}/assign-template/` — it's a top-level action endpoint at `/campaign-message-assign-template/` with the message id in the body.
8. Success-screen "Open in Klaviyo" link used `https://www.klaviyo.com/campaign/{id}` (404). Correct: `https://www.klaviyo.com/campaign/{id}/reports/overview`.

**Frontend resilience bug (also fixed):** `templatesData?.templates.find(...)` chained one level short — when the templates endpoint returned an error JSON `{error: "..."}` instead of `{templates: [...]}`, `.find` blew up. Now `templatesData?.templates?.find(...)`.

**The frontend was also silently swallowing 400s from the connector** — error responses became `{error: "..."}`, but the queries pulled `data?.field ?? []` which falls back to empty arrays. Looked like "Klaviyo is empty" when in fact every read was failing. Worth a future hardening pass: add an error path in the read pages.

**Deliberately deferred:**
- Throttled send method (`send_strategy=throttled` with delivery window).
- Customer-defined sender email (currently uses Klaviyo's account default).
- Campaign-level metrics post-send (opens/clicks/revenue) — still on the v1.5 roadmap.
- Surfacing connector errors visibly on read pages (currently empty-state masks them).

---

## 2026-05-15 — Unit Economics (Phase 1): per-user + platform AI cost vs revenue

**Worked on:** Backlog audit + brand-new unit-economics surface so Paul can see "what each user costs us in AI vs what they pay" and "platform AI spend vs revenue."

**Backlog snapshot (cataloged at start of session):**
- Broken sidebar nav: `/content`, `/creative`, `/clinical` linked from `ops-layout.tsx:7-17` but no routes/pages exist.
- Stubbed integration tiles on `/integrations`: Meta Ads, Google Ads (lines 274-275 of `integrations.tsx`).
- Klaviyo v1.5 polish deferred: throttled send, custom sender, post-send metrics, visible 4xx error surfacing.
- `server/routes.ts:100` waitlistCount hardcoded `0` (TODO).
- No `ops_admin_actions` audit table — every cancel/refund/pause/comp through dashboard is unaudited.
- Tracking depth gaps per the Hyros-style spec in `project_fitscript_tracking_system.md`.

**Phase 1 — ops dashboard work (this repo):**
- `server/economics.ts` (new) — `getPlatformEconomics(days)`, `getMemberEconomics(userId)`, `getMembersMtdCostMap()`. Detects `ai_costs` table existence at runtime; runs UNION over `atlas_turn_analytics + ai_costs` when present, falls back to Atlas-only otherwise. Coverage flag returned in every response (`"atlas_only"` vs `"all_surfaces"`) so the UI can label honestly.
- `server/index.ts` — registered `registerEconomicsRoutes(app)` after the admin gate.
- `server/routes.ts` — `/api/ops/members` now injects `aiCostMtd` and `marginPct` per row using `getMembersMtdCostMap` (one bulk query, no N+1).
- `client/src/pages/members.tsx` — new sortable columns (AI Cost MTD, LTV, Margin %). Click header to sort, click again to clear.
- `client/src/pages/member-detail.tsx` — new "AI Economics" card with 5 KPIs (cost MTD/LTD, avg/turn + latency, revenue, cost/revenue ratio), plus model mix + 30d sparkline. Color-coded threshold: <20% green, <50% amber, else red.
- `client/src/pages/command-center.tsx` — new "Unit Economics — Last 30 Days" tile with Revenue MTD / AI Cost MTD / Gross Margin / Cost per User, plus top-5 highest-cost users (click-through to their detail page).
- `client/src/components/charts/cost-vs-revenue-chart.tsx` (new) — Recharts ComposedChart (Area for revenue, Line for AI cost on right axis), with 30/60/90d toggle. Mounted at top of `/tracking`.

**Coverage gating:** every economics surface shows `"Atlas chat only · other AI surfaces pending instrumentation"` until `ai_costs` table contains rows from non-atlas surfaces.

**Phase 2 — FitScript instrumentation (delegated to agent, uncommitted in `/Users/clomark/Projects/fitscript`):**
- `scripts/migrations/2026-05-15-ai-costs.sql` — DDL for `ai_costs(id, user_id, surface, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, latency_ms, metadata, created_at)` + 3 indexes. **APPLIED to RDS this session** (additive `IF NOT EXISTS`).
- `server/services/aiCostLogger.ts` (new) — Anthropic + Titan-Embed pricing, cache math mirrors `atlasAnalytics`, raw `pool.query` insert wrapped in try/catch.
- 8 surfaces instrumented: `meal_vision`, `lab_analysis`, `lab_narrative`, `protocol`, `embedding`, `ai_service`, `atlas` (dual-write — preserves existing `atlas_turn_analytics`), `atlas_classifier`, `atlas_title`.
- Files touched: `mealVisionService.ts`, `labAnalysisService.ts`, `labProcessingService.ts`, `protocol-engine.ts`, `rag/embedding-service.ts`, `aiService.ts`, `atlasAnalytics.ts`, `aiAdvisorService.ts`, `routes.ts` (userId threading).
- Verification: `npx tsc --noEmit` → zero new errors in touched files (120 pre-existing unrelated). `npm run build` → clean.

**Verified live:**
- `npx tsc --noEmit` in ops-dashboard → clean.
- `npm run build` → clean (742kb client gz 199kb; 78.8kb server bundle).
- Dev server bound to `localhost:5001`. `/api/health` returns ok. `/api/ops/economics/platform?days=30` correctly 401s through the auth gate.
- Direct SQL replay confirms `cost_mtd: $0.7588 across 1 user (paulclotar@gmail.com, 19 turns)`. LTD `$1.19`. Top users + members map + UNION query all return correct shape.
- `ai_costs` table created on RDS with all 4 indexes (`pkey`, `user_created`, `surface_created`, `created`).

**Pending — not pushed yet (per "Don't push without approval"):**
- ops-dashboard: all 6 file edits + 1 new endpoint + 1 new chart component.
- fitscript: 9 service edits + 2 new files. Paul needs to local-test that AI surfaces still respond before pushing.

**Next session:**
1. Paul browser-verifies all 4 surfaces on `localhost:5001`.
2. Push ops-dashboard.
3. Local-test fitscript AI surfaces (Atlas, meal photo, lab upload, protocol gen) to confirm `logAiCost` doesn't crash anything.
4. Push fitscript → ECS deploy → `ai_costs` starts populating from all 8 surfaces → coverage flag flips to `"all_surfaces"`.
5. Then move to whatever's next in the backlog (Meta Ads or `/content` page were the impact-ordered candidates).

---

## 2026-05-19 → 2026-05-20 — Tracking pixel + Meta Ads + Admin Audit + Email Hub polish + Full day plan

Big arc. Closes the tracking infrastructure loop, adds two new connector families, ships the Email Hub deferred polish, then a full focused day on Google connect + leads + Clomark bridge.

### Commit ledger (this repo, chronological)

```
302ad35  Add CORS to /api/t/* for tracking pixel ingest
8af3cf9  Apply QueryError pattern to /email, /tracking, /marketing
ec5a996  Add Klaviyo throttled send strategy
0bba2df  Add Google connect health, /leads, GA4 on Marketing, GSC on /content
fb5d852  Add Clomark connector + surface on /content
```

Plus, in companion repos:
- `fitscript` (markappz/Humn-Health): `08edc0c7` — first-party tracking pixel + server-side revenue notify
- `ClomarkNexus` (mujtabams/ClomarkNexus): `5bdd9264` — `/api/ops/*` read-only API for downstream dashboards

### What landed (arc by arc)

**1. First-party tracking pixel went live (2026-05-19).** `client/src/lib/tracking.ts` in fitscript: visitor_id 2-yr cookie, session_id 30-min timeout, UTM capture, page_view + custom events, SPA route patching, sendBeacon w/ fetch fallback. `initTracking()` in main.tsx, `identifyUser()` on auth resolution (useAuth.ts), server-side `notifyOpsRevenue` + `notifyOpsEvent` from Stripe webhook (`server/lib/opsTracking.ts`). ops-dashboard side added CORS to `/api/t/*` for cross-origin from fitscript.me. Verified end-to-end against local DB.

**2. QueryError pattern rolled out** to `/email` (all 4 tabs), `/tracking` (funnel + attribution + campaigns), `/marketing` (top + Meta Ads section). Existing `<InlineError>` + `hasApiError` type-guard now consumed across the pages where silent empty-state was masking 4xx.

**3. Klaviyo throttled send.** 4th send method (alongside immediate / static / smart_send_time). Backend accepts `throttlePercentage` (1-100); frontend presents 5 preset durations (2h/4h/8h/12h/24h) mapped to Klaviyo's percentage. UI surfaces the percentage in Step 3 hint + Step 4 summary + success screen. Critical for larger sends — Gmail penalizes burst patterns.

**4. Day plan — 5 blocks (2026-05-20).**

- **Block 1: Google OAuth verified + health visibility.** Fixed callback redirect (`/integrations` not `/settings` — where the toast lives). Preserved existing refresh_token across re-connects (Google only issues on first consent). Preserved GA4 property + GSC site across re-connects. New integration-health strip on Command Center (Google/Klaviyo/Meta dots, top-right) — appears only when something's disconnected, click → /settings. Settings page row distinguishes "Configured" (env vars) from "Connected" (OAuth completed) with badges + inline "Connect now →" link.

- **Block 2: GA4 on Marketing.** New "Google Analytics 4 (last 30d)" card on `/marketing`. 4 KPI tiles (sessions/users/page views/avg bounce), daily traffic AreaChart (sessions area + users line), traffic-by-channel breakdown, top pages. Cross-validates the first-party tracking pixel.

- **Block 3: GSC on /content.** Replaced the "Planned" placeholder with `pages/content.tsx`. 4 KPI tiles (clicks/impressions+CTR/avg CTR/avg position with first-page hint), daily search performance ComposedChart (impressions area + clicks line on dual axes), top queries + top pages tables with position color-coded (green ≤10, amber ≤20, muted deeper). 7d/30d/90d toggle. Verified live: 1,633 clicks / 472k impressions / 1.3% CTR / position 8.0 over 30d.

- **Block 4: /leads section.** New `pages/leads.tsx` + `server/leads.ts`. 4 status tiles (Paid/Hot/Engaged/Cold — clickable filters), funnel viz (visitor → quiz → signup → paid with conversion %), source dropdown auto-populated, lead table with status pill, name/email/visitor_id, sessions, revenue, first/last touch dates. Signed-up rows click through to member detail. Empty-state messaging when tracking tables haven't populated yet. Auto-classifies leads: Paid (revenue), Hot (signed up + lab/quiz/3+ sessions in last 14d), Engaged (signed up OR 3+ sessions OR quiz), Cold (1-2 sessions).

- **Block 5: Clomark bridge.** Two-part shipment:
  - **5a (ClomarkNexus repo)**: new `server/ops-api.ts` — bearer-token-authed `/api/ops/*` surface. Endpoints: status, business by-website, business by-id, keywords (with rank-position bucketing since live schema has no `status` col on `keyword_analysis`), content (suggestions + generated with `approvalStatus` for generated), seo-score (latest + 30-pt trend with `totalScore` normalized as `overallScore`), activities. CORS scoped to `ops.fitscript.me` + localhost dev ports.
  - **5b (this repo)**: `server/clomark.ts` connector. Env: `CLOMARK_BASE_URL` + `CLOMARK_OPS_TOKEN` + `CLOMARK_BUSINESS_ID`. `/api/ops/clomark/{status,discover,overview,keywords,content,activities}` with 8s timeout. New ClomarkSection at top of `/content` (above GSC card) — 4 KPI tiles (SEO Score/Keywords/Content Suggestions/Generated Content), 3-column breakdown (keyword pipeline by position, content status with color dots, recent AI activity timeline). Multi-stage empty state guides the operator through 5-step setup. New Settings integration row.

### Setup gotchas observed

- **`pg-types` parses TIMESTAMP WITHOUT TIME ZONE in Node's local TZ by default.** Override OID 1114 to treat naive timestamps as UTC. Pacific dev box was shifting every read by +7h ("-25042s ago" in admin log) — fixed.
- **First char of bearer token dropped during copy-paste** — verify length after pasting (`openssl rand -hex 32` = 64 chars; Paul's pasted value came back 63).
- **Replit Workspace secrets DON'T sync to Autoscale Deployment secrets.** Must add to BOTH or just the Deployment one. Plus Autoscale doesn't auto-deploy on GitHub push — must hit Redeploy.
- **GA4 / GSC require Google Cloud APIs to be enabled** in the OAuth client's project. Three APIs needed: `analyticsadmin`, `searchconsole`, `analyticsdata`. Setup link: `console.developers.google.com/apis/api/<api>.googleapis.com/overview?project=<project_number>`.

### Live state (2026-05-20 end-of-day)

- Google: `pc@realpeptides.co` connected, GA4 property `483543652` (Fitscript), GSC site `sc-domain:fitscript.me`
- Klaviyo: `pk_V3sni5_…755b20de` with Campaigns:Full + Events:Full + Flows:Full + Templates:Full + everything-else Read
- Meta Ads: not configured (deferred — needs `META_SYSTEM_USER_TOKEN` from business.facebook.com)
- Clomark: connected to `clomark.ai` via Autoscale deployment, business ID `533eac81-2538-4ae8-9cc2-b578587cbcad` (Fitscript), token shared via Replit Deployment secret. Showing 3 content suggestions (generated status), 2 drafts pending approval, 0 keywords tracked yet, SEO score 0 (initial entry from April).
- Tracking pixel: deployed, accumulating data slowly (touchpoints + visitor_sessions tables exist but light).

### Pending / next session

- **Verify tracking pixel data flowing in prod.** Watch `/leads` and `/marketing` first-party rows over the next few days as visitors land on fitscript.me.
- **Meta Ads.** Generate System User token + ad account ID, add to .env. Connector is built and waiting (returns 503 with setup hint until configured).
- **Google Ads.** Still needs developer-token approval (1-3 day wait at `developers.google.com/google-ads/api/docs/first-call/dev-token`).
- **Revenue tracking gap.** Klaviyo dollar revenue stays $0 until a Shopify/Stripe integration is connected to Klaviyo OR FitScript's own attribution-derived revenue is computed in the ops dashboard. The first-party pixel + Stripe webhook revenue notify lays groundwork for path 2.
- **Cleanup:** orphan stale changes at `~/Projects/clomark` (markappz/clomark-platform fork — reverted but the local clone still exists). Optional `rm -rf ~/Projects/clomark` once memory is fully internalized.
- **Apply `QueryError` to remaining pages** as they're touched (Settings, Orders, Member detail — anywhere a useQuery silently empty-states on 4xx).

### What I'll remember next session (via memory)

- `[[reference_clomark_live_repo]]` — ClomarkNexus is live, markappz/clomark-platform is stale, schema diffs documented.
- `[[feedback_env_append_trailing_newline]]` — Don't use `>>` on .env without trailing newline guarantee (caused the Klaviyo key concatenation bug May 18).
- `[[project_fitscript_unit_economics]]` — `ai_costs` table architecture (May 15).
