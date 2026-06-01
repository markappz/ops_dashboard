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

## 2026-05-20 — Concierge architecture: single tool-use endpoint, registry pattern

**Decision:** The Ops Concierge runs on a single endpoint `POST /api/ops/concierge/chat` that executes a Claude tool-use loop. Tools are defined as `{name, description, input_schema, handler}` objects in a single `TOOLS` array. Adding a new tool = append one entry. No per-tool endpoint, no separate tool dispatch service.

**Why this and not alternatives:**
- **vs. per-tool REST endpoints the model calls via HTTP:** Adds latency (extra HTTP roundtrip per tool), forces every tool to re-cross the admin gate, complicates testing. The in-process handler is faster and simpler — same security model since the entire concierge endpoint is admin-gated.
- **vs. function-calling abstraction libraries (langchain etc.):** Anthropic's native tool-use API is already perfect for this. Adding a framework is dead weight + version churn risk + obscures what's actually happening in the loop.
- **vs. tool definitions colocated with each business module:** Tempting (e.g. `server/klaviyo.ts` exports its own tools), but you lose the registry overview — operators can't see what the concierge can do without grepping. Centralized registry in `server/concierge.ts` is the single source of truth for capability.
- **vs. streaming the response:** SSE adds complexity for marginal UX gain on a question-answer use case (most responses arrive in <5s). If users start asking longer multi-tool questions where wait feels long, add streaming then. Not now.

