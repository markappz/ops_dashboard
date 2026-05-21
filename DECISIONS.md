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

## 2026-05-08 — Klaviyo send: template-trigger model, never an in-dashboard composer

**Decision:** Klaviyo "send from dashboard" is a template-trigger product. Marketing designs templates in Klaviyo. Dashboard picks template → audience → schedule → confirm → send. The dashboard never builds an HTML composer or rich-text editor.

**Why:** Klaviyo's drag-and-drop editor is years of UX work. Rebuilding it inside the dashboard pulls focus off ops + creates ongoing maintenance debt as Klaviyo's editor evolves. The actual ops use-case is "send the right template to the right people right now" — the dashboard layer adds value at the audience-selection / safety-rail / audit step, not the design step.

**How to apply:** When extending email features, ask "is this about *who/when/why* a send happens?" → dashboard problem. "Is this about *what the email looks like*?" → Klaviyo problem, never solve here. Same rule applies to SMS / push when those land.

---

## 2026-05-08 — Send safety: typed-confirmation threshold + audit log

**Decision:** Sends to ≥1000 recipients require typing "SEND" to enable the submit button. Every send attempt — successful or failed — writes a row to `ops_campaign_sends` with the admin email, status, audience, recipient count, and any error.

**Why:** Marketing-team mistakes (wrong segment, wrong subject) are recoverable in Klaviyo's UI through the cancel-window. Cross-team mistakes from ops staff sending to wrong audiences are irrecoverable and expensive. Friction at high-volume is cheap insurance. Audit log gives postmortem clarity ("who sent the bad email") without needing Klaviyo's audit log access.

**How to apply:** Threshold lives in `TYPE_TO_CONFIRM_THRESHOLD` (`client/src/pages/email-send.tsx`). Tune up if it gets annoying for daily ops, or down if a near-miss happens. Server-side audit is non-negotiable — every new write action through the dashboard should append to a similar audit table (e.g. future `ops_admin_actions` for cancel/refund/comp).

---

## 2026-05-08 — Klaviyo connector is HTTP-only, key in env

**Decision:** Klaviyo lives under `/api/ops/klaviyo/*` behind the admin gate. Auth uses `KLAVIYO_API_KEY` (private `pk_*`) directly — no Klaviyo OAuth. API revision pinned to `2025-04-15`.

**Why:** Klaviyo's OAuth is for marketplace listings. We're an internal tool; private API keys are the right fit. Pinning the revision means contract drifts surface as our deliberate bump, not as silent breakage. Rate-limit retries are 429-aware with one Retry-After honoring; deeper backoff isn't worth the code until we hit it.

**How to apply:** New Klaviyo endpoints go in `server/klaviyo.ts` and use the existing `klaviyoFetch` wrapper. For server-side autonomy (push events, trigger flows), call `trackKlaviyoEvent()` directly — keep that out of the HTTP API since the dashboard never needs to expose write actions to clients.

---

## 2026-05-08 — Single-port dev via Vite middleware