**How to apply:**
- New read tool: append `{name, description, input_schema, handler}` to `TOOLS` in `server/concierge.ts`. Handler must be `async (input) => unknown` returning JSON-serializable data. Schema is JSON Schema (Anthropic's spec).
- New write tool (Phase 2): same shape, but MUST also write an audit row to `admin_actions` table within the handler. Pattern: `{admin_email, action_type, target_kind, target_id, status, error}`. The handler should derive admin_email from a closure capture or by passing it through (the endpoint has `req.adminEmail`).
- Don't grow handlers past 30 lines. If a tool needs more, extract a helper. Keep the registry scannable.
- Cost: every concierge turn logs to `ai_costs` with `surface=ops_concierge` + metadata `{admin, tool_count, iterations}`. Do NOT log per-tool — turn-level rollup is the right granularity.

---

## 2026-05-20 — Concierge UX: floating launcher + ⌘K + slide-out panel (no full-page chat)

**Decision:** Ops Concierge surfaces as (1) a floating brand-gradient pill bottom-right on every page, (2) a ⌘K / Ctrl+K keyboard shortcut, and (3) a right-side slide-out panel (480px wide) that both surfaces open. NO full-page chat route. NO embedded chat on dashboard pages.

**Why this and not alternatives:**
- **vs. dedicated /concierge page:** Forces context switch away from the data you're staring at. The point of the concierge is to ANSWER QUESTIONS ABOUT WHAT'S ON SCREEN — moving away from it defeats the use case.
- **vs. embedded panel always-on next to page content:** Steals real estate from data tables that need full width. Side-by-side works only for narrow content (one-column dashboards), and ours are wide.
- **vs. command palette only (⌘K, no floating button):** Discoverability problem for first-time users. The floating pill says "AI is here" without any reading. Once operators learn ⌘K they use it; the pill becomes vestigial but harmless (it's bottom-right).
- **vs. floating chat bubble (Intercom style) without ⌘K:** Power-user friction. Operators who use the concierge constantly want to summon it without leaving the keyboard.

**How to apply:**
- All concierge UI lives under `client/src/components/concierge/`. Don't sprinkle concierge widgets elsewhere on pages.
- The launcher is mounted ONCE in `OpsLayout` so it's always available without per-page wiring.
- New shortcuts should be documented in the panel header subtext (currently shows "Ask anything · ⌘K to toggle"). Add `?` or `/` shortcuts in Phase 2 if useful, but never reach for new modal patterns — this one panel is the home for all concierge interaction.
- Empty state lists 5 example prompts. When adding tools, ADD a new example prompt that exercises that tool so operators discover the capability without reading the system prompt.

---

## 2026-05-20 — Concierge Phase 1 = read-only; writes are Phase 2 with audit + confirm

**Decision:** Ship Phase 1 with read-only tools only (13 tools). Write tools (pause flow, refund, cancel subscription, approve content, publish) are Phase 2, gated on Paul's validation of Phase 1 UX. All write tools, when added, MUST write an `admin_actions` row before the side effect and require typed-confirmation for high-impact writes (refund >$50, subscription cancel, bulk publish).

**Why this and not alternatives:**
- **vs. ship reads + writes together:** Risk = wrong UX for execution (confirmation flow, error surfacing, dry-run mode) baked in before we know how operators actually use the concierge. Read-first lets us observe usage patterns and design the write UX informed.
- **vs. read-only forever, force the existing per-page UIs for writes:** Defeats the "command center executor" use case Paul asked for. Phase 2 is real, just sequenced after Phase 1 lands.
- **vs. unrestricted writes:** Concierge has the same admin gate as the rest of the dashboard, but the chat affordance can make destructive actions feel low-stakes. Typed confirmation for refunds and subscription cancellations is non-negotiable. Audit row is non-negotiable.

**How to apply:**
- Phase 2 write tools follow this template inside the handler:
  1. Validate inputs.
  2. If above threshold (refund >$50, etc.), require `confirmation: "CONFIRM"` field in input — Claude includes it after asking the user.
  3. Write `admin_actions` row with `status='pending'` BEFORE executing.
  4. Execute the side effect (Stripe API call, Klaviyo PATCH, etc.).
  5. Update `admin_actions` row with `status='ok'` or `status='failed'` + error.
- Confirmation pattern is the model's responsibility too: the tool's `description` tells Claude "if amount > $50, ask the user to confirm with the word CONFIRM, then pass it as the `confirmation` field". The model handles the conversational ask; the tool enforces the gate.
- Reversible writes (pause flow, change tier) don't need typed confirm. Irreversible (refund, cancel, bulk publish) do.

---

## 2026-05-21 — DIRT is the ops AI name; Concierge retired

**Decision:** The ops dashboard AI is named **DIRT**. The label is the brand. Operators see "Ask DIRT", "DIRT is working…", `surface=ops_dirt` in analytics. The legacy term "Concierge" stays only as a back-compat endpoint alias.

**Why:** Paul wanted a punchy, memorable name. "DIRT" has alpha energy that matches the FitScript brand voice. It's short, easy to say, and reads as a real personality (not a generic "AI assistant").

**How to apply:**
- New UI strings always say DIRT, never Concierge.
- New endpoints go under `/api/ops/dirt/*`. `/api/ops/concierge/chat` stays only as the legacy non-streaming alias for back-compat — don't add new aliases.
- Cost surface is `ops_dirt` (not `ops_concierge`). Old surface data stays in `ai_costs` but new writes use the new name.
- CSS class is `prose-dirt`, animations are `animate-dirt-*`.

---

## 2026-05-21 — Streaming SSE over single-request for DIRT chat

**Decision:** Production DIRT chat uses SSE streaming. Event shape: `text_delta`, `tool_start`, `tool_result`, `tool_error`, `usage`, `done`, `error`. Client maintains an in-progress "streaming" assistant message that text deltas append to AND a per-message tool timeline that grows as tools execute.

**Why this and not alternatives:**
- **vs. one-shot non-streaming JSON:** Multi-tool turns can take 4-10s. With no streaming, the UI is dead for that whole window — feels broken. Streaming lets the user see "DIRT is using `get_snapshot`…" then watch numbers appear word by word. Premium UX.
- **vs. WebSocket:** SSE is one-way and simpler. We're not sending data from client to server mid-stream; we just want to stream responses out. WebSocket would add bidirectional complexity for zero benefit here.
- **vs. polling:** Adds latency, doubles request count.

**How to apply:**
- New DIRT capabilities that take time should emit intermediate SSE events. E.g., if we add a long-running batch tool, emit `progress` events along the way.
- Client must use `fetch` + `getReader()` for SSE (NOT EventSource) because we need to POST a body. EventSource is GET-only.
- Keep event payloads small — these are JSON-parsed every line. Tool result objects can be big, send them as one `tool_result` event but never stream a tool result piecewise.
- Always end with `done` event so client knows when to stop the "streaming" UI state.

---

## 2026-05-21 — Bedrock requires AWS creds in ECS task definition (not IAM task role)

**Decision:** Production ECS task definition for ops-dashboard MUST expose `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION` as `secrets[]` entries pointing into `prod/ops-secrets` (AWS Secrets Manager). Even though ECS Fargate provides an IAM task role automatically, our `@anthropic-ai/bedrock-sdk` instantiation in `server/lib/bedrock.ts` reads explicit env vars and won't fall back to the SDK default credential chain.

**Why:** First discovered when Paul reported "AI not configured" 503 in prod. The Secrets Manager JSON had the AWS keys but the task definition's `secrets[]` array didn't reference them, so the container booted without them. `isAIConfigured()` returned false because `process.env.AWS_ACCESS_KEY_ID` was missing.

Two ways to fix this long-term:
- (current) Continue exposing via `secrets[]` — explicit, works, but rotations require new task def revisions.
- (future) Rewrite `server/lib/bedrock.ts` to use `AnthropicBedrock`'s default credential chain (it'd pick up the task role automatically). Cleaner but needs careful testing.

For now: every new ECS task definition revision must include the 3 AWS secret refs. Don't strip them.

**How to apply:**
- When updating the ECS task def for any reason: confirm `secrets[]` still contains `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`.
- If onboarding a new admin to manage prod: they need IAM perms for `ecs:RegisterTaskDefinition` + `secretsmanager:GetSecretValue` on `prod/ops-secrets-*`.
- DIRT's `get_integration_health` tool surfaces a `bedrock` status row so we self-detect this regression: if `bedrock.connected` is false, AI is broken.

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

---

## 2026-05-21 — AI composer is the dashboard's email author, NOT a Klaviyo WYSIWYG clone

**Decision:** The dashboard owns an AI-driven *chat* composer (`/email/compose`). The composer outputs subject + preheader + HTML/text and saves to Klaviyo as a Template. The dashboard still does NOT ship a WYSIWYG/drag-and-drop editor.

**Why this and not the May-08 "no in-dashboard composer" decision:**
- The 2026-05-08 ruling was about not rebuilding Klaviyo's drag-and-drop. A chat composer is a *different product* — operators describe an email in natural language and Claude returns brand-compliant HTML grounded in a `BrandProfile`. That's value Klaviyo doesn't provide (and won't, because their UX is for marketing designers, not for ops describing intent).
- Operators in ops contexts don't open Klaviyo to design — they want "win-back to lapsed 30d users, 1 CTA, ship it." Chat is the right interface.
- Templates land in Klaviyo as normal CODE templates; the send flow stays template-trigger. Composer is a *template author*, not a send orchestrator.

**Rules to keep this from drifting into a Klaviyo-clone:**
- No WYSIWYG, no drag-and-drop, no block editor. If a future feature wants those, that's a Klaviyo problem.
- Composer never owns audience selection, scheduling, or send. Those stay in `/email/send`.
- Brand profiles (`ops_email_brand_profiles`) are reusable bundles, not per-template designs. Don't let them grow into a CMS — keep the field list tight (colors, font, logo, voice, footer).
- Output format stays `=== SUBJECT === / === PREHEADER === / === HTML | TEXT ===` so the parser is one function. Don't bolt JSON on.

**How to apply:**
- Adding a new style = new `EmailStyle` union member + branch in `buildSystemPrompt`. Don't add a new endpoint.
- Adding a new brand attribute (e.g. social-media link block) = column on `ops_email_brand_profiles` + plumb through `BrandProfileEditModal` + reference in system prompt. Stop there.
- If someone asks "can we edit the output HTML in the dashboard?" — the answer is no, edit it after Save in Klaviyo. We are not building an editor.

---

## 2026-05-21 — DIRT writes are dashboard-native; refunds > $50 typed-confirm in the model loop

**Decision:** DIRT executes 9 write tools end-to-end: 4 Klaviyo/content (`set_klaviyo_flow_status`, `approve_content_draft`, `queue_blog_topic`, `send_klaviyo_test`) + 5 Stripe (`cancel`, `pause`, `resume`, `change_tier`, `refund`). Every write logs to `ops_admin_actions` before AND after. Refunds above $50 require typed-confirmation from the admin within the conversation — the model is instructed to pause and ask for "REFUND $X" verbatim before calling the tool.