**Decision:** `npm run dev` runs Express + Vite middleware on one port (5001) in dev. No separate `vite` process, no `/api` proxy in `vite.config.ts` (the entry stays for documentation but isn't used in dev). OAuth callback redirects to `/` and lands on the same React app the user logged in from.

**Why:** Dual-port dev (Express on 5001, Vite on 5173 with proxy) made the OAuth flow awkward — Google's `redirect_uri` had to point at one port, the React app lived on another, and post-login the user landed on the API port with no UI. Single port means the OAuth callback's `res.redirect("/")` lands on the same surface the React app is mounted on.

**How to apply:** Vite is conditionally imported in `server/index.ts` only when `NODE_ENV !== 'production'` so the prod build never bundles it. Vite stays in `devDependencies`. To run prod-style locally, use `npm run build && NODE_ENV=production node dist/index.js`.

---

## 2026-05-06 — Raw SQL only, no Drizzle in this repo

**Decision:** All DB access uses `pool.query()` (raw SQL). `server/schema.ts` exists as a stub; do not grow it.

**Why:** Drizzle ORM crashed in the ops-dashboard runtime previously (logged in cross-project memory `feedback_ops_raw_sql`). Cost a debugging session. Raw SQL is also the pattern already used throughout `server/routes.ts`.

**How to apply:** New endpoints write SQL directly. Schema-of-record lives in the main FitScript repo's Drizzle schema; ops only reads from those tables.

---

## 2026-05-15 — Unified `ai_costs` table + dual-write from Atlas

**Decision:** All AI surfaces in FitScript write per-call cost to a single `ai_costs(user_id, surface, model, input/output/cache tokens, cost_usd, metadata, created_at)` table. Atlas keeps writing detailed turn-level data to `atlas_turn_analytics` AND dual-writes a roll-up row to `ai_costs`. Ops dashboard reads via runtime-detected UNION (atlas_turn_analytics + ai_costs) so coverage upgrades automatically as instrumentation lands.

**Why:** Two tables would have required ops dashboard to maintain two parallel query paths forever, plus a third for any future surface. One unified `ai_costs` keeps the read path stable while still letting Atlas keep its rich classifier/cache analytics. The dual-write is intentional duplication — Atlas spend appears in both tables — but the ops dashboard's UNION dedupe is unnecessary because we report cost as `SUM(cost_usd)` over distinct sources, not row counts. Keeping `atlas_turn_analytics` untouched preserves all the per-turn metadata Atlas's own tooling reads.

**How to apply:** Any new Claude/Bedrock call site in FitScript imports `logAiCost` from `server/services/aiCostLogger.ts` and calls it after the API response, passing tokens + a stable `surface` name. The helper handles cost calc (mirrors `atlasAnalytics` cache math: reads at 10%, writes at 2.0x for 1h TTL) and is try/catch-wrapped so analytics failures never throw into the user path. Embeddings have their own `EMBEDDING_PRICING` map inside the helper since Titan isn't in `MODEL_PRICING`. Surface naming convention: `<feature>` or `atlas_<subroutine>`. New surfaces don't need ops-dashboard changes — they appear in the per-user breakdown via `surface` group-by automatically.

---

## 2026-05-15 — Economics endpoint reports coverage flag with every payload

**Decision:** Every economics response (`/api/ops/economics/platform`, `/api/ops/economics/members/:id`, members-list MTD injection) includes a `coverage: "atlas_only" | "all_surfaces"` field derived from `information_schema.tables` lookup of `ai_costs`. UI surfaces this verbatim with the label "Atlas chat only · other AI surfaces pending instrumentation".

**Why:** Reporting AI cost without disclosing which surfaces are counted creates the worst kind of dashboard — one that looks complete but isn't. If a session lands on `/command-center` and sees `Gross Margin: 99.5%`, that conclusion is meaningful only when the user knows we're only counting Atlas. Forced labeling prevents that misread. Once Phase 2 instrumentation deploys to FitScript prod and `ai_costs` fills with non-atlas rows, the flag flips automatically — no UI changes needed.

**How to apply:** Every new economics surface inherits this. Don't strip the flag from response payloads. Don't hardcode the UI to expect "all_surfaces" — render the literal flag value so future expansions (a third "all_surfaces_plus_embeddings_excluded" mode, etc.) need only a label-map update.

---

## 2026-05-20 — Clomark bridge = bearer-token ops API on Clomark, not DB read

**Decision:** ops-dashboard reads Clomark data via a new bearer-token-authed `/api/ops/*` surface on the Clomark side (live repo `mujtabams/ClomarkNexus`). NOT direct DB queries, NOT iframe embed.

**Why this and not alternatives:**
- **vs. direct DB read:** Tight coupling. Any Clomark schema change (e.g. `seoScores.totalScore` vs `overallScore`, or moving from `status` to `approvalStatus`) silently breaks ops-dashboard. Already documented schema drift between the live repo and the older `markappz/clomark-platform` clone — building a DB query against the latter would have shipped broken code to prod. The ops API is the contract; schema changes inside Clomark are absorbed at the boundary.
- **vs. iframe embed:** Loses the unified dashboard look and feel. Also doesn't compose with other ops-dashboard data (e.g. correlating Clomark content with GSC performance) since iframes are opaque.
- **vs. shared OAuth or per-user JWT:** Overkill for a single trusted internal consumer. Bearer token can be rotated by regenerating in Clomark's Deployment secrets + matching in ops-dashboard's .env.

**How to apply:**
- New Clomark data the ops dashboard needs → add an endpoint in `ClomarkNexus/server/ops-api.ts` (under `requireOpsToken` middleware), add a wrapper in `ops-dashboard/server/clomark.ts`, surface on a page.
- Surface naming convention: `/api/ops/business/:id/<resource>`. Resource scoped to the business profile so multi-tenant future is preserved.
- Token rotation: regenerate via `openssl rand -hex 32`, update Replit Deployment secret + ops-dashboard `.env`, restart both.
- Tables keyed by `userId` (seoScores, aiActivities, keywordAnalysis in the live schema) MUST resolve from the businessProfile.userId lookup first — the ops API hides this from the consumer.

---

## 2026-05-20 — Integration health surfaced where it matters, not just on Settings

**Decision:** Command Center top-right shows a slim integration-health strip (Google / Klaviyo / Meta dots) that appears ONLY when at least one is disconnected. Clicking it routes to `/settings`. Settings page distinguishes "Configured" (env vars present) from "Connected" (OAuth/token actually validated).

**Why:** A disconnected integration is invisible if you only check Settings periodically. Yesterday's "Google OAuth ✓ Configured" green dot when actually no OAuth row existed was the canonical confusion to avoid — env presence alone shouldn't read as healthy. Strip is opt-in noise — disappears entirely when all green, so it's never UI clutter for a fully-configured deployment.

**How to apply:** Future integrations (Google Ads, Webflow, anything else) should plug into the same strip. The pattern in `command-center.tsx` is: a `useQuery` per integration's status endpoint, then a row in the `integrations` array with `{name, connected: boolean, detail: string}`. The strip auto-includes new entries.

---

## 2026-05-20 — /content is the control plane, Clomark is the execution engine

**Decision:** `ops.fitscript.me/content` owns the operator-facing surface for SEO/AEO work — adding topics to the queue, viewing drafted content, approving or denying. Clomark stays the execution engine — keyword research pipeline, AI generation, scheduling, publishing integrations. New content-related capabilities surface in `/content` first; Clomark's own admin UI becomes a fallback for power-user / deep-config tasks.

**Why this and not alternatives:**
- **vs. just deep-linking to Clomark from ops dashboard:** Operator context-switches are expensive — the ops dashboard already holds the cross-functional view (revenue, leads, attribution, AI economics). Keeping content adjacent means a reviewer can correlate "this blog draft" with "this acquisition channel" without losing tab state.
- **vs. embedding Clomark UI via iframe:** Loses the unified design and prevents composition (e.g. showing GSC performance alongside the drafts that target those queries).
- **vs. forking Clomark's logic:** Schema drift, queue divergence, double-maintenance. The ops API contract (bearer-token-authed `/api/ops/*` on Clomark) absorbs schema changes at the boundary so the dashboard doesn't break when Clomark adds columns.

**How to apply:**
- Any new content capability follows the pattern: 1) add proxy endpoint to ClomarkNexus's `server/ops-api.ts` (mirroring the existing session-authed handler's logic but with bearer-token auth), 2) add proxy in `ops-dashboard/server/clomark.ts`, 3) UI lands on `/content`.
- **Single source of truth for content state lives in Clomark's DB.** Ops dashboard reads via the API; never writes directly. Approvals, publish status, queue state all roundtrip through the API.
- **Clomark gets the same upgrades for free** — other clients running Clomark (Real Peptides, etc.) can adopt the same bearer-token approach to build their own dashboards if needed.
- **Auto-refresh on /content** — 15s default polling, 5s when any item is `in_progress`. Don't drop below 5s without checking Clomark's rate limits; the AI generation is expensive and Clomark's queue endpoints aren't designed for high QPS.