**Why this and not "writes via UI only":**
- Operators ask DIRT for context anyway ("what's this customer's situation?"). Following with "okay refund them" should be the same surface. Bouncing to a separate page is the wrong friction.
- Typed-confirm > role gating: any admin can do it, but only after explicit consent in-context. The audit log captures both the request and the confirmation turn, so postmortem is intact.
- The $50 threshold mirrors the same logic from `email-send`: friction above where mistakes get expensive, frictionless below.

**How to apply:**
- New DIRT writes follow the same pattern: pre-log row, execute, post-log result. Use `logAdminAction` from `server/lib/auditLog.ts`.
- Write a system-prompt rule for any new "expensive" action — make the model gate the call behind a typed confirm. Don't rely on UI buttons; DIRT is conversational, the gate must be in the conversation.
- Read-only mode (`{readOnly: true}` body field, `/read` slash command) still hard-blocks every write tool. New write tools must respect it.

---

## 2026-05-21 — Self-serve credentials write to AWS Secrets Manager from `/integrations`

**Decision:** `/integrations` edits live AWS secrets in `prod/ops-secrets`. Admins rotate Klaviyo / Stripe / Google / Slack keys without redeploying. The page also runs a "Test" call against each provider before saving.

**Why this and not "edit task def to rotate":**
- Rotating a key shouldn't require an ECS deploy. Old flow was: AWS console → Secrets Manager → update → restart task → 4 minutes of grace period. New: edit in UI, save, secret manager writes immediately, app picks it up on next request (since secrets are read per-request via env, not cached at boot for these connectors).
- Test-before-save eliminates "I rotated it but typo'd" outages.

**How to apply:**
- New integrations: register both a `read` (status) and a `test` (probe-call) endpoint, then add to the Integrations page schema in `client/src/pages/integrations.tsx`.
- Secret keys are stored in the same `prod/ops-secrets` JSON. Never split into a separate secret per provider — duplicates the rotation overhead.
- The IAM role on ECS task def MUST have `secretsmanager:PutSecretValue` on `prod/ops-secrets`. Read-only role would break this flow.

---

## 2026-05-21 — All modals via React portal

**Decision:** Any modal that could render inside an `overflow-hidden` container uses `client/src/components/modal-portal.tsx` (renders into `document.body`). Inline modal rendering is banned.

**Why:** On mobile, parents with `overflow-hidden` clip absolutely-positioned modals so they appear "below the page" or invisible. Portal escapes the clip. Desktop is unaffected.

**How to apply:**
- Every new modal wraps its contents in `<ModalPortal>`. No exceptions.
- If you find an inline modal during a refactor, port it. Don't add new ones.
- Backdrop click-to-close is handled by the portal — don't reimplement.

---

## 2026-05-22 — Klaviyo conversion metric: per-purpose, probe-and-cache

**Decision:** `getConversionMetric(purpose)` caches per "campaign" vs "flow" because Klaviyo's `values-report` 400s for different metric × report combinations. Candidates are tried in priority order (revenue first, then engagement fallbacks); first that returns 200 wins. Cache TTL 30 min.

**Why this and not "find the one true metric":**
- Klaviyo accounts vary: some have "Placed Order" wired (Shopify), some only have base engagement events. Hard-coding one metric breaks new accounts.
- A given metric can be valid for one report type and rejected for another in the same account — values-report has different compatibility rules than the metric list itself. Per-purpose cache is the cleanest answer.
- Probe-once-then-cache is cheap. The miss happens at boot per purpose; every subsequent call is hot.

**How to apply:**
- New report endpoints that need a `conversion_metric_id` should call `getConversionMetric('campaign' | 'flow')` and handle the `null` case (return `{metrics:{}, warning}` so the UI degrades).
- When we add value-capable stats to a request, gate them on `conv.isRevenueMetric` — non-revenue metrics 400 on `conversion_value` / `revenue_per_recipient`. Engagement-only stat list is the safe fallback.
- `KLAVIYO_CONVERSION_METRIC_NAME` env override skips the priority list — use it when an account has a custom event name (e.g. "Subscription Created").

---

## 2026-05-25 — Klaviyo DSD via NS delegation, not CNAME or Entri auto-flow