---

## 2026-05-20 — Bearer-token ops API never duplicates business logic

**Decision:** When adding endpoints to ClomarkNexus's `server/ops-api.ts`, prefer to **call the same internal services** (e.g. `QueueService.addToQueue`, `storage.getActiveBusinessProfile`) that the existing session-authed routes use. Don't reimplement queue logic, dedup logic, AI generation orchestration, or business-rule validation in the ops API surface — those are business invariants that should not drift.

**Why:** Each duplication is a bug waiting to happen. When `add-location-page`'s session-authed handler adds support for a new field (e.g. `marketTier` defaults change, secondary keyword limits adjust), the bearer-token mirror won't pick it up automatically. Discovered this risk while building `POST /api/ops/business/:id/location-page` — first instinct was to duplicate the QueueService body shape; instead, the endpoint now imports and calls `QueueService.addToQueue` directly with the same params.

**How to apply:**
- New ops API endpoints that write or mutate: extract the existing handler's body into a shared helper if it's not already a service call. Then call the helper from both auth flavors.
- New ops API endpoints that read: prefer direct DB queries (no business logic to duplicate, just SELECT with bearer-auth scope). Pattern already used for status / list endpoints.
- **Exceptions:** When the session-auth handler does session-specific things (like setting `userId` from `req.user!.id`), the ops endpoint must derive equivalent context another way (typically from a business profile lookup via the URL param). Document the equivalence inline.

---

## 2026-05-20 — Empty data state rules (don't render zero KPI tiles)

**Decision:** When a data source hasn't accumulated meaningful data yet (e.g. the tracking pixel was deployed but no visitors have hit it, or a connector isn't wired), DO NOT render zero-valued KPI tiles or stale "Not Connected" cards. Instead, hide the affected section entirely and surface a slim contextual notice explaining the state. The visible parts of the page must reflect actual capability.

**Why:** Caught this on `/marketing` on 2026-05-20. Page had:
- 4 large "$0 / 0 / 0%" KPI tiles at the top (pixel-based attribution)
- Two giant "Not Connected" cards for GA4 and GSC at the bottom — hardcoded fictional status, ignoring the actual real connection
- Four empty channel-group tables (Search / Social / AI / Paid) showing "No data for this channel group yet"

All of that visually read as "the dashboard is broken" even though GA4 was returning real data (49 sessions / 472K impressions) in the middle of the page. The zero tiles framed every working surface as also-broken-looking.

The fix: only render the top KPI grid when `totalVisitors > 0`. Only render channel-group tables when their channels array is non-empty. Replace the "Not Connected" hardcoded cards with the source of truth (the integration-health strip on Command Center + the /integrations page). When pixel data is empty, surface a one-line amber notice that explains the state without taking up real estate.

**How to apply:**
- **No zero-KPI tiles** — gate every metric grid on `if (sourceHasData) render(...)`. Show a one-line state notice as the alternative, not 4 zeros.
- **No hardcoded "Not Connected" cards** — connection state must come from the live `/api/ops/connections` (or equivalent) endpoint, never hardcoded inline. If you find a hardcoded one, treat it as a bug.
- **No empty-state placeholder tables** — render `null` or hide the surrounding section; don't draw a card with "No data" inside it. Operators infer broken-ness from rendered-but-empty UI.
- **Lead with what works** — surfaces with real data go above surfaces with empty state. Reorder when a new working section ships so the visual hierarchy stays honest.
- **Connection state lives in one place** — Command Center integration-health strip + `/settings` Integrations table + `/integrations` per-service detail. Other pages reference; they don't redeclare.

---

## 2026-05-20 — Brand system: navy / sky-blue / white, green retired from ops

**Decision:** Ops dashboard mirrors the new FitScript marketing brand. Primary palette is **brand-navy (`#0A1628` core)** + **brand-blue (`#2E5BFF` interactive accent)** + **brand-sky (`#E8F0FA` page wash)**. Green is **retired** — the legacy `fitscript.green` Tailwind token is kept as an alias that points at `#2E5BFF` so the 200 historical references rebrand automatically.

**Why this and not alternatives:**
- **vs. keeping green selectively (success indicators, "OK" badges):** Mixed palettes weaken the brand. The FitScript marketing screenshots have one tiny green callout ("Save 17%" in pricing); everything else is navy/blue/white. Ops dashboard should read the same. Status indicators that need "good" use brand-blue; "bad" uses red; warnings use amber. The semantics are intact without the color drift.
- **vs. rewriting every `fitscript-green` reference individually:** 200 references across 20 files. Remapping the token is one-line and accomplishes the same visual outcome with near-zero risk. New code uses `brand.*` tokens directly.
- **vs. a separate dark vs. light "brand mode":** Both modes share the same brand. Dark mode is navy surfaces with brand-blue accent (`#5C7FFF` lifted for contrast); light mode is white surfaces with brand-blue accent (`#2E5BFF`) on sky-50 wash. Same gradient logic across both.