**Decision:** Set up Klaviyo Dedicated Sending Domain (`send.fitscript.me`) via the manual NS-delegation flow. The four `send.fitscript.me NS → ns{1-4}.klaviyo.com` records plus the apex `klaviyo-site-verification=V3sni5` TXT record cede full DNS control of the subdomain to Klaviyo. Klaviyo manages all DKIM keys, return-path, SPF, and dmarc records internally on their nameservers — no per-record changes on our Cloudflare side.

**Why this and not alternatives:**
- **vs. Entri auto-flow** (the other option in Klaviyo's wizard): Entri auto-logs into Cloudflare via OAuth and adds the records blindly. Our `fitscript.me` apex has 2 conflicting DMARC records + an existing multi-include SPF + Mailgun MX records on `email.fitscript.me` — none of which can survive Entri's blind merge. Manual gives us full control and audit visibility.
- **vs. CNAME-only setup**: Klaviyo's CNAME-only flow is only offered to specific accounts (the Entri auto-config uses it). Manual setup is NS-delegation regardless. Both achieve the same domain alignment; NS delegation is simpler from our DNS side.
- **vs. keeping the previous Klaviyo setup**: The previous setup never completed verification — NS records existed but zone was empty (TXT missing). Re-adding the same NS records + the missing TXT is the completion, not a rebuild.

**How to apply:**
- Klaviyo DSD setup for any future brand (Real Peptides, Clomark, etc.) → use the manual NS-delegation flow.
- DNS records always get comments in Cloudflare (`Klaviyo DSD - delegation N/4`, `Klaviyo domain ownership verification - account <id>`).
- Verification email is async (Klaviyo's check runs in background, usually completes <60 min for Cloudflare DNS). Don't expect synchronous confirmation.

---

## 2026-05-25 — Hybrid Klaviyo + RDS search for subscribers (Klaviyo can't do partial email)

**Decision:** `/email/profiles` search hybrid-resolves via RDS `users` table for partial queries. Klaviyo's profile email filter ONLY supports `equals` and `any` (no `contains` / `starts-with` / `ends-with`). To make partial search work AND surface "FitScript users not yet in Klaviyo," we search RDS first for `email ILIKE %q%`, then bulk-resolve those emails in Klaviyo via `any(email, [...])`.

**Why this and not alternatives:**
- **vs. exact-email-only** (drop partial search): operators don't always remember full email; first-name or domain-substring search is daily. Too much friction.
- **vs. local Klaviyo profile cache** (pull all profiles into RDS, search locally): heavy sync layer, eventual-consistency risk, more code than the hybrid resolves.
- **vs. ignoring RDS-only users**: misses an actionable ops gap — FitScript signups never pushed to Klaviyo don't receive marketing email at all. Surfacing them is the differentiator vs. Klaviyo's native UI (which can't show "exists in your DB but missing from Klaviyo").

**How to apply:**
- New "find an X in our systems" surfaces (members, leads, suppressions) should adopt the same pattern: search our DB by anything queryable, then resolve in the third-party system. Surface third-party-missing rows separately.
- Klaviyo's `any(email, [...])` accepts up to 100 values per filter — RDS LIMIT 25 keeps us well under.
- When partial RDS results are empty, return a clear "no FitScript users match this query" note. When RDS matches but Klaviyo doesn't, surface RDS-only as actionable (push-to-Klaviyo button).

---

## 2026-05-25 — DIRT tools and HTTP endpoints share handler logic; both audit to one log

**Decision:** Every Klaviyo write surface added today (suppress, unsuppress, push) is callable via TWO surfaces: HTTP endpoint (used by `/email/profiles` UI) and DIRT tool (used by conversational interface). Both call into the same Klaviyo API + write to the same `ops_admin_actions` audit table with the same action_type. The DIRT call adds `metadata: { via: "dirt" }` so we can segment operator-driven actions by surface.

**Why this and not alternatives:**
- **vs. DIRT-only writes** (no UI buttons): conversational interface is great for "do this once" but bad for sweeping audit workflows ("which users are RDS-only and need push?"). Need the visual surface.
- **vs. UI-only writes** (no DIRT tools): forces operators to context-switch from a DIRT conversation about a user to a separate UI surface to act on it. Friction.
- **vs. separate DIRT-only audit log**: defeats the point of having one source of truth for "what changed in ops." Operators reading `/settings → Admin Log` should see every action regardless of surface.

**How to apply:**
- New write actions get BOTH surfaces from day one. Server endpoint first; DIRT tool wraps the same logic.
- DIRT tool descriptions should explicitly mention they correspond to a UI surface (e.g. "/email/profiles → Push button") so the model can point operators at the visual flow when bulk action makes more sense.
- The `via` metadata field distinguishes surface for analytics. Future audit-log dashboards should let you filter by `metadata.via = ui | dirt | autopilot | api`.

---

## 2026-05-25 — Klaviyo profile create is 409-idempotent; treat as success-with-existing

**Decision:** When `/api/ops/klaviyo/profiles/push` hits Klaviyo's `POST /profiles/` and Klaviyo returns 409 with `meta.duplicate_profile_id`, our endpoint returns `{ ok: true, already_existed: true, profileId: <existing> }` instead of bubbling the 409 as an error. Push operations are blindly retryable; bulk pushes can replay without dedup logic.

**Why this and not alternatives:**
- **vs. treating 409 as failure**: makes bulk-push fragile (any single duplicate fails the whole loop) and the idempotent retry pattern impossible. Operators would need to pre-check existence before every push.
- **vs. checking-then-creating (GET-then-POST)**: doubles API calls. Klaviyo's 409 already does the check for us on the server side; we just need to interpret it correctly.
- **vs. swallowing 409 silently**: loses observability. Surfacing `already_existed: true` lets the client UI render `✓ Already in Klaviyo` (blue) vs `✓ Created` (green), and lets the audit log differentiate via `metadata.created` vs `metadata.existing` for analytics.

**How to apply:**
- Any future Klaviyo (or generally any third-party) `create` operation that has natural deduplication (email, external_id, etc.) should adopt the same pattern: catch 409, return success-with-existing, log differentially.
- Audit log metadata fields like `created: true` / `existing: true` are the right way to keep one action_type (`profile.push`) but differentiate sub-cases for downstream filtering.
- The 1.2s delay before refetching search after a push is empirically tuned for Klaviyo's eventual-consistency. Shorter and the new profile sometimes doesn't appear in the search yet.



---

## 2026-06-01 — Reports section: one module, four endpoints, FitScript-only v1

**Decision:** Built `/reports/email`, `/reports/traffic`, `/reports/conversions`, `/reports/sales` as four sibling endpoints inside a single `server/reports.ts`. All take `?days=7|30|90|365`, return `{ window_days, generated_at, ...domain }`. Scoped to FitScript only — no multi-tenant routing in v1.

**Why this and not alternatives:**
- **vs. four separate route modules:** They share `kFetch` (Klaviyo), `getAuthenticatedClient` (GA4), bucket regex (traffic + conversions), and `Days` enum. Splitting would copy the shared pieces or force shared-util files.
- **vs. multi-brand from day one:** Paul confirmed FitScript-only v1 via AskUserQuestion. Brand picker can be retrofitted later by parameterizing the SQL `from users` and the URL bucket regex.
- **vs. inferring revenue from Stripe charges API:** `lab_orders` is a clean local ledger with `paid_at`, `refunded_at`, `discount_cents` — fast SQL, no rate-limit risk. Subscription MRR shown as estimate (tier list × active sub count) since FitScript has no `stripe_payments` table.
- **vs. RDS-only subscriber count:** For EMAIL, Klaviyo could in theory return total subscribers, but `/profiles/?filter=equals(consent,SUBSCRIBED)` requires paginating up to 5k profiles. RDS `count(*) from users where email <> ''` is one query and authoritative.

**How to apply:**
- New report → new endpoint in `server/reports.ts`, follow `{ window_days, generated_at }` envelope, parallelize external calls with `Promise.all`.
- Window selector belongs in `PageHero actions`, not the body — keeps the report dense.
- Tone-color stat cards (good/warn/bad) by published rate thresholds. Don't editorialize.
- When data is missing, show `—` + an inline hint on what to wire (e.g. "Fire add_to_cart GA4 event"). Never fabricate a number.
- Bucket regex (`PAGE_BUCKETS` in `server/reports.ts`) is FitScript URL-specific. Multi-tenant rework = parameterize by brand.
- MRR estimate uses `TIER_MONTHLY_PRICE` lookup keyed to `users.subscription_tier`. Update both when pricing changes (per `[[project_fitscript_pricing_arc_may25]]`).