**How to apply:**
- New code uses `brand.navy.*` / `brand.blue.*` / `brand.sky.*` directly. Don't reach for `fitscript.green` — it's a compatibility shim, not a brand color.
- Hero treatments use the `PageHero` component (eyebrow + title + subtitle + actions). Don't hand-roll page headers.
- Active-state CTAs use `bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white` with a soft brand shadow (`shadow-[0_4px_14px_-4px_rgba(46,91,255,0.5)]`).
- Status semantics: brand-blue = OK/success/active. Red = failure. Amber = warning/throttle. Don't reintroduce green even for "healthy" — brand-blue is the success color.
- Chart fills/strokes use brand colors (`#2E5BFF`, `#5C7FFF`, `#9FB6FF`). Per-platform brand colors (Google `#4285F4`, Meta `#1877F2`, etc.) stay accurate in channel-specific views.

---

## 2026-05-20 — Sidebar IA: 4 grouped sections, 9 active items

**Decision:** Sidebar is organized into 4 labeled sections — **Overview** (Command Center), **Customers** (Leads / Members / Orders), **Growth** (Marketing / Content & SEO / Email), **System** (Integrations / Settings) — with section headers in muted uppercase tracking. Flat 14-item nav from v1 is retired.

**Why this and not alternatives:**
- **vs. flat list:** 14 unsectioned items overwhelms the eye and makes scanning slow. Operators don't think "where's the email page?" — they think "I'm doing growth stuff, where's email?" Grouping mirrors that mental model.
- **vs. collapsible sections:** Adds interaction for no real estate savings on a ~700px tall sidebar. 4 labels + 9 links comfortably fit without scrolling. Keep it static, keep it scannable.
- **vs. customer-routes-first:** Top-of-funnel→bottom-of-funnel order (Leads → Members → Orders) within Customers matches the customer journey. Within Growth, Marketing (the broadest channel page) leads, then Content (SEO), then Email (1:1). Same logic.

**Customer journey order is locked:**
- Customers: Leads → Members → Orders (acquisition → conversion → fulfillment)
- Growth: Marketing → Content → Email (broadest channel → SEO → 1:1)
- System: Integrations → Settings (connect → configure)

**How to apply:**
- New top-level pages must slot into an existing section. If a candidate doesn't fit Overview/Customers/Growth/System, that's a signal the scope is unclear or a new section needs an explicit decision (don't drop it as a placeholder in nav).
- Sub-pages (e.g. `/members/:id`, `/email/send`, `/email/compose`) inherit their parent's section in the breadcrumb but don't get their own sidebar entry.
- Placeholder/coming-soon pages are NOT visible in nav. Routes can exist for deep-linking but never appear as sidebar items — half-built nav makes the dashboard read as half-built.

---

## 2026-05-20 — Tracking absorbed into Marketing, Admin Log into Settings (no duplication)

**Decision:** Funnel + cost/revenue + first-party channel attribution + campaign performance + pixel setup ALL live on `/marketing` as a single channel performance surface. `/tracking` is a redirect. Admin Log lives as a tab under `/settings`. `/admin-actions` is a redirect.

**Why this and not alternatives:**
- **vs. keeping /tracking distinct:** Both pages were already showing overlapping funnel + channel attribution data. Two doors to the same room confuses operators (which one is authoritative?). Merging makes Marketing the unambiguous home for channel performance.
- **vs. keeping /admin-actions in top-level nav:** It's an audit/security artifact, not a daily operator surface. Top-level placement implied parity with Marketing or Email. Tab under Settings is the correct affordance level.
- **vs. deleting /tracking + /admin-actions outright (404 on deep links):** Bookmarks + memory references would break. Redirects preserve link integrity for free.

**How to apply:**
- New attribution / funnel / campaign / pixel work goes on `/marketing`. Don't create a sibling page for "advanced tracking."
- New audit / admin-action surfaces go as tabs on `/settings` (alongside General, Integrations, Admin Log). Don't add a new top-level "Audit" page.
- Redirects in `App.tsx` are the standard pattern for "page moved" — never delete a route without adding the redirect.
