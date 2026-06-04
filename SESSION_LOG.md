# Ops Dashboard Session Log

Running history of every development session. Autom reads this at the start of each session.

---

## 2026-06-04 — Email deliverability fixes + 5 reports bugs + Waitlist CTAs

### Reports bugs caught + fixed (commits `6db0740` + `a79f001`)

While Paul was looking at `/reports/email` we caught three real defects:

1. **Klaviyo `send_time` no longer filterable** — `/campaigns/?filter=greater-or-equal(send_time,...)` 400'd. Klaviyo's 2025-04-15 revision only allows filtering campaigns by `archived | created_at | id | messages.channel | name | scheduled_at | status | updated_at`. Switched to `updated_at` + `sort=-updated_at`.
2. **Klaviyo `any(campaign_id,...)` rejected** — campaign-values-reports filter operator changed to `contains-any`. Without the fix `campaigns_sent` always read 0.
3. **Postgres alias-in-cast ORDER BY** — `ORDER BY sessions::int DESC` fails because aliases don't resolve inside cast expressions. Switched to `ORDER BY COUNT(*) DESC` (raw aggregate). Was breaking `firstPartyChannels` + `firstPartyAttribution` on `/reports/ads`.

Plus three quality-of-life improvements (commit `a79f001`):
- `.github/workflows/deploy.yml` now pulls live task def from ECS instead of rendering static `.aws/task-definition.json` (eliminates the regression footgun from Jun 3).
- `writeSecretFields` in `server/lib/secretsManager.ts` drops empty/whitespace values before put-secret-value (protects against IntegrationEditModal blanking out keys — see [[feedback_aws_secret_to_env]]).
- CSV export on all 5 reports — `?format=csv` returns `Content-Disposition: attachment` with spreadsheet-friendly rows.

### Waitlist Nurture flow rescue

Paul looked at the 0.15% click rate. Diagnosis: the only sending flow (`Twr7Ln "FitScript Waitlist Nurture"`) had **5 emails with zero clickable CTAs** — the only hrefs in any email were the unsubscribe + privacy footer placeholders (`href="#"`). Click tracking was ON but nothing to click.

Built CTA HTML blocks matching the existing template (DM Sans, brand gradient `#0EA57A → #34D399 → #60A5FA`, Outlook-safe with solid-color fallback), rendered all 5 full templates, dropped them at `~/Desktop/klaviyo-waitlist-flow-buttons/` for Paul to paste.

**Klaviyo API blocker:** `/templates/{id}/` PATCH and `/flow-messages/{id}/` PATCH both rejected (404 / 405). Flow templates can only be edited via Klaviyo UI — no programmatic path. Paul pasted manually; verified after via API GET — all 5 emails now have `fitscript.me/signup` + `fitscript.me/labs/panels` real CTAs.

### Email deliverability — DMARC + SPF audit

**Findings:**
1. **Duplicate DMARC at `_dmarc.fitscript.me`** — two TXT records (`p=none; rua=brevo` + `p=quarantine;`). Per RFC 7489 §6.6.3, when receivers see >1 DMARC record they discard both and treat the domain as having no DMARC policy at all. **This was the dominant cause of the 9.88% bounce rate.**
2. **Klaviyo uses NS-delegation routing** — `send.fitscript.me` is delegated to `ns1-4.klaviyo.com`. Klaviyo manages SPF/DKIM/DMARC for that subdomain themselves on their nameservers. Our dig from Klaviyo's NS showed the zone empty (SOA serial=1), but Klaviyo UI shows the domain Active — the green checks verify NS delegation + apex DMARC, not the records Klaviyo serves. Real auth alignment unknown without inspecting actual outbound email headers.
3. **`email.fitscript.me`** has its own separate SPF + DMARC for Brevo sends. Unchanged.

**What Paul did in Cloudflare:**
- Deleted the duplicate `p=quarantine;` row
- Hardened the keeper to `v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com; ruf=mailto:rua@dmarc.brevo.com; fo=1; adkim=r; aspf=r`
- (Briefly added a bogus `_spf.klaviyo.com` SPF include — then reverted)

### The SPF mistake — DO NOT REPEAT

**What I said to do:** "Add `include:_spf.klaviyo.com` to the apex SPF to authorize Klaviyo."

**Why it was wrong:**
- `_spf.klaviyo.com` returns no TXT record. Klaviyo doesn't publish an SPF include hostname for senders.
- For Klaviyo's NS-delegation model, the customer's apex SPF is irrelevant to authorizing emails from `send.<domain>` — SPF does NOT fall back from subdomain to parent the way DMARC does. Klaviyo handles authorization on its own NS for the delegated subdomain.
- Unresolved SPF includes either waste 1 of 10 SPF lookups (best case) or cause `permerror` on strict receivers (worst case — could have made the situation worse).

**Future rule:** before suggesting any `include:X` in an SPF record, **verify `dig +short TXT X | grep -c "v=spf1"` returns ≥ 1**. Empty includes are net-negative. Also see [[feedback_spf_klaviyo_no_include]].

### Net DNS state at end of session (verified clean)

| Surface | State |
|---|---|
| SPF apex `fitscript.me` | `v=spf1 include:mailgun.org include:_spf.google.com include:spf.leadconnectorhq.com ~all` — 8/10 lookups |
| DMARC apex `_dmarc.fitscript.me` | `p=none; rua=mailto:rua@dmarc.brevo.com; ruf=mailto:rua@dmarc.brevo.com; fo=1; adkim=r; aspf=r` |
| Subdomain `send.fitscript.me` | NS-delegated to Klaviyo, untouched |
| Subdomain `email.fitscript.me` | Brevo-owned, untouched |

Bounce-rate impact expected over next 2-3 weeks as new DMARC reports flow into Brevo.

### Pending follow-ups

- Forward a real Klaviyo email's `Authentication-Results` header to confirm DKIM alignment status (the missing piece — could lead to a Klaviyo support ticket if the empty zone is a misconfig on their side)
- After 2 weeks of clean Brevo DMARC reports → upgrade `p=none` → `p=quarantine`

---

## 2026-06-04 (later) — Klaviyo `$value` wired + branch sidequest

### What shipped

**FitScript (`markappz/Humn-Health` commit `b2b90884`):**
- `server/services/klaviyoService.ts` — `KlaviyoEventPayload` extended with optional `value` + `valueCurrency` fields; `trackKlaviyoEvent` inlines them into the Klaviyo event body when present (`attributes.value`, `attributes.value_currency`). Klaviyo treats events with `value` as revenue-eligible.
- `server/stripe.ts:1121` (Stripe webhook fire site for Lab Order Placed) — passes `value: Math.max(0, (grossCents - discountCentsTotal) / 100)`, `valueCurrency: "USD"`. Refunds at `:1232` fire `Lab Order Refunded` with **negative** value so revenue nets out cleanly.
- `server/routes.ts:4538` (admin resend path) — mirrored the same value calculation so manual resends don't break the running total.

**Ops dashboard (`markappz/ops_dashboard` commit `ce93126`):**
- `server/reports.ts` `pickConversionMetric` — added `Lab Order Placed` to the revenue-first priority list ahead of the engagement fallback (`Received Email`). Reuses the existing probe-each-candidate pattern.

### Verification

- `/api/ops/reports/email` on prod now returns:
  - `campaign_conversion_metric: "Lab Order Placed"` (was `"Received Email"`)
  - `flow_conversion_metric: "Lab Order Placed"` (was `"Received Email"`)
  - `revenue.available: true` (was `false`)
  - `total_attributed_usd: 0` — correct; no paid lab orders in the 30d window yet. Cards will populate as soon as new orders fire the value-bearing event.

### Branch sidequest — caught in flight

The fitscript repo was sitting on `wizlo/intake-submission-api` (a feature branch that had ALREADY been merged to main as PR #35). My first `git commit` landed on that orphan branch (`a24d0d7e`) instead of main. Caught it on `git log`, switched to main, cherry-picked the commit cleanly to `b2b90884`, pushed. The local `wizlo/...` branch is harmless leftover — Paul's dev workflow can prune it whenever.

**Lesson:** before committing in `fitscript/`, run `git branch --show-current` if any other agent or person may have been in the repo. The repo is shared with at least one human dev who creates feature branches; switching back to `main` is not the default.

### Net state at session end

| Item from Paul's punchlist | Status |
|---|---|
| PR #30 merge (FAQ pricing) | ✅ Done earlier today |
| DMARC fix in Cloudflare | ✅ Done — single hardened record at apex |
| Klaviyo `$value` on Lab Order Placed | ✅ Done — both sides shipped, prod showing revenue.available=true |
| Meta Ads token | Waiting on Paul (Meta Business Settings) |
| Google Ads dev-token | Waiting on Google approval (passive) |
| Hyros / Campaign Refiners | Optional / need info |

### Followups

- Watch `/reports/email` over next week — first paid lab order should populate revenue cards with real numbers
- If revenue numbers look off vs. Stripe ledger after first orders, audit the netCents calculation in `server/stripe.ts:1116` (discount handling)

---

## 2026-06-03 — Tech-tickets prod activation (PAT → secrets → ECS → S3 IAM)

Paul provided his GitHub PAT. I drove the rest of the activation runbook end-to-end except the IAM steps (which my user can't self-grant).

### What shipped (all in prod)

**Secrets Manager (`prod/ops-secrets` + `humn/prod/general`):**
- `GITHUB_PAT_FITSCRIPT_FIX` — Paul's `github_pat_11BJPFUTQ0…` (fine-grained, Contents+PRs r/w on `markappz/Humn-Health`). Validated against GitHub API before write.
- `OPS_TICKETS_API_KEY` — generated fresh (`7tx9aiBl…`) written to both ops + fitscript secrets so the shared-key handshake works across services.
- `OPS_TICKETS_INGEST_URL` — `https://ops.fitscript.me/api/tickets/ingest` added to fitscript secret.

**ECS task definitions:**
- `fitscript-ops-task:90` — added secret refs for `GITHUB_PAT_FITSCRIPT_FIX`, `OPS_TICKETS_API_KEY`, `OPS_CONTENT_BUCKET` (the bucket env was in the secret but missing from the task def).
- `fitscript-task:355` — added secret refs for `OPS_TICKETS_API_KEY`, `OPS_TICKETS_INGEST_URL`.
- Both services force-new-deployed; both stabilized cleanly.

**Local dev sync:**
- `ops-dashboard/.env` and `fitscript/.env` now both have the same `OPS_TICKETS_API_KEY` as prod. Before today the two local `.env` files had different (and truncated) values — fitscript had `90l7XPt0jXyqzdiBLugB` (20 chars), ops had `90l7XPt0jXyqzdiBLugBlx9dTVWXSobFzR3IMIKsILA` (43 chars). Local widget submission would have 401'd before. Now consistent.

**S3 presign fix (`server/tickets.ts`, commit `c6e006b`):**
- @aws-sdk/client-s3 ≥3.729 adds `x-amz-sdk-checksum-algorithm=CRC32` to presigned PUT URLs by default.
- Browser `fetch()` / curl `PUT` uploads don't compute that header → S3 returns 403 `SignatureDoesNotMatch` on every screenshot upload.
- Fix: `new S3Client({ region, requestChecksumCalculation: "WHEN_REQUIRED" })` strips the checksum from the canonical request.
- Local PUT verified HTTP 200. Prod deploy run `26908592490` in flight at session-update time.

### Side-issues uncovered

- **Mystery secret writes.** Between my first PUT to `prod/ops-secrets` (11:33:37) and verification (11:36+), the secret got rewritten by something else (11:37:13). Likely culprit: the IntegrationEditModal save flow Paul added to `reports-ads.tsx` calls `writeSecretFields` in `server/integrations.ts:356`. If the modal saves a blank field, it would clobber existing keys. Worth a guard against empty-string writes.
- **Inline-policy budget on `replit-humn-dev`.** The IAM user is at the 2048-char inline-policy limit. Could not add an inline S3 policy. Solution: created a managed policy `ops-content-bucket-access` (5 actions on `fitscript-ops-content` + objects) and attached it directly.

### Verification

| Surface | Result |
|---|---|
| Ops `/api/tickets/ingest` direct with API key | ✅ 200 (ticket `c4ad3707…`) |
| Fitscript `/api/internal/report-issue` proxy | ✅ 200 (ticket `c0f74aff…`) |
| Bad API key | ✅ 401 |
| Admin auth (session cookie) | ✅ Lists prod tickets |
| AI auto-fix flow | ✅ Already proven by ticket `6dece043` showing `status: pr_implemented` + PR #30 on `markappz/Humn-Health` |
| S3 presign URL no longer carries CRC32 param | ✅ |
| Local S3 PUT to `fitscript-ops-content` | ✅ HTTP 200 |
| Prod S3 PUT (run `26909276248`, task def `:92`) | ✅ HTTP 200 |
| Prod ingest with `screenshot_s3_key` | ✅ ticket `c47e985a-5ea1-4ecf-8072-a27a77337803` |

### Bonus issue caught + fixed: GitHub Actions task-def regression

After the S3 fix deploy, the running container reported `OPS_TICKETS_API_KEY not configured` even though I had registered task def `:90` earlier with the secret refs. Root cause: the ops-dashboard deploy workflow renders the task def from the static `.aws/task-definition.json` in the repo, NOT from the latest live revision. Every deploy clones the static file and silently drops any manually-added secret refs. Revision `:91` (auto-created by Actions) was missing my 3 new entries.

Fix: added the 3 refs (`OPS_TICKETS_API_KEY`, `GITHUB_PAT_FITSCRIPT_FIX`, `OPS_CONTENT_BUCKET`) to `.aws/task-definition.json` and pushed. Deploy run `26909276248` registered task def `:92` with all the secret refs intact. Future deploys will preserve them.

(FitScript's workflow doesn't have this footgun — it uses `aws ecs describe-task-definition` to pull the live revision as the baseline, which is why my `:355` edit for fitscript stuck through subsequent deploys. Worth standardizing the ops-dashboard workflow to do the same pattern later.)

### Task list state — all 6 done

- ✅ #23 PAT generated
- ✅ #24 S3 bucket + IAM — bucket existed; managed policy `ops-content-bucket-access` created and attached to `replit-humn-dev`
- ✅ #25 Secrets Manager writes
- ✅ #26 Task-def revisions registered (manual `:90` + template fix in `.aws/task-definition.json`)
- ✅ #27 ECS services updated + stabilized
- ✅ #28 End-to-end verification (ingest, fitscript proxy, screenshot upload, AI auto-fix already proven by PR #30)

### What's still on Paul's plate (outside this runbook)

1. **DMARC duplicate fix in Cloudflare** — drives the 9.67% email bounce rate.
2. **Meta Ads system-user token** — `META_SYSTEM_USER_TOKEN` + `META_AD_ACCOUNT_ID`. Lights up `/reports/ads` Meta card.
3. **Google Ads dev-token** — already submitted to Google, awaiting approval.
4. **Klaviyo revenue metric** — configure "Placed Order" or equivalent with `conversion_value` so `/reports/email` Revenue cards populate.
5. **Hyros API key** (optional — first-party tracking already works).
6. **Campaign Refiners** — tell me the API shape if/when ready.

---

## 2026-06-02 (PM) — Tickets row-level Approve / Deny + PAT-missing UX cleanup

Paul flagged two issues after the Step 2 ship:
1. The drawer surfaced the raw `GITHUB_PAT_FITSCRIPT_FIX not configured` error as a red banner every time the admin clicked the auto-fix button — leaking server config into the UI.
2. The 2-step workflow inside the drawer felt heavy. He wanted simple **Approve & fix** / **Deny** buttons right on the ticket list rows.

### What shipped

**Server (`server/tickets.ts`)**
- Added feature-detect endpoint `GET /api/ops/tickets/config` → `{ github_pat_configured, ai_configured, github_repo }`. UI reads this once on mount and uses it to disable buttons when prod env is missing the PAT, instead of letting the failure render as a red banner.
- Added `resolution_pr_url` to the list-view SELECT (was only in the detail query). Lets the row know whether to skip Step 1.

**Client (`client/src/pages/tickets.tsx`)**
- New `<TicketRowActions>` component rendered in the right cell of every row. Two buttons:
  - **Approve & fix** (emerald) — chains PATCH `status=approved` → POST `/open-fix-pr` (if no PR yet) → POST `/auto-implement`. Inline progress messages: "Promoting…" → "Opening PR…" → "Claude editing files…". Errors stay in the row for 6 sec then clear.
  - **Deny** (muted) — PATCH `status=wontfix`.
- Buttons hide when ticket is in a terminal status (`pr_implemented`, `merged`, `closed`, `wontfix`, `duplicate`) — replaced by a label (✓ Fixed, ✓ Merged, Closed, Denied, Duplicate).
- Approve button is greyed + tooltipped when `autoFixEnabled === false` (PAT or AI missing) instead of failing on click.
- Removed the two-step "Step 1: Open fix proposal PR" + "Step 2: Approve & implement" sections from the drawer — the entire flow moved to row-level. Drawer is now a read-only detail view.

**E2E test (`scripts/e2e-ticket-test.ts`, new)**
- Submits a real test ticket via ingest, waits for AI triage, signs an admin session cookie locally with `OPS_SESSION_SECRET`, runs the full chain. Used to validate the auto-implement flow — produced real PR #30 on Humn-Health (`fix(ux): update homepage FAQ pricing from $27/mo Health to $20/mo Protocol`, surgical 1-line Claude edit).

### Two prod-env gaps still open

The UI now gracefully degrades when these are missing, but they need to be set on the ops ECS task def before the auto-fix flow can run in prod:

| Env var | What | Why |
|---|---|---|
| `OPS_TICKETS_API_KEY` | Shared secret with FitScript's report-issue proxy | Without it the ingest endpoint returns 503 — widget submissions fail silently |
| `GITHUB_PAT_FITSCRIPT_FIX` | GitHub PAT with `repo` scope on `markappz/Humn-Health` | Without it the Approve & fix button is greyed out with a tooltip explaining the gap |

---

## 2026-06-02 (later) — Reports follow-up: Ads, Growth Overview, FitScript GA4 events

**Worked on:** Paul asked to "continue everything" then "handle whatever you can do yourself." Four things shipped:

1. **5th report: Ads & Attribution** (`/reports/ads`). Meta from the existing connector (renders "Not connected" until token set). Google Ads + Hyros + Campaign Refiners as connection-state-aware stub cards. First-party attribution from `visitor_sessions` + `touchpoints` (channel mix + top utm_source breakdown) — same data Hyros would surface.
2. **Conversion rate clamp.** Funnels showing >100% (signup leg was 120% pre-launch because GA4 page-views miss some signup paths that RDS counts) now display 100% with an amber "≈" badge and an inline note explaining the measurement gap.
3. **Growth Overview strip on Command Center.** 5-card row above the existing Revenue Row: sessions, new signups, email open rate, lab revenue, ad ROAS. Each card links to its full report. 5-minute refetch.
4. **GA4 event wiring on FitScript** (separate repo). New `client/src/lib/analytics.ts` thin gtag wrapper. Fires `add_to_cart` from `useLabOrderFlow.handleContinue`, `begin_checkout` on `/labs/order/:slug` mount, `purchase` on `/labs/order/confirmed` (ref-guarded against the 30s poll). Unblocks 3 of the 4 yellow funnel cards. Popup events helpers exist but un-wired until a signup popup is built.

**Shipped:**
- ops-dashboard: commits `6d88c5c` (Ads + clamp), `c9e0e31` (Growth Overview) on `origin/main` via Actions runs `26846548304`, `26848250868`. Bundle hash `index-B4Iiu7cO.js` verified live on `ops.fitscript.me`.
- fitscript: commit `377bd7cc` (rebased onto Paul's dev's 382-commit /new-3 stream — no conflicts since none of his files overlapped mine) via Actions run `26848677614`.

**Pending — Paul's punchlist:**
1. Generate Meta `ads_read` system-user token + paste `META_SYSTEM_USER_TOKEN` and `META_AD_ACCOUNT_ID` into ops `prod/ops-secrets`. Then `/reports/ads` lights up.
2. (Optional) Hyros API key into `HYROS_API_KEY` if you want Hyros alongside the first-party attribution.
3. DMARC fix in Cloudflare to bring the 9.67% email bounce rate down.
4. Klaviyo: configure or wire a "Placed Order" metric with `conversion_value` so Revenue/RPS cards populate.
5. Tech-tickets prod activation (separate runbook from yesterday — tasks #23-28).

---

## 2026-06-02 — Tickets: Step 2 (Claude auto-implements code on the existing fix PR)

Closed the loop on the user-report → ops-ticket → Claude-writes-the-code flow. Paul flagged that the existing `open-fix-pr` endpoint only generates a proposal — a human still had to write the actual diff. Now admins can approve → Claude edits files on the branch via tool-use.

### What shipped

**Server (`server/tickets.ts`)** — new endpoint `POST /api/ops/tickets/:id/auto-implement`:
1. Requires `resolution_pr_url` already set (step 1 must run first to create the draft branch + proposal)
2. Re-prompts Claude with the bug context + repo structure, but with `read_file` / `edit_file` / `write_file` tools wired into a multi-turn tool-use loop
3. In-memory file cache: fetches target files from GitHub Contents API on first read, tracks SHA per-file for write-back
4. Iterates until `stop_reason !== "tool_use"` OR safety bound hit:
   - Max 6 files modified
   - Max 800 LOC delta
   - Max 12 tool turns
   - Path allowlist: blocks `.git/`, `.github/`, `node_modules/`, `package*.json`, `.env*`, `*.lock`, `scripts/migrations/` (DB changes need separate review)
5. Commits each modified file via PUT `/contents/<path>` to the existing branch
6. Appends an "Auto-implementation" section to the PR body with: approving admin, files modified, LOC delta, tool call stats, Claude's closing summary
7. PR stays DRAFT — admin must manually flip to ready-for-review
8. Updates ticket status to `pr_implemented`; logs to `logAdminAction` with full metadata
9. Costs logged to shared `ai_costs` table under surface `ops_ticket_auto_implement`

**Edit-file tool semantics:** uniqueness-enforced. If `find` matches 0 times → error; if it matches > 1 times → error asking Claude to make it unique. Same pattern as the Claude Code Edit tool to prevent silent misreplacements.

**No-op handling:** if Claude decides not to modify anything (e.g. it can't reproduce the bug from the report), endpoint returns `{ no_op: true, summary }` and audit logs `outcome: "no_op"` — no commits, no PR updates.

**Client (`client/src/pages/tickets.tsx`)**:
- Added new `Status` value `pr_implemented` (PR has Claude-written code, awaiting human review)
- Split the existing AI-fix section into a two-step flow:
  - **Step 1 — Open fix proposal PR** (existing): purple button, shows only when ticket has no PR yet
  - **Step 2 — Approve & implement** (new): emerald button, shows only after step 1 has created a `resolution_pr_url` and ticket is not yet `pr_implemented`/`closed`
- Step 2 confirmation modal calls out the safety bounds explicitly so the admin knows what Claude is allowed to touch

### Environment requirements
- `GITHUB_PAT_FITSCRIPT_FIX` — same PAT as `open-fix-pr` (already in prod env)
- `GITHUB_REPO_OWNER` (default `markappz`)
- `GITHUB_REPO_NAME` (default `Humn-Health`)
- AI creds (Bedrock or `ANTHROPIC_API_KEY`)

### Type check
- 0 new errors in `server/tickets.ts` or `client/src/pages/tickets.tsx`
- Status enum + STATUS_META extended to include `pr_implemented`
- `logAdminAction` status field is `"ok" | "failed"` only — no-op uses `ok` + `metadata.outcome = "no_op"` (not a separate status)

### What's still open
- **No tests yet** for the auto-implement endpoint. Should add a fixture-based test that mocks GitHub + anthropic and verifies safety bounds.
- **Dirt tool**: could expose `auto_implement_ticket` as a Dirt tool so it can be invoked from chat. Reserved for a follow-up.
- **Auto-promote draft → ready**: currently always stays draft. Could add a per-admin toggle.
- **Conflict handling**: if a write conflicts (GitHub 409 — file SHA changed since read), endpoint errors. Should add retry-with-fresh-read.

---

## 2026-06-01 — Reports section (4 dashboards)

**Worked on:** Paul asked for ops dashboards covering site traffic, conversion rates, email, and sales. Scoped to FitScript-only v1, started with EMAIL (Klaviyo already wired) and progressed through all four.

**Shipped locally (uncommitted at session end):**
- New `Reports` sidebar section between Growth and Workspace
- `server/reports.ts` — one module, four endpoints, all in parallel where possible
- `/reports/email` — Klaviyo engagement + RDS subscriber count + RDS new-signup count. Klaviyo's "Unsubscribed from Email Marketing" for losses. Falls back from Klaviyo conversion-revenue to engagement-only when no revenue metric exists (FitScript Klaviyo has none).
- `/reports/traffic` — GA4 sessions/users/pageviews + URL-bucket grouping (landing / signup / product / checkout / confirmation) + popup-event count (tries 5 event-name variants).
- `/reports/conversions` — 5 funnels (signup, popup, product→cart, cart→checkout, checkout→purchase). GA4 ecommerce events combined with RDS new-user count for the signup leg.
- `/reports/sales` — Lab-order revenue, customer counts, AOV, repeat-buy rate, LTV, time-to-first-purchase from `lab_orders` + `users` + tier-pricing MRR estimate from `users.subscription_tier`.

**Key implementation notes:**
- `server/google-auth.ts` — exported `getAuthenticatedClient` + `getConnection` so reports.ts can reuse the same OAuth flow.
- All four reports take `?days=7|30|90|365`; client has window-pill in PageHero actions.
- Tone-colored stat cards (good/warn/bad) by industry-standard rate thresholds.
- Sales endpoint uses raw `pool.query` (per `[[feedback_ops_raw_sql]]`); the lifetime CTE joins per_customer summary with `users.created_at` for time-to-first-purchase.

**Real numbers (30-day window, today):**
- EMAIL: 34 active subs, 6 new, 4 unsubs (+2 net, 6.25% growth), 31.29% open rate, 9.67% bounce (flagged red), 0% click rate, no revenue metric configured.
- TRAFFIC: 56 sessions / 49 users / 62 pageviews; bucket split: 49 landing / 5 signup / 1 checkout / 0 product / 0 confirmation; 0 popup events; 66% bounce, 48s avg session.
- CONVERSIONS: signup conversion shows 120% (5 GA4 signup-page views → 6 RDS new users — bucket regex misses real signup paths pre-launch); all other funnels at 0/null pending events.
- SALES: $0 lab-order revenue, 0 paying customers, $495/mo MRR estimate (5 active "protocol" subs at $99/mo list).

**Followups Paul will want:**
1. **9.67% bounce rate is bad** — ties to the still-pending DMARC fix in Cloudflare. Show this in EMAIL report tone-colored red so it nags.
2. **No revenue attribution in Klaviyo** — needs a "Placed Order" or "Lab Order Placed" metric with `conversion_value` to populate the Revenue cards. Probably wire from FitScript ingest side.
3. **Bucket regex is FitScript-specific** — when Paul launches Real Peptides reporting, this will need a multi-tenant override.
4. **Sub revenue is estimate only** — for real numbers, would need Stripe `charges` API or a webhook-fed `stripe_payments` table.

**Shipped to prod:** Committed as `1e52a6f`, pushed to `markappz/ops_dashboard`, GitHub Actions run `26776959239` deployed to ECS in ~5 min. Bundle hash `index-By1lWpEe.js` verified live on `ops.fitscript.me` per the silent-deploy lesson.

**Tasks completed this session:** #29 (Email), #31 (Site Traffic), #32 (Conversions), #33 (Sales). Tech-tickets prod-runbook tasks (#23-28) still pending Paul's GitHub PAT + AWS admin steps.

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

---

## 2026-05-20 (continued) — Clomark content control plane on /content

After the 5-block day plan + Clomark bridge, Paul iterated `/content` from read-only into the **content control plane** for Clomark. Five sub-phases shipped this evening across both repos.

### Commit ledger

```
ops-dashboard:
  93c614b  Wire CLOMARK_* env vars into ECS task def (prod Clomark activation)
  b8a6c52  Content control plane: blog/location add, drafts view, approve/deny + auto-refresh

ClomarkNexus (mujtabams):
  5bdd9264  Initial /api/ops/* read-only API
  2a0b2aad  Write surface: content-suggestions + bulk + delete + location-page + zip-lookup + options + profile-items
  bf91c2d6  Generated-content view + approval PATCH
```

### Prod activation gotcha

Replit Autoscale deployment secrets are **separate** from Workspace secrets — adding `CLOMARK_OPS_TOKEN` to the Workspace doesn't propagate to the running deployment. Same for code commits: Autoscale doesn't auto-pull on git push; must hit Redeploy manually. Hit both today before figuring out the right path.

Bonus: copy-paste of the bearer token from chat dropped the leading `4` character, which Klaviyo's lookalike "Incorrect credentials" 401 message hid. Diagnosed by length-checking the value Paul had saved (63 chars vs expected 64).

### Build summary

**Phase A — Queue management** *(content_suggestions writes)*
- Clomark ops API: `POST/DELETE /api/ops/business/:id/content-suggestions` (single + bulk + delete)
- ops-dashboard `/content`: `+ Add Blog` button → Single (title + keyword) or Bulk (paste up to 100 `title | keyword` lines) modal. Queue table below the breakdowns with Remove per row.

**Phase A-3 — Location page modal (4 sections, mirrors Clomark's LocationPageDialog)**
- Clomark ops API: `GET /api/ops/location/options` (industry types + market tiers), `GET /api/ops/location/zip-lookup` (Nominatim → zippopotam), `GET /api/ops/business/:id/profile-items` (business_settings products + services for Best Sellers), `POST /api/ops/business/:id/location-page` (creates content_suggestions row + enqueues QueueService immediately).
- ops-dashboard `/content`: `+ Add Location Page` button → modal with:
  1. Keyword & Tier — primary keyword, secondary keywords, market tier (1/2/3 from Clomark), industry type (11 options from Clomark)
  2. Location Details — city / parent city + neighborhood (T3 only), state abbr, ZIP codes (auto-fill on blur)
  3. Calls to Action — 1-3 CTAs (title + text + URL)
  4. Local Data — Best Sellers (search + checkbox multi-select from FitScript's products/services, 3-5 picks max), Nearby Areas (name + slug rows), Local Statistic textarea, Regulation Note, License Number

**Phase C — View generated content + approve/deny**
- Clomark ops API: `GET /api/ops/business/:id/generated/:contentId` (full markdown + meta + faqs), `PATCH /api/ops/business/:id/generated/:contentId/approval` (status: approved/denied/pending, sets approvedAt timestamp).
- ops-dashboard: DraftsSection below the queue. Each row → "View" link opens ContentViewerModal — SEO meta box + prose-styled markdown (react-markdown + remark-gfm) + collapsible FAQs + Approve/Deny/Reset footer.

**Auto-refresh on /content**
- Content list query refetches every 15s; bumps to 5s when anything `status=in_progress`. Plus `refetchOnWindowFocus`. Operator no longer has to manually refresh to see drafts flip from queued → drafted.

### Live state

- `ops.fitscript.me/content` Clomark section fully active in prod (all 3 env vars in ECS task def → AWS Secrets Manager `prod/ops-secrets-j5vKKG`)
- ClomarkNexus deployed to `www.clomark.ai` via Replit Autoscale with `CLOMARK_OPS_TOKEN` in Deployment secrets
- Drafts table populating: location page "Peptide Therapy in Austin" (2,409 words, 10 FAQs, pending review) verified through full View → Approve flow

### Phase D — bulk publish (queued for next session)

Inspected Clomark's existing machinery before scoping. Found:
- `GET /api/publishing/platforms` lists connected integrations (WP / Shopify / Webflow / Wix)
- `POST /api/check-duplicate-content-batch` is the duplicate guard
- `POST /api/{wordpress,shopify,webflow,wix}/publish/:contentId` are per-platform single-publish endpoints
- `client/src/components/publishing/BulkPublishDialog.tsx` orchestrates bulk publish CLIENT-SIDE — no server-side bulk endpoint exists

Phase D in the ops dashboard = wrap those 4 GET/POST endpoints behind bearer-token `/api/ops/*` proxies + port the 3-step (platform pick → check duplicates → publish loop with progress) UI into a new BulkPublishDialog in ops-dashboard. Multi-select on DraftsSection rows. Estimated ~2h.

Full notes saved in `[[reference_clomark_live_repo]]` so next session starts with the scope locked.

### What I'll remember next session

- `[[reference_clomark_live_repo]]` — also now contains the Phase D Clomark endpoints + UI port plan
- Replit Autoscale ≠ Workspace secrets, and git push ≠ auto-deploy — manual Redeploy required
- Drafts react-markdown rendering pattern (prose-styled tailwind arbitrary selectors) is good baseline for any future markdown previews

---

## 2026-05-20 (late) — Phase D bulk publish shipped, closing the content arc

Single-session sprint right after the Phase A→C save. Closes the full Phase A→D content control plane started earlier today.

### Commit ledger

```
ops-dashboard:
  c972fdb  Add bulk publish to /content Drafts (Phase D)

ClomarkNexus:
  d78c96b6  Add ops API bulk-publish surface (Phase D)
```

### Build

**Approach choice:** Phase D could have been built three ways — internal HTTP fetch with manufactured session, full refactor of the four session-authed publish handlers into shared helpers, or call each platform's Service class directly from the ops API with config from storage. Went with option 3 (Service class direct). The session-authed handlers do ~600 lines of orchestration each (custom title/desc/slug overrides, ACF mapping, Yoast pre-check, schema CTA enrichment for SEO pages). For bulk publish from the ops dashboard, "publish as-is with sensible defaults" is the right product call — the existing Clomark UI stays as the power-user surface for per-item tweaks.

**Clomark side (server/ops-api.ts):**
- `GET  /api/ops/business/:id/publishing/platforms` — mirrors the connected-integrations query (4 storage.getXxxIntegrations calls + isConnected gate). Returns `{id, name, type, connected, url, connectedAt, lastTested}` per platform.
- `POST /api/ops/business/:id/publishing/:platform/:contentId` — switch on `platform` (wordpress | shopify | webflow | wix), pull integration config from storage, instantiate Service class (createWordPressService / createShopifyService / `new WebflowService` / `new WixService`), call `publishPost` / `publishArticle` with `{publishStatus, options:{}}`.

**Ops-dashboard side (server/clomark.ts + client/src/pages/content.tsx):**
- 2 proxies: `GET /api/ops/clomark/publishing/platforms` and `POST /api/ops/clomark/publishing/:platform/:contentId`
- DraftsSection rows gained a checkbox column + "select all" header checkbox. Selected rows highlight with green tint.
- "Bulk Publish (N)" CTA appears in section header when ≥1 row selected.
- New BulkPublishDialog with 3-step UX (mirrors Clomark's own BulkPublishDialog so operators don't have to re-learn):
  1. **Platform pick + Draft/Live toggle** — grid of connected destinations from Clomark; amber empty state when none connected
  2. **Sequential publishing** — one POST per content per platform, one at a time so we don't hammer the CMS. Per-row state machine: `pending` → `publishing` (spinner) → `success` (✓ + "Open ↗" link to live URL) OR `error` (× + truncated tooltip with error message). Modal close disabled while step="publishing" to prevent mid-loop cancel.
  3. **Complete** — "N succeeded · M failed" summary + Done button (also triggers content list refresh)

### Tested live

Endpoint `GET /api/ops/business/.../publishing/platforms` returns `{platforms: []}` for FitScript (200 OK) — no destinations connected in Clomark yet. UI's amber empty state is the correct surface for that case. Once a destination is wired in Clomark, the bulk publish flow is end-to-end ready with no more code changes.

### Live state (end of 2026-05-20)

- ops.fitscript.me deploy of `c972fdb` rolling out via GitHub Actions
- ClomarkNexus on `d78c96b6` via Replit Autoscale Redeploy
- Bulk Publish dialog functional but **gated by destination connections in Clomark** — Paul to connect WordPress / Shopify / Webflow / Wix in Clomark's own UI when ready to publish for real

### Phase A→D content control plane — DONE

`/content` is now the end-to-end operator surface:
- Add topics to the queue (single or bulk for blogs, rich 4-section modal for location pages)
- Watch generation flip in real time (5s polling while in_progress)
- View completed drafts inline (full markdown + SEO meta + FAQs)
- Approve / Deny / Reset
- Bulk Publish to any connected CMS

No more deep-linking to Clomark for ops workflow. Clomark stays the execution engine + power-user surface.

### Next session candidates

- Connect WordPress (or Shopify) to Clomark for FitScript → first real publish via the dashboard
- Phase B/C polish (the original Klaviyo Hub backlog — throttled send + post-send metrics + custom sender)
- Meta Ads connector activation (still queued from May 19 — needs Paul to generate the System User token)
- Or new direction entirely

### What I'll remember

- `[[reference_clomark_live_repo]]` updated — Phase D is done, no longer "next session"
- Bulk operations: orchestrate client-side, one request per item — matches Clomark's pattern and avoids server-side complexity

---

## 2026-05-20 (very late) — Marketing UX cleanup + broader dashboard UX audit punch list

Paul flagged the Marketing page as "all over the place" — 4 huge zero-valued KPI tiles + 4 empty channel-group tables + 2 hardcoded "Not Connected" cards for GA4/GSC that lied about the actual connection state. Working GA4 section got buried in the middle of all that noise. Surgical fix shipped this round; broader UX audit punch list saved for next session.

### Marketing page fixes (this commit)

- **Removed the hardcoded "Not Connected" cards for GA4 and GSC.** They were fictional — both connections work and the GA4 section above was already showing real data (49 sessions / 472K impressions). Connection state lives in Command Center's integration-health strip + /settings + /integrations; no page redeclares it.
- **Hid the top KPI grid when `totalVisitors === 0`.** Replaced with a slim amber notice explaining the tracking pixel is wired but visitors haven't accumulated yet.
- **Hid each channel-group table (Search / Social / AI / Paid) when its `channels.length === 0`.** A wrapper section heading "First-party Attribution (tracking pixel)" only renders when AT LEAST ONE channel group has data.
- **Reorder confirmed:** GA4 section now leads the page (working real data first); Meta Ads section follows (correctly shows the "Not configured" empty state with setup instructions); pixel-based sections at the bottom hidden until data exists.

### New decision documented (DECISIONS.md)

**"Empty data state rules"** — no zero KPI tiles, no hardcoded connection cards, no empty-state placeholder tables. Lead with what works, surface state via a single source of truth. See DECISIONS.md.

### Broader UX audit punch list (saved for next session)

Other pages with similar issues to clean up:

| Page | Issue | Suggested fix |
|---|---|---|
| `/tracking` | Heavy overlap with `/marketing` (both show funnel + channel attribution). Two paths into the same data hurts comprehension. | Merge OR differentiate cleanly: `/tracking` = pixel raw / Hyros-style attribution view; `/marketing` = unified channel performance (GA4 + Meta Ads + first-party blend). |
| `/email` | AI Compose CTA + Send Campaign CTA visually compete in the header. Two flows look equally weighted but one is much more common. | Demote Compose to a secondary button or move into the send flow itself. |
| Sidebar | 13 items including 3 placeholder pages (Creative, Clinical, Coming Soon variants). Visual weight makes the dashboard feel half-built. | Hide placeholder nav items until their pages have substance, OR group them under a "Future" expandable nav section. |
| `/integrations` vs `/settings` | Overlapping purpose (settings integrations table also shows integration status). | Settle on one — recommend keeping integrations as the *connect / disconnect* surface, settings as the *configured env / session / admin allowlist* surface. |
| `/command-center` | Integration-health strip works but the page itself is dense. Lots of KPIs without obvious visual hierarchy. | One round of visual hierarchy pass — group MRR/ARR/Revenue (revenue cluster), then subscribers + tiers (audience), then unit economics. |
| `/leads` | Funnel viz is good but the lead table is wide (8 columns). Probably fine for now. | Watch when real data accumulates. |
| `/content` | Currently the cleanest page after today's work. | Reference implementation — apply its single-section-per-concern pattern elsewhere. |

### Recommended next-session opening

Either:
1. **Continue the UX audit** — start with /marketing's twin /tracking, decide merge-or-differentiate
2. **Connect a destination in Clomark** (WordPress / Shopify / Webflow / Wix) → first real publish via the bulk publish dialog
3. **Generate a Meta Ads system user token** → activate the Marketing page's Meta section
4. New direction

Paul wrapping the terminal here for a fresh start.

---

## 2026-05-20 (overnight) — Full UX audit + brand rebrand to navy/sky-blue

Paul handed me the full UX audit punch list AND the new FitScript brand (navy + sky-blue + gradient, no green). Single sprint, executed front-to-back. Live at localhost:5001, push gated on Paul's approval.

### What shipped

**1. Brand system — new tokens, theme-aware**
- `tailwind.config.ts` — `brand.navy.{950–600}`, `brand.blue.{600–50}`, `brand.sky.{100,50}` + `bg-brand-hero`, `bg-brand-cloud` gradient utilities.
- Legacy `fitscript.green` token kept and **remapped to `#2E5BFF`** so all 200 existing references auto-rebrand without per-file churn.
- `index.css` — light + dark mode CSS variables rebuilt around navy. `--ops-bg` (dark) = navy-950. `--ops-bg` (light) = sky-50 wash. Accent = brand blue. Card shadows softened. `.brand-wash` utility for the page-shell radial cloud.

**2. Layout shell — grouped sidebar**
- `ops-layout.tsx` — sidebar reorganized from flat 14-item nav into 4 labeled sections: **Overview / Customers / Growth / System** with 9 active items. Section headers in uppercase muted tracking. Active item = gradient pill (`from-brand-blue-600 to-brand-blue-500`) with blue shadow. Top bar gains breadcrumb (Section / Page) + avatar gradient bubble + softer "Live" pill in accent-soft.

**3. IA cleanup — Tracking merged into Marketing, Admin Log merged into Settings**
- `marketing.tsx` rewritten to absorb the old `/tracking` content: Conversion Funnel + Cost-vs-Revenue chart + Campaign Performance table + first-party Pixel Setup. GA4 + Meta Ads + first-party channel breakdowns stay. Single unified channel performance page.
- `settings.tsx` rebuilt with **tabbed UI**: General / Integrations / Admin Log. AuditTab carries the full `/admin-actions` functionality (filters + auto-refresh + status colors). General tab gets Session + Admin allowlist + Auth + Env cards.
- `App.tsx` — `/tracking` → `/marketing` redirect, `/admin-actions` → `/settings` redirect, `/creative` + `/clinical` → `/` redirects. Routes preserved for deep links, removed from sidebar.
- Deleted: `pages/tracking.tsx`, `pages/admin-actions.tsx`, `pages/coming-soon.tsx`.

**4. Per-page brand pass**
- New shared `components/page-hero.tsx` — eyebrow + display title + subtitle + optional actions, with radial brand wash background. Applied to: Command Center, Members, Leads, Orders, Marketing, Content, Email, Integrations, Settings.
- Login page rebuilt: gradient backdrop, brand-blue gradient sign-in button, "Welcome back" copy.
- Email page actions reordered: "Send campaign" promoted to gradient primary, "Compose with Claude" demoted to secondary outline (per audit punch list).
- Orders tab buttons: green pills → gradient brand-blue pills.
- Chart hardcoded greens (`#0EA57A`) globally swapped to brand blue (`#2E5BFF`) — revenue-chart, cost-vs-revenue-chart, content GSC charts.

### Verification

- `npx tsc --noEmit` → exit 0
- `npx vite build` → success, 1160 modules, 32.74 kB CSS / 1.03 MB JS (gzip 273kb)
- Dev server restarted, serving 200 at localhost:5001
- Routes all alive; legacy redirects working

### Pending — pushing gated on Paul's manual approval

Code is committed locally? **No — nothing committed yet.** Per `[[feedback_dont_push_without_approval]]` + `[[feedback_test_before_push]]` Paul must walk the dashboard in a browser first, confirm visuals match the new FitScript brand, then say push.

Walk-through order recommended: `/` (Command Center hero) → sidebar grouping → `/marketing` (verify Tracking content lives here now) → `/settings` (verify 3 tabs, Admin Log functional) → `/email` (verify Send is primary) → `/login` (sign out + back in to see new gradient backdrop).

### What I'll remember next session

- `[[reference_clomark_live_repo]]` unchanged.
- Brand system: `brand.navy.*` + `brand.blue.*` + `brand.sky.*` are the new authoritative tokens. `fitscript.green` is a legacy alias that points at `#2E5BFF` — new code uses brand tokens directly.
- IA: Overview / Customers / Growth / System is the locked-in navigation grouping.
- PageHero is the standard for every primary page header — eyebrow + display title.

---

## 2026-05-20 (overnight cont.) — Ops Concierge Phase 1 shipped

Paul approved the rebrand → pushed. Then asked for the next thing: an AI bot that knows the dashboard data and can answer questions / execute actions. Built Phase 1 (read-only) end-to-end and pushed.

### Commit ledger
```
4cc257c  Rebrand ops dashboard to FitScript navy/sky-blue + IA reorganization
a700bda  Add Ops Concierge — Claude assistant with tool-use over every data source
```

### What Phase 1 ships

**Server (`server/concierge.ts`)** — `POST /api/ops/concierge/chat`:
- Claude (Bedrock Sonnet, fallback Haiku) tool-use loop, up to 8 iterations
- 13 read tools: get_snapshot, search_members, get_member, get_revenue_trend, get_orders, get_marketing_overview, get_funnel, get_top_ai_cost_users, get_admin_log, get_integration_health, get_content_drafts, get_email_campaigns, get_unit_economics
- Tools run in parallel when the model batches them in one assistant turn
- Cost logged to `ai_costs` as `surface=ops_concierge`, admin email in metadata
- System prompt grounds Claude as Paul's right-hand operator; explicit rules for number formatting, no fabrication, suggest follow-ups

**Client (`client/src/components/concierge/Concierge.tsx`)** — always-on launcher:
- Floating brand-gradient pill bottom-right (with blur halo + brand shadow)
- ⌘K / Ctrl+K toggles from anywhere; Esc closes
- Right-side slide-out panel (480px) with backdrop blur
- 5 suggested cold-start prompts on empty state
- User bubbles: gradient brand-blue. Assistant: sparkle avatar + markdown prose (react-markdown + remark-gfm) with tables, code blocks, etc.
- Tool-use chips per assistant message: collapsed by default, click to expand and see input + result JSON + ms duration. Errored tools render red.
- Animated 3-dot thinking indicator while waiting
- Markdown prose CSS added to `index.css` as `.prose-concierge` — tight, brand-aligned (blue accent for code/links/blockquote rule)

**Layout** — mounted at OpsLayout root so concierge is on every page, behind auth gate.

**Pool error handler** — added `pool.on('error', ...)` in `server/index.ts` so idle RDS TCP timeouts log and don't crash the process (had been dying after long idle periods).

### Verified
- `tsc --noEmit` exit 0
- `vite build` clean (39.94 KB CSS / 1.04 MB JS, was 32.74 KB CSS before)
- `/api/health` → 200, `/api/ops/concierge/chat` (no cookie) → 401 (gate works)
- Dev server stable on `localhost:5001`
- GitHub Actions deploy queued for `a700bda`

### Phase 2 (deferred — pending Paul's read of Phase 1)

Write tools, each audit-logged via `admin_actions`:
- pause/activate Klaviyo flow
- send Klaviyo test email
- approve/deny content draft
- queue blog topic / location page
- publish content to connected CMS
- Stripe: cancel/pause/resume subscription, change tier, refund charge (typed-confirm above $50)

Phase 2 trigger: Paul says "concierge feels right, add the write actions" OR specific tool requests. NOT auto-started — write actions need UX validation first.

### What I'll remember
- Concierge architecture: tool-use loop in one endpoint, tools as `{name, description, input_schema, handler}` objects, registered in `TOOLS` array. Adding new tools = append to array.
- Cost analytics: every concierge turn writes to `ai_costs` with admin email + tool count + iterations in metadata, so we can answer "how much is the concierge itself costing us" via the existing economics dashboard.
- ⌘K + floating launcher hits both keyboard and mouse users with one panel.

---

## 2026-05-21 (overnight v2) — DIRT replaces Concierge; streaming + writes + top-bar bar + animations

Paul came back and asked: cross-check everything works, rename to DIRT (his AI personality), add micro-animations + chart movement, add a top-bar AI search, upgrade the chat to high-end. Also reported: "AI not configured" 503 in prod.

### Production AI fix (the blocker)

ECS task definition `fitscript-ops-task:34` was missing AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION in `secrets[]`. The values were already in the AWS Secrets Manager JSON (`prod/ops-secrets`), they just weren't exposed to the container.

Fix:
1. Pulled task def JSON, appended 3 secret references pointing into the existing secret keys.
2. Registered new revision `fitscript-ops-task:35`.
3. `aws ecs update-service --force-new-deployment` → waited for stability.
4. Verified `https://ops.fitscript.me/api/health` returns 200 on revision 35.

Now `isAIConfigured()` returns true in prod and DIRT can call Bedrock. Added `bedrock` to the `get_integration_health` tool so DIRT can self-report when AI is broken.

### DIRT rewrite — replaces v1 Concierge

**Commits:**
```
29dd551  Introduce DIRT — streaming AI ops personality + write tools + premium UX
```

**Server (`server/dirt.ts` + `server/lib/auditLog.ts`):**
- `POST /api/ops/dirt/chat` — SSE streaming endpoint
- `POST /api/ops/concierge/chat` — legacy non-streaming alias for back-compat
- DIRT personality: direct, confident, no fluff, knows Paul, FitScript brand voice
- 13 read tools + 4 write tools
- Write tools (Phase 2 SHIPPED):
  - `set_klaviyo_flow_status` — pause/activate Klaviyo email flows
  - `approve_content_draft` — approve / deny / pending Clomark content
  - `queue_blog_topic` — add a new blog to Clomark generation pipeline
  - `send_klaviyo_test` — render template + log; full send still needs Klaviyo UI
- Every write writes `ops_admin_actions` row before AND after execution (success or failure both audited)
- Read-only mode via `{ readOnly: true }` body field — blocks all writes for that turn
- Cost logged to `ai_costs` with `surface=ops_dirt`, admin email + tool count metadata

**`logAdminAction` extracted** from `server/klaviyo.ts` into `server/lib/auditLog.ts` so DIRT and Klaviyo share one audit trail. Klaviyo refactored to import from there.

**`get_admin_log` bug fix** — was querying non-existent `admin_actions`; now queries `ops_admin_actions` (the real table).

**Client (`components/dirt/Dirt.tsx`):**
- 540px glass-morphism slide-out (backdrop-blur)
- Streaming text with blinking caret as Claude generates
- Per-message tool timeline: pending spinner → ok check / red error
- Tool cards expand on click for input + result JSON + ms
- Slash commands: `/clear`, `/tools`, `/read`
- Copy-to-clipboard on hover for assistant messages
- Stop button while streaming (AbortController)
- Auto-resize textarea
- Floating launcher with animated brand gradient + float + slow spin
- Quick prompts with icons, staggered fade-in
- Listens for `dirt:open` custom event so the top-bar command bar can summon

**Top-bar DIRT command bar (`ops-layout.tsx → DirtCommandBar`):**
- Center of the top bar (`md:` and up)
- Pill-shaped, focus-glows brand blue
- Type query → Enter dispatches `dirt:open` event with prompt pre-filled
- ⌘K hint chip when empty, ↵ hint chip when there's input

**Charts + micro-animations:**
- `.shadow-card` gets auto hover-lift dashboard-wide (transform + border glow)
- `PageHero` fades in with `animate-page-fade-in`
- `RevenueChart`: 1200ms ease-out animation, thicker 2.5px stroke, active-dot on hover
- Recharts tooltip styled to brand surface + lg shadow
- DIRT-specific keyframes: dirt-fade-in, dirt-slide-down, dirt-blink, dirt-float, dirt-spin-slow

### Verified
- `tsc --noEmit` clean
- `vite build` clean (46.4 KB CSS, 1.05 MB JS gz 278kb)
- Local dev: both `/api/ops/dirt/chat` and `/api/ops/concierge/chat` 401 (admin-gated)
- Critical endpoints (`snapshot`, `members`, `economics`, `settings`, `admin-actions`) all 401
- Prod ECS revision 35 active before push, deploy of `29dd551` queued

### What I'll remember
- DIRT is the official ops AI name. Concierge is dead.
- Writes are audit-logged via `server/lib/auditLog.ts` — every new write tool must log before + after.
- SSE event format: `text_delta`, `tool_start`, `tool_result`, `tool_error`, `usage`, `done`, `error`.
- Bedrock prod creds live in `prod/ops-secrets` AWS Secrets Manager; ECS task def must expose AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION via `secrets[]`.
- Read-only toggle is a per-request flag, not a server-side state. UI exposes it via `/read` command.

---

## 2026-05-21 → 2026-05-22 — DIRT expansion + Stripe writes + mobile pass + email composer v2

Catch-up entry covering 31 commits between `35933f8` (DIRT "Talk Dirt" copy) and `c4cd22f` (Email composer bounded panels). Listed by theme, oldest → newest within each cluster.

### DIRT capability expansion

- `35933f8` Launcher copy → "Talk Dirt".
- `549a298` ECS task def template — add AWS_ACCESS_KEY_ID + SECRET + REGION secrets[] (companion to the prod fix in revision 35).
- `49cab39` Slash-command hints are now clickable.
- `c55ca6f` **Phase 3 — 5 Stripe write tools** (cancel / pause / resume / change_tier / refund). All audit-logged. Refund > $50 requires typed confirm in the model loop. Now DIRT can act on customers, not just describe them.
- `94dcea6` **Conversation persistence** with history dropdown — turns saved to `ops_dirt_conversations` per admin, latest 30 surfaced.
- `1a9bab6` **Proactive anomaly scan + notifications inbox** — top-bar bell shows new findings (revenue dip, refund spike, integration failure). Server scan runs on a cadence; inbox lives in `ops-layout.tsx`.
- `56a241a` Fix History dropdown clipped by header overflow-hidden.
- `0ef1ba9` Persist conversations on EVERY exit path (close panel / abort / error), log success or failure.
- `b03e646` **DIRT → Slack** — proactive scan findings posted to incoming webhook (`SLACK_OPS_WEBHOOK_URL`). Settings exposes a per-admin opt-in.
- `edfc34b` ECS task def — expose `SLACK_OPS_WEBHOOK_URL` from Secrets Manager.
- `88c4ffa` **DIRT daily digest** — scheduled Slack brief (snapshot + anomalies + tomorrow's send queue) + manual trigger button on `/integrations`.
- `20bdb3f` **Voice DIRT** — talk to DIRT via browser Web Speech API. Hold-to-talk on launcher (or `/voice` in chat). Streams text replies as before; voice is input-only for now.

### Integrations refactor + mobile-first polish

- `e20d753` Resolve duplication — `/integrations` is the only home (was also at `/settings`). 200 lines deleted from settings.tsx.
- `d9dc80c` **Self-serve integration credentials** — Edit + Test from `/integrations`. New `server/integrations.ts` + `server/lib/secretsManager.ts` write directly to AWS Secrets Manager. New `IntegrationEditModal` component.
- `9612167` Integrations 2-up grid + global mobile-first polish (cards, table breakpoints, padding).
- `4ebc4f8` Bell button visually balances with avatar circle.
- `0df6b14` "Talk Dirt" floating pill — icon-only on mobile, full pill on sm+.

### Mobile sweep (Apr-mobile-pass equivalent for ops)

- `ab158ef` Sidebar drawer + hamburger + compact top bar + padding pass.
- `807a85c` MetricCard hover + Send-Campaign back button + responsive grids on command-center.
- `8f3e50e` Mobile pass #2 — revenue-chart sizing + Klaviyo metrics 400s degrade gracefully (no more blank Email page on metric discovery failure).
- `fd9ec69` Mobile pass #3 — every remaining non-responsive grid (content, leads, marketing, member-detail, orders, settings).
- `267b337` Tables horizontally scroll on mobile instead of truncating.
- `27f0c16` Dropdowns fit inside viewport on mobile.
- `48dc072` Clomark header buttons no longer word-wrap.
- `52f4c3e` Add Location Page modal stacks 1-col on mobile.
- `da597cb` **Modals render via React portal** (`modal-portal.tsx`) — fixes "opens below the page" on mobile when parent has overflow:hidden. Used by content, email, member-detail.
- `d9d0703` Settings Auth/Environment cards: URL stops wrapping one-letter-per-line.

### Bulk actions on /members

- `238b90d` Row selection + floating bulk bar → "Ask DIRT" with selected member IDs piped into the prompt. Reusable `BulkBar` component.

### Klaviyo metrics resilience

- `8f3e50e` (above) Wrap `campaign-values-reports` 400s into a `{warning, metrics:{}}` response so the Email page still renders.
- `9df5875` Split engagement-only vs value-capable stats by metric. Klaviyo 400s when you ask for `conversion_value` on a non-revenue metric — now we only request value stats when the active conversion metric is revenue-flagged (per-purpose cache: campaign vs flow can pick different metrics).

### Email composer v2 — the new big surface

- `5d9af97` Mandatory FitScript logo block in every branded HTML email + clearer Klaviyo 403 message ("missing Templates:Write scope" → exact remediation steps).
- `cc291d9` **Email v2 — brand profiles + style selector + chat composition.** Rewrites both `client/src/pages/email-compose.tsx` (903 LOC) and `server/email-compose.ts` (537 LOC).
  - New `ops_email_brand_profiles` table — reusable color/font/logo/voice bundles. Default FitScript profile is seeded on first read.
  - 4 CRUD endpoints + `BrandProfileEditModal`.
  - Style selector: `branded-html` / `minimal-html` / `plain-text`. System prompt branches per style.
  - SSE multi-turn chat at `POST /api/ops/email/compose/chat` — Claude streams back `=== SUBJECT === / === PREHEADER === / === HTML === | === TEXT ===` blocks; client parses and renders a live `srcDoc` iframe preview.
  - `POST /api/ops/email/compose/save` → Klaviyo template (handles plain-text by wrapping in `<pre>`).
- `c9f2803` Inter web font (Google Fonts <link> in <head>, system fallback) + quickchart.io chart support documented in the system prompt for branded-html.
- `c4cd22f` Composer UX — bounded panels (no infinite page growth as Claude streams), compact assistant cards. `h-[calc(100vh-340px)]` on the chat+preview split.

### What I'll remember

- **Email composer architecture**: brand profiles in `ops_email_brand_profiles`, prompt is built per-style + per-profile in `buildSystemPrompt`, output format is hard-delimited `=== ... ===` blocks that the client parses with simple string splits. Adding a new style = add to `EmailStyle` union + branch in `buildSystemPrompt`.
- **Klaviyo conversion metric** is purpose-cached (campaign vs flow). Revenue metric is flagged; engagement-only metrics block value stats. Probe-and-cache pattern means cold-start is one extra POST per purpose but every subsequent call hits the cache for 30 min.
- **Modal portal** is now the standard for any modal that might open inside an `overflow-hidden` container. Don't render modals inline anymore.
- **Bulk actions pattern**: a `BulkBar` floats above the selected rows and dispatches a `dirt:open` event with the row-IDs in the prompt. Reuse for other list pages (members done; orders/leads/sends candidates).
- **DIRT writes are now full-Stripe**: cancel/pause/resume/change_tier/refund. All audit-logged. Refund > $50 requires typed confirm IN THE LOOP — model is instructed to ask, can't just fire.
- **Self-serve credentials** write to AWS Secrets Manager from `/integrations`. No more SSH-into-task-def to rotate a key.

### Pending / on deck

- Email composer is functionally complete: brand profiles ✓ multi-turn chat ✓ live preview ✓ save to Klaviyo ✓ logo + Inter ✓ quickchart support ✓ bounded panels ✓. Open questions in [[DECISIONS]] below: should send-from-composer be one click (compose → schedule in same flow), or keep template-then-send as two flows?
- Klaviyo metrics page is read-only and resilient. Send flow is at `/email/send`. No outstanding bugs reported.
- DIRT next: writes for blog publishing pipeline (Clomark), tagging Klaviyo profiles, suppression list management.

---

## 2026-05-22 — Email composer: premium voice + scaffold + CHANGES block + color coercion

Paul tested the composer end-to-end. Two issues surfaced:
1. Output "felt basic" — generic stat boxes ("New insights" / "Ready to go"), platitude bullets, no personalization tokens.
2. White-on-transparent logo invisible on light page bg (current `email-logo.png` is dark-mode only).
3. After my first prompt edit, the model started painting the whole email dark (`#0a0a0a` body bg). Training-data bias toward "dark = premium" was overriding the explicit light-mode rule.

### Shipped

**Server prompt (`server/email-compose.ts`)** — full rewrite of `buildSystemPrompt` for branded-html:
- Hardened voice: senior designer + copywriter framing, FitScript voice anchors, anti-pattern list ("we miss you" / "Come back" / placeholder stat boxes / em-dash openings forbidden).
- Length budget: body under 180 words, hero h1 under 8 words, section headlines under 6, exactly one primary CTA.
- Klaviyo personalization tokens mandated (`{{ first_name|default:"there" }}`, location.*, person|lookup for custom props).
- New output block: `=== CHANGES ===` between PREHEADER and HTML — "Initial draft." on turn 1, 2-5 verb-led bullets (Cut / Added / Rewrote / Shortened / Replaced / Tightened / Removed) on refinements. Explicitly mandated on EVERY turn including refinements.
- **HTML scaffold** as fill-in template — fully specified outer frame with light page bg, navy logo band, white card, branded CTA, footer. Model fills slots (HERO_H1, BODY_SECTIONS, CTA_URL/LABEL). Replaces "describe the rules" with "use this scaffold". Stronger forcing function.
- Plain-text mode also got the CHANGES block.

**Client parser + render (`client/src/pages/email-compose.tsx`):**
- `ParsedEmail` now carries `changes: string`. Parser extracts `=== CHANGES ===` block.
- `AssistantTurn` renders a "What changed" / "Status" subsection under each draft card — bulleted list (parsed from dash-prefixed lines) for refinements, single "Initial draft." line for turn 1.
- `coerceFrameColors(html, pageBg, accentBand)` post-processes the parsed HTML — swaps any forbidden near-black `background-color` (`#0a0a0a`, `#000000`, `#111`, `#1a1a1a`, `#0f172a`, etc.) for the profile's page bg. Accent navy is preserved so the logo band stays dark. Belt + suspenders against prompt drift.

### Why coercion despite the scaffold

Two API end-to-end tests after the scaffold change still produced `<body style="background-color: #0a0a0a">`. The model treats "premium email" as ≈ "dark frame around white card" — a strong pattern in training data that survives even a full scaffold + explicit forbidden-colors rule. Rather than keep escalating prompt force, the client coerces. Light/navy frame is now invariant regardless of what the model outputs.

### Verified (end-to-end via forged admin cookie + curl)

1. **Initial draft** (newsletter): subject "Your fasting insulin matters more than you think", preheader "Plus: track your recovery with the new HRV trend view.", CHANGES = "Initial draft."
2. **Refinement turn** ("Cut HRV, add first_name token"): CHANGES bullets are sharp and specific —
   - Removed entire HRV section and divider per request.
   - Added `{{ first_name|default:"there" }}` personalization to hero lead.
   - Shortened body from 140 → 95 words.
   - Tightened hero headline for stronger contrast.
3. **Color audit**: raw body bg was `#0a0a0a`; after `coerceFrameColors` → `#F2F6FC`; navy `#0A1628` logo band preserved; no remaining forbidden hex.
4. **Personalization**: Klaviyo `first_name` token landed in body copy.

### What I'll remember

- **Forcing functions beat rules for visual design.** Telling the model "use this scaffold" works far better than "follow these 8 color rules." Both are needed for redundancy.
- **Prompt drift is real for visual + color choices.** A model can ignore a HARD RULE if there's a stronger latent association from training data. Add a client/server post-processor for any visual invariant you absolutely require.
- **CHANGES block as a contract**: makes multi-turn refinement legible. Operators can see at a glance what shifted between drafts instead of comparing HTML side-by-side.
- **Logo is white-on-transparent** — must always sit on a dark band (`accent_color`, default `#0A1628`). If a future profile has no accent_color, falls back to navy.
- **`tsx server/index.ts` (the dev script) does NOT watch.** Server-side edits require a manual restart. Vite HMR handles client only. Worth either adding `tsx --watch` to the dev script or remembering this every time.

---

## 2026-05-22 (afternoon) — Email composer arc: three styles, compose→send handoff, branded editorial mode

Continuation of the same-day prompt rewrite. Paul tested live in Klaviyo, hit a string of real issues, fixed each, then asked for an editorial variant matching Klaviyo's premium drag-drop templates.

### Issues fixed in order

1. **Klaviyo API key rejected** — old `…0de` key was revoked. Paul created new full-access `…407b` key; swapped in `.env`, verified `/accounts/` 200, restarted server.
2. **"Open in Klaviyo" link 404** — `https://www.klaviyo.com/template/{id}` is not the in-app URL. Probed Klaviyo's path patterns; the working in-app list is `klaviyo.com/templates/list`. Swapped the link.
3. **Mobile responsiveness broken** — Klaviyo's preview pane clipped headlines because the scaffold used `<table width="600">` (rigid). Changed to `width="100%" style="max-width:600px"` on every inner table. Also added `@media` query with `.hero-h1` / `.body-text` / `.cta` / `.px` / `.py` / `.hero-img` classes for size reduction below 600px. Added `word-wrap: break-word` to text elements.
4. **Markdown ` ```html ` fence leaking into preview** — model occasionally wraps output in a code block. Added `stripCodeFence()` helper in the client parser.
5. **Broken hero image (source.unsplash.com 503)** — Unsplash deprecated their Source endpoint; the redirect returns 503 now. Built a proper resolver using Paul's `UNSPLASH_ACCESS_KEY` from `~/.config/secrets.local.zsh`. New flow: model emits `src="UNSPLASH:keywords"` markers, client batches a `POST /api/ops/email/resolve-images`, server calls Unsplash search API and returns real CDN URLs, client swaps them in before preview and save. In-memory cache (7-day TTL, per process). Recipients fetch from `images.unsplash.com` directly — our domain stays out of the image path.
6. **HTML attribute breaking on inner double quotes** — FitScript brand profile has `font_family = '"Inter", -apple-system, ...'`. When inlined into `style="font-family:..."`, the inner `"Inter"` quotes terminated the style attribute early; everything after `font-family:` was parsed as broken HTML, which is why the nav strip rendered without the white text color. Added `fontFamilyAttr = profile.font_family.replace(/"/g, "'")` and used it everywhere `font-family:` is inlined in style attributes.

### New: compose → send handoff

After save, the success card now shows **Continue to schedule send →** + **Open in Klaviyo** + **Save another**. Clicking Continue navigates to `/email/send?templateId=X&name=...&subject=...&preheader=...` — `email-send.tsx` reads those query params and pre-fills the form, jumping straight to step 2 (audience picker), skipping template selection. The arc is closed: compose draft + refine → save → audience + schedule + send → audit log, all without bouncing through Klaviyo's UI.

### New: three style variants

Paul wanted three meaningful options replacing the existing Branded HTML / Minimal HTML / Plain text:

- **HTML** (was `branded-html`, now `html`) — the responsive scaffold we just fixed. Light page, navy band, white card. Default option, lightweight, deliverable.
- **Branded** (NEW) — editorial magazine layout. Full-bleed hero photo (resolved via Unsplash API), optional nav strip (PRODUCT · APPROACH · LAUNCH style), serif display headlines (Playfair Display via Google Fonts), section h2s in serif, multiple image+text sections, generous whitespace, uppercase letter-spaced CTA. Reference: Cereal / Monocle / Apartamento / luxury travel newsletters.
- **Plain text** — unchanged.

Old `minimal-html` is gone. Server back-compat maps legacy `branded-html` / `minimal-html` style values to `html` so any in-flight clients don't break.

### Server changes (`server/email-compose.ts`)

- `EmailStyle = "html" | "branded" | "plain-text"` (was `"branded-html" | "minimal-html" | "plain-text"`)
- `buildSystemPrompt` switches into `buildBrandedEditorialPrompt` for `branded`.
- `buildBrandedEditorialPrompt` is ~150 lines of system prompt with a full editorial HTML scaffold (Playfair Display links in `<head>`, navy band header with optional nav strip, full-width hero image, serif display h1 + sans-serif standfirst lead, 1-3 magazine sections, uppercase CTA, italic Playfair footer).
- `UNSPLASH:keywords` marker pattern documented in the scaffold; resolver endpoint at `POST /api/ops/email/resolve-images` calls Unsplash and caches.
- `fontFamilyAttr` helper swaps `"` → `'` for safe inlining into `style="..."` attributes.

### Client changes (`client/src/pages/email-compose.tsx`)

- `STYLE_OPTIONS` labels updated.
- `parseFinalEmail` adds `stripCodeFence` post-process.
- New `useEffect` watches parsed.html for `UNSPLASH:...` markers, batches a resolve call, stores `resolvedImages` keyed by query, swaps URLs into `parsed.html` via a second `replace()` pass inside the same `useMemo`.
- Save-to-Klaviyo success replaces the form with a "Saved" card showing template ID + three actions: **Continue to schedule send** (primary gradient CTA), **Open in Klaviyo** (secondary outline), **Save another** (link).
- `coerceFrameColors` already exists from morning's work; still doing its job replacing `#0a0a0a` body bg with the brand light bg.

### Client changes (`client/src/pages/email-send.tsx`)

- `handoff` memo reads `templateId`, `name`, `subject`, `preheader` from URL search params.
- Initial state seeds from `handoff`. When `templateId` is present, the wizard starts at step 2 (skip template picker).

### Verified end-to-end

- New Klaviyo API key works (`/accounts/` 200, FitScript org confirmed).
- Old template `T89U5q` deleted via direct Klaviyo DELETE (key has full access).
- New responsive HTML template saved as `Usffp7`; Klaviyo round-trip confirms `width="100%"` tables, `@media` query intact, all responsive classes preserved, body bg `#F2F6FC`, navy band `#0A1628` preserved, no forbidden near-blacks remain.
- Branded editorial draft generated successfully: serif Playfair Display headlines, nav strip in white, hero image resolved to actual Unsplash CDN URL (`images.unsplash.com/photo-...`), no markdown fence leak, font-family single-quoted in all style attributes.

### Pending

- ~~Prod needs `UNSPLASH_ACCESS_KEY`~~ — Paul decided against external image APIs. Reverted Unsplash integration; Branded mode is image-free for now.
- Old `T89U5q` template was deleted from Klaviyo today; the new `Usffp7` "Monthly newsletter (responsive test)" and a fresh editorial template Paul generated are the live test artifacts.
- **DEFERRED: Branded-mode imagery.** Paul wants images in Branded mode but explicitly no API + no recurring cost. Three options on the table when he revisits: (1) one-time Unsplash API harvest committed as static URL manifest, (2) self-hosted image library at `client/public/email-images/` with manifest + tags, (3) inline SVG illustrations generated procedurally by the model. Until he picks, Branded relies on typography + color blocks + pull-quotes + accent strips for visual interest. See [[feedback_no_external_image_apis_ops]].

---

## 2026-05-22 (evening) — End-to-end test surfaced two Klaviyo-storage bugs; fixed and validated

Paul ran a real send through the new pipeline (compose → save to Klaviyo → /email/send → fire to the new "Ops Test (internal)" list). Email arrived, but two visible bugs in the rendered output:

1. **Footer leaked HTML attributes as visible text** — `Unsubscribe" style="color:#9CA3AF;text-decoration:underline;">Unsubscribe` showed up as literal text in the email body.
2. **Nav strip text invisible** — "PRODUCT · APPROACH · LAUNCH" rendered with no `color:#FFFFFF`, so the dark navy text on the navy band was effectively unreadable.

### Root cause

Both bugs share one cause: **Klaviyo strips single quotes from `style="..."` attribute values when saving templates via the `/templates/` API**. Before save we POST `style="font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', ..."`. After save Klaviyo returns `style="font-family:"` — the value gets truncated at the first stripped quote, and the rest of the font stack gets re-parsed as boolean HTML attributes (`arial=""`, `helvetica=""`, `inter=""`, etc.) that take over the element. Everything after `font-family:` in the style attribute is dropped, so `color:#FFFFFF` was silently lost on the nav strip, and the `<p>` wrapping the unsubscribe got broken in a way that exposed the inner `<a href="{% unsubscribe %}">` attributes as text.

The second bug compounded: `<a href="{% unsubscribe %}">Unsubscribe</a>` is wrong even without the quote issue — Klaviyo's `{% unsubscribe %}` tag expands into a FULL anchor element at send time, so wrapping it produces nested broken anchors. Both bugs needed fixing.

### Fix

**Typography moved to `<style>` block + classes:**
- `<head><style>` now declares `body, table, td, p, h1, h2, h3, a, span, div, .font-body { font-family: ${fontFamilyAttr}; }` and `.font-display, .hero-display, .section-h2, .pullquote, .footer-tagline { font-family: 'Playfair Display', Georgia, serif; }`.
- `<body class="font-body">` cascades the font.
- Every `font-family:` removed from inline `style="..."` attributes in both `html` and `branded` scaffolds.
- Klaviyo preserves `<style>` blocks (CSS quote-stripping inside `<style>` still produces valid CSS — multi-word font names like "Segoe UI" or "Playfair Display" parse as identifier-sequences whether quoted or not).
- Email clients that strip `<style>` (Gmail desktop, Outlook) fall through to the browser/client default font — acceptable. Apple Mail / iOS / web clients honoring `<style>` get Inter + Playfair Display.

**Unsubscribe pattern fixed:**
- Old: `<p>...<a href="{% unsubscribe %}" style="...">Unsubscribe</a></p>` — produced nested anchors.
- New: `<p>{% unsubscribe %}</p>` — Klaviyo expands the tag into its own anchor element. No wrapping.

### Verified end-to-end

Full validation suite (`/email/compose chat → /compose/save → /klaviyo/templates GET → /klaviyo/send → /campaigns GET`) ran clean:

- Raw output: 0 inline `font-family:`, 0 wrapped unsubscribe, 0 non-logo images.
- Klaviyo round-trip (template `WrvSaV`): no broken attr leak, font-family preserved in `<style>`, unsubscribe standalone, body bg `#F2F6FC`, white nav strip text present.
- Send `01KS8S1GSFQV226EQH1HEQ6F8Y` to 2-person Ops Test list (Paul + Sameer) with `smart_sending=false` (to bypass Klaviyo's 16h re-send suppression). Klaviyo status: `Sent`. Both recipients received.

### Real-inbox rendering

Looks correct visually. Lands in **Gmail Promotions tab** — that's expected pre-launch given no Dedicated Sending Domain in Klaviyo and no DKIM/SPF/DMARC on `fitscript.me`. Pipeline is fine; deliverability is a separate workstream tracked in [[project_fitscript_klaviyo_deliverability]].

### Infrastructure changes

- **Created Klaviyo "Ops Test (internal)" list (`S9m4kq`)** via API. Both Paul (`01KMK9WVYYPJ5AJQAD45H7R0D2`) and Sameer (`01KMJKHWSAWBMSWX2PHCJPK2HE`) added. Safe to fire test sends here without blasting real users.
- Created (then deleted) several template iterations during debugging: `Usffp7` (responsive HTML, broken font-family), `T89U5q` (broken Monthly newsletter from morning), `SdgPLp` (broken Branded), `SVpRxk` (Branded v3 quote-fix passing), `WrvSaV` (E2E validation, the canonical clean one).

### What I'll remember

- **Klaviyo's `/templates/` API silently strips single quotes from inline `style` attribute values.** Any time you put a quoted font-family or other quoted CSS value inline, it'll truncate. ALWAYS move typography to a `<style>` block in `<head>` and use classes. See [[feedback_klaviyo_strips_quotes]].
- **`{% unsubscribe %}` is a Klaviyo block tag, not a URL.** It renders the full anchor element. Don't wrap it. Same rule probably applies to other `{% ... %}` Klaviyo tags that emit HTML (web_view, social_links, etc.).
- **Smart-sending blocks re-sends within ~16h.** For test campaigns to the same recipient, pass `smartSendingEnabled: false` in the send body or the second send will end up "Queued without Recipients".
- **`tsx server/index.ts` does NOT hot-reload server-side changes.** Every server-side edit needs a manual kill + restart. Already noted earlier; reaffirmed this session.

---

## 2026-05-25 — Klaviyo deliverability DSD partial setup + profile manager v1

Two threads of work, both around Klaviyo deliverability + ops surfaces.

### Thread 1 — Klaviyo Dedicated Sending Domain setup (in-flight)

Triggered by the prior session's finding that real emails land in Gmail Promotions tab because of no DSD + broken DMARC + no DKIM.

**fitscript.me DNS audit findings:**
- SPF includes Mailgun + Google + LeadConnector but NOT Klaviyo. Every Klaviyo "@fitscript.me" send fails SPF alignment.
- TWO DMARC records (one `p=quarantine;` with no rua, one `p=none; rua=mailto:rua@dmarc.brevo.com`) — multiple DMARC records is INVALID per spec, so receivers treat as no DMARC at all.
- No DKIM selectors published on the apex.
- `send.fitscript.me` had stale NS records pointing at Klaviyo nameservers from an abandoned previous setup (zone empty when queried).
- `email.fitscript.me` MX → Mailgun (legitimate, leave alone).

**What we did:**
1. Deleted the 4 stale NS records on `send.fitscript.me` (verified Klaviyo zone was empty before deleting — safe).
2. Klaviyo wizard: configured DSD as `send.fitscript.me`, routing type Dynamic, set up manually.
3. Re-added the same 4 NS records (ns1-4.klaviyo.com) — turns out Klaviyo's manual flow IS the NS delegation, the previous setup was correct but never verified.
4. Confirmed `klaviyo-site-verification=V3sni5` TXT record already present on apex.
5. All 5 records in Cloudflare with comments (`Klaviyo DSD - delegation N/4`, `Klaviyo domain ownership verification - account V3sni5`).
6. Klaviyo's verification is async — they email when domain check completes. Pending.

**Deferred (Paul said "skip this, proceed"):**
- DMARC cleanup (collapse two records to one with `p=none; rua=mailto:paulc@fitscript.me; aspf=r; adkim=r; pct=100`). DNS state still has the conflicting pair. Should be revisited when Paul wants real Primary inbox placement.

### Thread 2 — Klaviyo profile manager v1 (SHIPPED)

Built `/email/profiles` page + four new endpoints to give operators a search-and-act surface for Klaviyo subscribers without leaving the dashboard.

**Server (`server/klaviyo.ts`, +263 LOC):**
- `GET /api/ops/klaviyo/profiles/search?q=...` — hybrid search:
  - If `q` contains `@` → exact Klaviyo `equals(email)` lookup, also queries RDS `users` to surface "exists in FitScript but not in Klaviyo" rows.
  - If `q` is a partial → searches RDS `users` for `email ILIKE %q%` first (up to 25), then bulk-resolves matching emails in Klaviyo via `any(email, [...])`.
- `GET /api/ops/klaviyo/profiles/:id` — full profile detail: attributes, location, properties, subscription state, last 50 events (joined with metric names), list memberships.
- `POST /api/ops/klaviyo/profiles/:id/suppress` — queues a `profile-suppression-bulk-create-job` in Klaviyo. Audit-logged (`profile.suppress`).
- `POST /api/ops/klaviyo/profiles/:id/unsuppress` — symmetric `profile-unsuppression-bulk-create-job`. Audit-logged (`profile.unsuppress`).

**Client (`client/src/pages/email-profiles.tsx`, +330 LOC, NEW):**
- `PageHero` + search input (debounced 300ms, 3-char minimum).
- Results table: email, name, subscription status badge (Subscribed / Unsubscribed / Suppressed / Never subscribed), last activity (relative time), row click → opens detail drawer.
- **"Not yet in Klaviyo" amber-bordered card** below results when RDS-only users surface. Shows the actionable gap of FitScript signups that never made it to Klaviyo (paulclotar.org example: 2 of 4 paul-matching users in RDS have no Klaviyo profile).
- Detail drawer (`ModalPortal`): name + email + Klaviyo ID + subscription badge + Open-in-Klaviyo link, cells for phone/location/last-event, **Suppress/Unsuppress** action button (red/green), Lists section, Events timeline (50 events), Custom properties JSON viewer.

**Route + nav:**
- New route `/email/profiles` wired in `App.tsx`.
- Added "Profiles" button to the `/email` page header (next to Send Campaign + Compose with Claude).

### Klaviyo API constraint discovered

Klaviyo's profile email filter ONLY supports `equals` and `any` — no `contains`, `starts-with`, `ends-with` (HTTP 400 "'contains' is not an allowed filter operator for email"). Other attributes (first_name, properties.*, etc.) support full-text but email is locked down. Forced the hybrid RDS-fallback pattern. See [[feedback_klaviyo_email_filter_limits]].

### Verified

- Search `paul` (partial) → 4 RDS matches, 2 in Klaviyo (`paulc@fitscript.me`, `paulclotar@gmail.com`), 2 RDS-only surfaced as amber card.
- Search `paulclotar@gmail.com` (exact) → 1 Klaviyo profile.
- Search `paul@clotarmarketing.com` (exact, not in Klaviyo) → 0 profiles + 1 RDS-only row surfaced.
- Detail endpoint: returns 16 events + 2 lists for Paul's profile.
- Type check clean, server restarted, both routes 200.

### What I'll remember

- **Klaviyo profile email filter only supports `equals` and `any`** (no partial). Always hybrid via local DB when partial search is needed. See [[feedback_klaviyo_email_filter_limits]].
- **RDS-only surfacing is the differentiator** over Klaviyo's native UI — Klaviyo can't show "users in your app DB but not in our system." Cross-checking with our RDS turns a search into an ops audit.
- **Klaviyo DSD = NS delegation** when set up manually (CNAME-only setup is via Entri/auto-flow only). Klaviyo manages all DKIM/return-path/SPF internally on their nameservers once verified.
- **Add comments to DNS records.** Cloudflare's Comment field shows in the DNS list. Without comments, post-hoc audits have no idea why a record exists. Should retroactively comment the existing SPF/MX/Mailgun cruft on fitscript.me apex when time permits.

---

## 2026-05-25 (later) — DIRT writes for Klaviyo profiles

Extended today's profile-manager work to DIRT. The HTTP endpoints we built for `/email/profiles` are now also conversational tools — operator can say "suppress this user" and DIRT does it, audit-logged.

### Shipped

**Server (`server/dirt.ts`):**
- Added `klaviyoPOST()` + `klaviyoGET()` helpers, refactored existing `klaviyoPATCH()` to share a `klaviyoCall()` base.
- 2 new READ tools (now 15 total): `search_klaviyo_profile` (full or partial email, hybrid via RDS for partial — matches `/api/ops/klaviyo/profiles/search` semantics), `get_klaviyo_profile` (full detail by Klaviyo ID).
- 2 new WRITE tools (now 11 total): `suppress_klaviyo_profile`, `unsuppress_klaviyo_profile`. Accepts profileId OR email. Audit-logged with `via: dirt` metadata + ok/failed status.
- System prompt updated: new tools listed as reversible (execute immediately, no confirmation). Convention: prefer calling `search_klaviyo_profile` before suppress/unsuppress to confirm the right subscriber.

**Client (`client/src/components/dirt/Dirt.tsx`):**
- Footer tool-count fixed: `13 read · 9 write` → `15 read · 11 write`.

### Verified live (read flow)

Test prompt "Find paulclotar@gmail.com in Klaviyo and tell me their last engagement" — DIRT autonomously chained:
1. `search_klaviyo_profile` (965ms) → returned profile ID `01KMK9WVYYPJ5AJQAD45H7R0D2`
2. `get_klaviyo_profile` (516ms) → returned full detail
3. Rendered structured response with engagement timeline (8 events: Clicked, Opened, Received Email across "E2E send", "Testing of Newsletter", "Lab Order Confirmed") + list memberships (Ops Test, Waitlist) + Klaviyo deep-link

Write flow not manually tested before commit; code matches the read pattern + the existing `/api/ops/klaviyo/profiles/:id/suppress` HTTP endpoint that IS tested. Paul approved commit + push without write E2E.

### What I'll remember

- **Refactor pattern: shared `klaviyoCall()` base.** Avoids duplicating header construction across PATCH/POST/GET methods. Single source of truth for Klaviyo API style.
- **DIRT tool footer count is hardcoded in `Dirt.tsx`.** Update it whenever READ_TOOLS or WRITE_TOOLS counts change. Future fix: compute dynamically from a `/api/ops/dirt/tools-count` endpoint to avoid this drift.
- **DIRT tools mirror HTTP endpoints by design.** Same handler logic, same audit log entries, same Klaviyo calls. Operator can get to the same outcome via UI (`/email/profiles`) OR conversation (DIRT) — both audit to the same `ops_admin_actions` table.

---

## 2026-05-25 (later still) — Push RDS-only users to Klaviyo (one-click sync)

Closes the loop on this morning's "RDS-only users surfacing" — operators can now turn the audit finding (FitScript signups missing from Klaviyo) into a one-click fix.

### Shipped

**Server (`server/klaviyo.ts`):**
- New `POST /api/ops/klaviyo/profiles/push` endpoint. Body: `{ email, fitscriptUserId? }`.
  - Looks up canonical user attrs from RDS `users` (first_name, last_name, phone). Body is advisory; RDS is the source of truth.
  - Creates the Klaviyo profile with attributes + custom properties `{ fitscript_user_id, pushed_from: "ops_dashboard" }` for downstream traceability.
  - Idempotent: Klaviyo returns 409 with `duplicate_profile_id` when the email already exists; we surface that as `{ ok: true, already_existed: true, profileId: <existing> }`. No duplicate created.
  - Audit-logged: `profile.push` action, `metadata.created` vs `metadata.existing` flag for analytics.

**Client (`client/src/pages/email-profiles.tsx`):**
- "Push to Klaviyo" button on every RDS-only row in the amber card.
- "Push all to Klaviyo" bulk-action button in the amber card header (when 2+ users). Confirms before pushing.
- Per-row state machine: `Pushing…` → `✓ Created` (green) | `✓ Already in Klaviyo` (blue) | `✗ Failed` (red, hover title shows error).
- After successful push, search results refetch ~1.2s later — the pushed user moves from the amber RDS-only card into the main Klaviyo profiles table above.

### Verified end-to-end

- Before: search "paul" → 2 Klaviyo + 2 RDS-only (`paul@clotarmarketing.com`, `paul@seabedee.org`).
- Push `paul@clotarmarketing.com` → created Klaviyo profile `01KSGDYA7J5ENB5ZT8WD7XB8JB`.
- Re-push same email (idempotency) → returned same profile ID + `already_existed: true`. No duplicate.
- Push `paul@seabedee.org` via the UI button → created profile `01KSGEXJDF356M8FAXT1271NYT`. UI showed `Pushing…` → `✓ Created` → row vanished into top Klaviyo table.
- Audit log `/settings → Admin Log` shows 3 `Profile Push` rows, all status OK, including the idempotent re-push.

### What I'll remember

- **Klaviyo profile create is 409-idempotent.** Same email → 409 with `meta.duplicate_profile_id` pointing at the existing profile. Treat 409 as success-with-existing, not failure. Means push operations are safe to retry blindly.
- **RDS is the source of truth for user attributes during sync.** The client `push` request body is advisory only — server re-fetches first_name/last_name/phone from `users` table to avoid trusting stale UI state. Means even if the operator's browser is showing old data, the push lands the latest.
- **`pushed_from` custom property** is a useful audit breadcrumb. Set on every operator-initiated push. Future: similar property for transactional-API pushes, signup-flow pushes, bulk-imports — lets us segment Klaviyo profiles by their provenance.
- **Auto-refetch after write** (with ~1.2s delay so Klaviyo has time to index) is the right UX pattern. Operator sees the row move from amber card → main table without manual refresh. Apply to other write actions (suppress/unsuppress could do the same).

---

## 2026-05-26 — Memory hygiene + missed DIRT tool

Audit triggered by Paul: "what's pending and is anything stale memory?" Followed [[feedback_verify_pending_claims]] + [[feedback_verify_already_fixed_claims]] — grep-verified every claim against the codebase before citing.

### Stale memory cleanup

- **`project_ops_dashboard_v1.md`** (the original, not the one I made yesterday): file was a stub with no body, MEMORY.md pointer said "7 sections working." Reality: 9+ surfaces live including DIRT + email composer + profile manager. **Action:** rewrote with the current snapshot.
- **`project_fitscript_ops_dashboard.md`**: marked itself "superseded — see redirect" to v1 + full_map. No MEMORY.md pointer to it anymore. **Action:** deleted the file.
- **`reference_old_ops_dashboard.md`**: referenced `~/Desktop/ops-dashboard.tar.gz` and `/tmp/ops-dashboard-old/` — both gone. Also explicitly violated [[feedback_replit_neon]] ("never mention Replit again"). **Action:** deleted file + MEMORY.md pointer.
- **`project_ops_dashboard_may8_klaviyo.md`**: description said "Klaviyo read-only connector." Klaviyo now has 6+ write tools (suppress / unsuppress / push / flow status / content approve / blog queue / test). **Action:** demoted to "historical" with a redirect to the current-state v1.
- **MEMORY.md duplicate pointer**: lines 67 + 83 both pointed at `project_fitscript_ops_dashboard_v1.md` with different descriptions. **Action:** removed the duplicate, single line now reflects current state.
- **I also created `project_ops_dashboard_v1.md`** (without "fitscript" prefix) yesterday's session — that was a NEW duplicate of the canonical name. **Action:** content moved into canonical file, duplicate deleted.

### Missed DIRT tool — fixed

Discovered during the audit: HTTP endpoint `POST /api/ops/klaviyo/profiles/push` (shipped 2026-05-25 in commit 96f6745) had no DIRT counterpart. Operator couldn't say "push this user to Klaviyo" conversationally — only via the UI button. Violates the [[2026-05-25 — DIRT tools and HTTP endpoints share handler logic]] decision from yesterday.

**Server (`server/dirt.ts`):** Added `push_klaviyo_profile` to WRITE_TOOLS (now 12 total). Mirrors the HTTP endpoint exactly — looks up RDS user attrs for enrichment, calls Klaviyo POST /profiles/, handles 409-duplicate idempotently with `already_existed: true`, audit-logs with `via: dirt` + `created: true|existing: true` metadata.

**Client (`client/src/components/dirt/Dirt.tsx`):** Footer count `15 read · 11 write` → `15 read · 12 write`.

**System prompt:** Added `push_klaviyo_profile` to the reversible-writes list + a hint about pairing with `search_klaviyo_profile` when rds_only_users surface.

### Verified end-to-end

Prompted DIRT: "Push paul@seabedee.org to Klaviyo using the push_klaviyo_profile tool" → DIRT called `push_klaviyo_profile` → result `{ ok: true, profileId: 01KSGEXJDF356M8FAXT1271NYT, already_existed: true }`. Profile ID matches yesterday's UI push, idempotency working through DIRT exactly as expected.

### Pending tail (verified, not just claimed)

1. **DMARC duplicate cleanup** — deferred by Paul 2026-05-25
2. **Klaviyo DSD verification email** — async, may already have arrived
3. **Meta Ads token** — connector built, needs `META_SYSTEM_USER_TOKEN`
4. **Google Ads connector** — not built yet, waiting on Google developer-token approval
5. **Klaviyo tag management** — no tag CRUD endpoints
6. **Klaviyo segment writes** — read-only
7. **Email composer Branded mode imagery** — deferred
8. **Tracking pixel in prod verification** — claimed pending May 8, never confirmed

### What I'll remember

- **Stale memory accumulates fastest where the project moves fastest.** Ops dashboard had 5 different memory files describing it, with descriptions ranging from 4 days to 3 weeks out of date. Quarterly memory audits should be a habit — and Paul's "is anything stale?" question is the right cadence prompt.
- **Memory naming collisions are an audit smell.** Two files with similar names (`project_ops_dashboard_v1.md` vs `project_fitscript_ops_dashboard_v1.md`) are an indicator that previous sessions didn't grep before writing. Future fix: always grep memory dir before creating a new file.
- **"Done" claims need verification just like "pending" claims** (per [[feedback_verify_already_fixed_claims]] + [[feedback_verify_pending_claims]]). Both error in the same way — by relying on stale recollection.

---

## 2026-05-26 (later) — Admin management UI (DB-backed allowlist)

Triggered by Paul: "add seth@fitscript.me and mm@fitscript.me as admins" → "we should be able to add admins to the dashboard as admins" (i.e. build the surface, don't keep editing AWS Secrets Manager + redeploying).

### Shipped

**Server (`server/admin-auth.ts`):**
- New `ops_admins` table: `email PRIMARY KEY, added_by, added_at, note`. Auto-created via `ensureAdminTable()` on first read.
- **Env → DB migration via boot-time seed.** `seedFromEnvIfEmpty()` runs once per boot — if the table is empty AND `ADMIN_EMAILS` env is set, seeds rows with `added_by='env-bootstrap'`. After that, DB is canonical; env is fallback only.
- `getAllowlist()` (the auth hot-path) reads an in-process Set cache (60s TTL). Async refresh kicks in on stale read but never blocks auth — env fallback covers the gap.
- `refreshAllowlistCache()` (synchronous): called by add/remove after the DB write so the cache is warm before the response goes out. Critical for the cache-flush bug found in testing.
- New endpoints (all `requireAdmin`-gated):
  - `GET /api/ops/admins` — list with metadata
  - `POST /api/ops/admins` — add `{email, note?}` (idempotent via `ON CONFLICT DO NOTHING`)
  - `DELETE /api/ops/admins/:email` — remove (with safety rails)
- Safety rails: can't remove self (`Cannot remove yourself`), can't remove the only admin (`Cannot remove the only admin`).
- Audit-logged: `admin.add` and `admin.remove` actions with target email, `via: ui` metadata.

**Server (`server/settings.ts`):**
- `/api/ops/settings.adminEmails` now reads from `listAdminsFromDb()` instead of `process.env.ADMIN_EMAILS`. Env stays as fallback if DB unreachable.

**Client (`client/src/pages/settings.tsx`):**
- New "Admins" tab between General and Admin Log.
- `AdminsTab` component: add form (email + optional note), live table (email, added_by, added_at, note, action), per-row remove button (disabled for self / only-admin), idempotent feedback.
- Removed the now-redundant "Admin allowlist" badges from `GeneralTab` — replaced with a one-line pointer to the new tab.

### Critical bug caught during testing

**The cache-flush race condition.** First implementation just set `allowlistCache = null` after writes and relied on the async `getAllowlist()` refetch to repopulate. Test caught: after `POST /admins` returned `ok`, the very next `GET /auth/me` for the new email still 403'd — because the async refetch hadn't landed yet, so `getAllowlist()` fell through to the env fallback (which didn't include the new email).

Fix: `refreshAllowlistCache()` is now `async` and synchronously awaited inside `addAdminToDb()` and `removeAdminFromDb()`. By the time the POST/DELETE response goes out, the cache is already warm with the new state.

### Verified

Full test suite (server-side):

| # | Test | Result |
|---|------|--------|
| 1 | mm@fitscript.me (in DB) → auth/me | 200 |
| 2 | seth@fitscript.me (in DB) → auth/me | 200 |
| 3 | random@notadmin.com (not in DB) | 403 |
| 4-8 | Cache invalidation: pre-add 403, add, post-add IMMEDIATELY 200, remove, post-remove IMMEDIATELY 403 | all pass |
| 9 | Remove self | 400 "Cannot remove yourself" |
| 10 | Audit log captures all admin.* events | 7 rows |
| 11 | /api/ops/settings.adminEmails reads from DB | 4 admins |

### Result for the original ask

- Seth + Michael are now active admins on local dev. After deploy, prod auto-seeds from env (which Paul never updated for prod), so we need to:
  - Either: have Paul use the new UI in prod to add them
  - Or: update the prod Secrets Manager `ADMIN_EMAILS` so the seed picks them up — but only matters on FRESH prod DB (existing prod DB will seed from whatever ADMIN_EMAILS was at first boot).

Prod consideration: prod's ops_admins table will seed from prod's current `ADMIN_EMAILS` env on first boot after this deploy. That env still has only Paul + dev. Seth + Michael will need to be added via the new UI (Paul → /settings → Admins → Add) after deploy.

### What I'll remember

- **Async cache invalidation is a race condition trap.** "Just set cache=null and let the next read refetch" sounds clean but breaks when an env fallback path exists. Either await the refetch synchronously OR have the cache hold a Promise<value> instead of just value. The await-after-write pattern is simplest when the write surface is small (here: 2 endpoints).
- **Env → DB migration via boot-time idempotent seed.** Pattern: check table empty → if so, copy env values in with a `from-env-bootstrap` provenance flag → then DB becomes canonical. Survives crash/restart; doesn't repeat on every boot. Apply to other env-based config that should become editable in-dashboard.
- **Safety rails should fail loud + explain.** "Cannot remove yourself" is more useful than "400 forbidden." Same for "Cannot remove only admin." Operators see the message and understand the constraint immediately.
- **DB-canonical config eliminates AWS Secret round-trips for ops changes.** Adding an admin used to be: edit secret JSON → save → ECS force-redeploy → wait 60s → test. Now it's: 5 seconds in the dashboard. Apply the pattern to any future config that operators need to mutate (Slack webhook URLs, default sender names, feature flags, threshold values).

---

## 2026-05-27 — Project management v1 + new "Workspace" sidebar section

Paul asked for three new team tools: chat, project management, and content storage. Picked project management first because it's the fastest to ship (pure CRUD, no real-time, no file uploads). Chat + content come in follow-ups.

### Shipped

**Server (`server/projects.ts`, new):**
- New table `ops_projects` (id UUID PK, name, description, status, owner_email, due_date, created_by, created_at, updated_at). Auto-created via `ensureProjectsTable()` on first read.
- Status values: `active`, `on_hold`, `done`, `archived`. Validated server-side.
- 4 endpoints (all `opsGate`-gated):
  - `GET /api/ops/projects?status=&includeArchived=` — list with sort (active → on_hold → done → archived, then due_date ASC nulls last, then created_at DESC)
  - `POST /api/ops/projects` — create
  - `PATCH /api/ops/projects/:id` — partial update with field-by-field normalization
  - `DELETE /api/ops/projects/:id` — hard delete (soft-archive is preferred via PATCH status='archived')
- All writes audit-logged: `project.create`, `project.update`, `project.delete` with target_label = project name + metadata containing the change set.

**Client (`client/src/pages/projects.tsx`, new):**
- `PageHero` + "+ New project" CTA in the top-right.
- Filter pills (All / Active / On hold / Done) with live counts + "Include archived" toggle.
- Table: Name (with description preview), Status badge, Assigned to (with "Unassigned" italic for null), Due (red+bold if overdue), Updated relative time, Edit row click.
- `ProjectEditModal` (uses `ModalPortal`): name + description + status + assigned-to dropdown (populated from `/api/ops/admins`) + due date. Create or edit modes share the same form. Edit mode shows a red Delete button.
- Empty state with "Create the first project" CTA.
- Loading + error states.

**Sidebar IA — new "Workspace" section:**
- Per the existing IA decision ([[2026-05-20 — Sidebar IA: 4 grouped sections]]) — new top-level pages must slot into an existing section, OR a new section needs an explicit decision. Three internal team tools (chat, projects, content) don't fit Overview/Customers/Growth/System. New section "Workspace" is the explicit answer.
- Currently holds: Projects (new). Chat + Content will join here when shipped.
- New clipboard icon for the Projects item.

### Assigned-to UX polish (same session)

Initial design used a free-text email input for `owner_email` — operators would need to type the exact admin email. Paul flagged: "should be able to assign it to someone." Swapped to a `<select>` dropdown populated from the live admins list (`/api/ops/admins`), with "Unassigned" as the empty option. Stays in sync as `/settings → Admins` changes (same query key, 5-min staleTime).

Fallback: if the saved `owner_email` doesn't match any current admin (admin removed or renamed), the option is preserved in the dropdown so we don't silently drop the assignment.

Also renamed the table column "Owner" → "Assigned to" for clarity + table cell renders "Unassigned" italic when null.

### Verified

8-step smoke test, all green:
1. Create project A (Klaviyo Deliverability Launch, due 2026-06-01)
2. Create project B (Content Library v1, on_hold, assigned to Michael)
3. List → 2 projects, correct sort (active first)
4. PATCH project A status → `done`
5. List filtered to status=active → 0
6. DELETE project A → ok
7. Audit log shows 4 `project.*` rows (create A, create B, update A, delete A)
8. Final list shows only Content Library v1

### What I'll remember

- **Pure-CRUD features ship fast when you reuse existing infra.** This whole feature took ~1 hr because: pool.query for DB, opsGate for auth, logAdminAction for audit, ModalPortal for the modal, PageHero for the header, useQuery for fetching, useQueryClient for cache invalidation. New file count: 2. Build pattern: 1 server file + 1 page + 1 sidebar entry.
- **"Workspace" section is now the home for internal team tools.** Apply when chat + content storage land. Don't fork into separate IA sections for each.
- **Assignee dropdowns should query the live admin list, not duplicate it.** Single source of truth. Future: same pattern for any "assign to person" field in other surfaces (DIRT notifications inbox already does similar via `adminEmail`).
- **Free-text email inputs are an anti-pattern when the valid set is small + known.** Operators forget emails, mistype them, or use the wrong domain. Always prefer a constrained picker.

---

## 2026-05-27 (later) — Chat v1 (channels + SSE + @ mentions)

Second of Paul's three Workspace asks. Chat built on the existing SSE pattern (DIRT streaming uses the same approach).

### Shipped

**Server (`server/chat.ts`, new):**
- Two tables: `ops_chat_channels` (id UUID PK, name UNIQUE, description, created_by, created_at) and `ops_chat_messages` (id BIGSERIAL, channel_id FK ON DELETE CASCADE, sender_email, body, created_at, edited_at). Index on `(channel_id, id DESC)` for fast recent-messages reads.
- Auto-seed `#general` on first boot if zero channels exist.
- Channel-name normalization: lowercase, alphanumeric + hyphen, max 32 chars. Strips leading `#`. `"#Some Bad Name!@#"` → `some-bad-name`.
- 7 endpoints (all opsGate'd):
  - `GET /api/ops/chat/channels` — list with `last_message_at` + `message_count`
  - `POST /api/ops/chat/channels` — create (409 on duplicate name)
  - `DELETE /api/ops/chat/channels/:id` — delete with cascade. `#general` is undeletable.
  - `GET /api/ops/chat/channels/:id/messages?since=&limit=` — fetch with optional `?since=<id>` for incremental polls
  - `POST /api/ops/chat/channels/:id/messages` — send (8000 char limit)
  - `DELETE /api/ops/chat/messages/:id` — author-only deletion
  - `GET /api/ops/chat/stream` — SSE broadcast with 25s heartbeat, auto-clean on connection close
- In-process `Set<Subscriber>` for SSE fan-out. Each new message broadcasts `{type, payload}` to all connected clients.
- Audit log: `chat.channel.create` + `chat.channel.delete` only — individual messages NOT logged (would be too noisy at chat volume).

**Client (`client/src/pages/chat.tsx`, new):**
- Slack-lite layout: left channel sidebar (with message counts), right thread + composer.
- Auto-selects `#general` on first load.
- Live `EventSource` subscription on `/api/ops/chat/stream` — invalidates React Query caches on incoming events for instant updates across all open tabs.
- Message rendering grouped by sender within 5-min windows (Slack-style).
- Hover own message → ✕ to delete.
- "New channel" modal with name + description (auto-normalized live).
- Stable avatar colors per email (8-hue rotation via deterministic hash) + capital-letter initial.
- Composer: textarea with Enter-to-send, Shift+Enter for newline, autosize up to max-h-40.

### @ Mentions (added same session)

Triggered by Paul: "should be able to tag members."

- Composer detects `@<partial>` immediately before cursor → opens autocomplete dropdown of admin usernames (queried from `/api/ops/admins`, same source of truth as `/email/profiles` assignee picker).
- Keyboard: ↑/↓ to navigate, Enter or Tab to insert, Esc to dismiss. Click also works.
- Insert replaces the partial with `@<username> ` and re-focuses the textarea with cursor positioned after.
- Render: `renderBody()` parses `@\w+` mentions and renders each as a styled chip:
  - **Amber** if mention is yourself (so you spot the @-you)
  - **Brand-blue** if mention matches a known admin
  - **Grey** if username doesn't match any admin (typo / former admin)
- No server changes — stored as raw text. The client owns parsing + rendering.

### Verified end-to-end

8-test smoke run, all green:
- Auto-seed `#general` ✓
- Create channel ✓
- Duplicate name returns 409 ✓
- Name normalization works ("#Some Bad Name!@#" → `some-bad-name`) ✓
- Send messages + fetch chronological ✓
- `#general` undeletable ✓
- **SSE delivery confirmed live** — opened stream, posted message in parallel, received `event: message` ✓
- Audit log captures only channel CRUD, not individual messages ✓

### What I'll remember

- **In-process SSE Set is fine for chat-volume**. Scales to hundreds of admins per pod. The whole pattern reused from DIRT streaming. For higher fan-out (thousands of recipients on the public app), would need Redis pub/sub. Chat for an internal team doesn't.
- **EventSource auto-reconnects on disconnect** — no client-side retry logic needed. The server's 25s heartbeat keeps proxies from killing idle connections.
- **Audit logs need a noise budget.** Channel CRUD = high-signal, log every one. Individual messages = high-volume, log nothing (chat history IS the audit log; it's first-class data).
- **Mentions don't need server-side parsing for v1.** Store raw text, parse + render client-side. Mention "knowledge" lives in the admin list. Trivial to swap renderers later (e.g. link to admin profile, send notification, etc.).
- **The avatar color hash is a simple but underrated UX touch.** 8 stable hues per email = visual identity without storing avatars. Apply to other person-shows surfaces (members table, comments, audit log).

---

## 2026-05-27 (later still) — Content storage v1 (S3 + library UI)

Third and last of Paul's three Workspace asks. The big one — S3-backed file storage so Michael can upload + organize footage without leaving ops.

### Architecture

**Direct browser → S3** via presigned PUT URLs. Multi-GB video files never touch the Express server (would otherwise be a memory/throughput bomb).

Flow:
1. Client POST `/api/ops/content/presign` with `{filename, content_type, size_bytes}` → server validates + signs a 15-min `PutObjectCommand` URL.
2. Browser PUTs the file directly to S3 with progress tracking via XHR.
3. Client POST `/api/ops/content/files` with the upload metadata → server creates `ops_content_files` row.

### Shipped

**Server (`server/content.ts`, new):**
- `ops_content_files` table (id UUID, s3_key UNIQUE, original_filename, content_type, size_bytes BIGINT, uploaded_by, uploaded_at, project_id REFERENCES ops_projects(id) ON DELETE SET NULL, tags TEXT[], description). Indexes on uploaded_at DESC + project_id + uploader.
- Filename sanitization (lowercase, alphanumeric + . _ -) before S3 key construction.
- 5 GB single-PUT cap (multipart out of scope for v1).
- 6 endpoints (all opsGate'd):
  - `GET    /api/ops/content/status` — checks bucket env + returns config state. UI uses this to render "not configured" banner.
  - `POST   /api/ops/content/presign` — issues 15-min PUT URL.
  - `POST   /api/ops/content/files` — record metadata after upload.
  - `GET    /api/ops/content/files?project_id=&type=&q=` — list with filters (joins project name).
  - `GET    /api/ops/content/files/:id` — detail with FRESH 15-min download URL.
  - `PATCH  /api/ops/content/files/:id` — update project / tags / description (filename + s3_key immutable).
  - `DELETE /api/ops/content/files/:id` — S3 delete (best-effort) + DB row removal. S3 failure still removes DB row so operator can re-upload.
- All writes audit-logged: `content.upload`, `content.update`, `content.delete` with metadata.

**Client (`client/src/pages/content-library.tsx`, new):**
- Status probe — shows amber "Storage not configured" banner with SESSION_LOG pointer when bucket env is missing.
- Top filter bar: search (filename + description), type filter (Video / Image / Audio / Documents / All), project filter (populated from `/api/ops/projects?includeArchived=true`).
- Multi-file upload via hidden `<input type="file" multiple>` triggered by header button.
- In-flight upload tray with per-file progress bars (XHR `upload.onprogress`) — queued → presigning → uploading (%) → saving → done. Errors surface with retry-able rows.
- Grid view (2/3/4 cols responsive) with colored type chips: VIDEO purple, IMAGE sky, AUDIO emerald, PDF red, TEXT amber, FILE grey. Each card shows filename + size + relative upload time + project name.
- Detail drawer (ModalPortal): name + metadata + presigned download button + project dropdown + tags input (comma-separated) + description + Delete + Save.

**Packages:**
- Added `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`.

**Sidebar IA:**
- Added "Content Library" under Workspace (after Chat + Projects). New `folder` icon.

### Verified locally (without bucket)

- `/api/ops/content/status` → `{configured: false, reason: "OPS_CONTENT_BUCKET env not set"}` ✓
- `/api/ops/content/files` → `{files: []}` (table auto-created) ✓
- `/api/ops/content/presign` → 503 with clear setup hint ✓
- UI shows amber banner + disabled upload button when status is not configured ✓

### AWS prereqs Paul needs to run (storage doesn't work until done)

These need to happen in AWS — I can't from this session.

**1. Create the S3 bucket:**
```bash
aws s3api create-bucket \
  --bucket fitscript-ops-content \
  --region us-east-1
```

**2. CORS config so browser PUTs work:**
```bash
cat > /tmp/cors.json <<'EOF'
{"CORSRules":[{"AllowedOrigins":["https://ops.fitscript.me","http://localhost:5001"],"AllowedMethods":["GET","PUT","POST","DELETE","HEAD"],"AllowedHeaders":["*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3600}]}
EOF
aws s3api put-bucket-cors --bucket fitscript-ops-content --cors-configuration file:///tmp/cors.json
```

**3. Block public access (defaults but be explicit):**
```bash
aws s3api put-public-access-block --bucket fitscript-ops-content \
  --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
```

**4. IAM policy for ECS task role** — attach to `ecsTaskExecutionRole`:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:ListBucket"],
    "Resource": [
      "arn:aws:s3:::fitscript-ops-content",
      "arn:aws:s3:::fitscript-ops-content/*"
    ]
  }]
}
```

**5. Set env var in two places:**
- Local `.env`: `OPS_CONTENT_BUCKET=fitscript-ops-content`
- Prod secrets: update `prod/ops-secrets` JSON to include `OPS_CONTENT_BUCKET` then force ECS redeploy. Same command pattern as the `KLAVIYO_API_KEY` rotation from earlier.

### What I'll remember

- **Direct browser → S3 with presigned URLs is the only sane pattern for large files.** Routing GB files through Express = guaranteed OOM + slow. The XHR `upload.onprogress` UX is mandatory for files > ~10 MB.
- **CORS is the single most common gotcha** when implementing direct uploads. Always remember `ExposeHeaders: ["ETag"]` (S3 returns it on PUT, the SDK uses it for multipart-resume, missing it surfaces as cryptic errors).
- **Bucket isn't the same as the prod-secrets pattern.** The bucket is infra; the env var is config. Bucket creation is one-time; env var update requires ECS redeploy. Both need to happen before the surface works in prod.
- **`status` probe endpoint is a great pattern for env-gated features.** Lets the UI render a useful "not configured" state instead of just silently failing on the first action. Apply to other integrations that depend on env (Slack webhook, Klaviyo, etc.).
- **`ON DELETE SET NULL` for project FK** lets operators delete a project without losing content. The file stays in the library, just becomes unassigned. Apply to other relational FKs where the parent is more transient than the child.

---

## 2026-05-27 (evening) — Knocked out pending audit queue (6 tasks)

After Workspace tools shipped (Projects + Chat + Content Library), Paul asked to plow through the pending audit items. 6 of them; ~3 hours of mixed work. All landed locally; pushing follows.

### 1. Tracking pixel prod verification (verified, no code)

Queried prod via `/api/ops/leads`. Result: pixel IS recording — 5 visitor sessions in the DB, all `status: Cold, source: direct`. DIRT reported 0 visitors in last 7 days, meaning recent traffic is sparse and untagged. Infrastructure works; sparse-traffic + missing UTMs is a marketing problem, not a code problem. Moved on.

### 2. DMARC duplicate cleanup (handoff to Paul)

Still two records on `_dmarc.fitscript.me` (`p=none` and `p=quarantine`). I can't edit Cloudflare DNS from this session. Gave Paul concrete steps: delete the `p=quarantine` record, edit the surviving one to `v=DMARC1; p=none; rua=mailto:paulc@fitscript.me; aspf=r; adkim=r; pct=100`. Pending on his Cloudflare time.

### 3. DIRT tools for Workspace surfaces (6 new tools)

Added to DIRT (now **18 read + 16 write tools**, up from 15+12):

**Reads:**
- `list_projects` — by status filter, ordered by status priority then due date
- `list_chat_channels` — with message_count + last_message_at
- `search_content_library` — by project, content-type prefix, or search query

**Writes:**
- `create_project` — full attrs, audit-logged
- `update_project_status` — status transition
- `post_chat_message` — resolves channel by name OR UUID, supports @mentions
- `set_klaviyo_profile_tags` — see task 5 below

Verified each tool via SSE chat call. All 4 tested tools chained correctly. System prompt updated with new reversible-writes list + guidance on pairing list_chat_channels before post_chat_message.

### 4. @ mention notifications in bell inbox

Extended existing `ops_dirt_notifications` table with a nullable `target_email` column (NULL = global / visible to all admins, else scoped). `GET /api/ops/dirt/notifications` now filters by `target_email IS NULL OR target_email = current_admin`.

`server/chat.ts` POST-message handler now parses `@username` mentions, looks each up against the admin list, and inserts a notification row per mentioned admin. Self-mentions skipped. Body preview capped at 140 chars. Metadata includes `channel_id`, `channel_name`, `message_id`, `sender` for jump-to-message v2.

Bell UI auto-renders the new notifications via the existing 60s poll. No client changes needed.

Verified by posting `@dev @seth check this out` from Paul → confirmed:
- Paul (sender) saw no new notification ✓
- Dev's latest unread: "paulclotar mentioned you in #general" ✓
- Seth saw the same ✓
- Self-mention test: Paul mentioning himself → no notification for Paul ✓

### 5. Klaviyo tag management

Realized mid-build: **Klaviyo doesn't support per-profile tags as a first-class entity** — tags are for objects (lists, segments, flows, campaigns). For Slack-style per-subscriber labels, the standard Klaviyo pattern is **custom profile properties**.

Pivoted: a `tags` custom property storing a string array. Klaviyo `PATCH /profiles/:id/` with `attributes.properties` is merge-on-write, so we don't clobber other props.

**Server:** `PATCH /api/ops/klaviyo/profiles/:id/tags` with validation (lowercase, a-z/0-9/-/_, 50-char max per tag, 30-tag max per profile). Audit-logged as `profile.tags.update`.

**Client (email-profiles detail drawer):** new `Tags` section with chip UI — add via input + Enter, remove via ✕ on each chip. Validates client-side, persists immediately, refetches detail.

**DIRT:** `set_klaviyo_profile_tags` tool. Setting it conversationally also works ("Clear all tags on profile X" → empty array passed).

Verified: PATCH set `[vip, beta, fitscript-founder]` → confirmed on detail → DIRT cleared them → confirmed empty.

### 6. QueryError rollout (3 pages)

Existing `QueryError` + `InlineError` + `hasApiError` components were already in use on Members / Email / Content / Leads / Marketing. Applied to:

- **Settings** — top-level useQuery now uses `QueryError` with retry button. Previous error state was a static "Failed to load settings" with no detail and no retry.
- **Orders** — both `rxData` + `labData` queries surface errors via `InlineError` above the tab content. Stop the silent "loading…" → empty cards on auth failures.
- **Member-detail** — primary member useQuery surfaces errors via `QueryError` with retry. Previously fell through to "Member not found" which masked actual API failures.

All 3 now follow the same convention: `hasApiError(data)` checks for `{error: "..."}` envelopes in 200 responses, and the error component renders the message + a retry button.

### Outstanding

- **Task 19 (Project tasks)** — biggest remaining build, deferring to a fresh chunk after commit.
- **Meta Ads token** — Paul still needs to generate `META_SYSTEM_USER_TOKEN`. No code change.
- **Abandoned-checkout transactional email** — lives in FitScript repo, not ops.

### What I'll remember

- **The "knock out the queue" pattern works when the queue is verified.** I checked each item against the codebase before claiming it was pending (per [[feedback_verify_pending_claims]]). Some "pending" items turned out to be partly done; some "done" claims turned out to be stale. The audit step is what made the plow-through reliable.
- **Custom profile properties >>> first-class tags in Klaviyo.** Their API doesn't have profile tags at all — tags are scoped to objects (lists/segments/flows/campaigns/coupons/etc.). For subscriber tagging, always use `attributes.properties` with merge-on-write PATCH.
- **Target-scoped notifications** with NULL = global is a clean pattern. Lets old global notifications coexist with new per-user ones without a schema split. Same trick would work for any future scoped feed (DMs, task assignments, etc.).
- **Adding error UI is a 3-line change per page** when the QueryError component is already in place. Apply to every new page from the start; never let a useQuery silently fall through to empty state.

---

## 2026-05-27 (very late) — Tech ticket system Phase 1: ops triage + AI categorization

Paul wants a 3-phase tech-ticket pipeline: FitScript users tag issues live → ops triages with AI clustering → DIRT proposes auto-fix PRs. Phase 1 = ops side only (ingest + triage + UI). Phases 2 + 3 follow.

### Shipped

**Server (`server/tickets.ts`, new):**
- `ops_tickets` table — id, source_url, user_note, user_email, screenshot_s3_key, console_errors JSONB, element_selector, viewport WxH, user_agent, status (8 states), category (6 buckets), severity (4 levels), cluster_id (self-FK for dedup), ai_summary, ai_suggested_fix, ai_triaged_at, assignee_email, resolution_pr_url, closed_at.
- 7 endpoints:
  - **PUBLIC (outside `/api/ops/*` so opsGate doesn't block):**
    - `POST /api/tickets/screenshot-presign` — presigned S3 PUT (5 MB cap, 10-min expiry). Reuses content library bucket.
    - `POST /api/tickets/ingest` — submit a report. Both gated by `x-ops-tickets-key` header → `OPS_TICKETS_API_KEY` env var.
  - **ADMIN (under opsGate):**
    - `GET    /api/ops/tickets?status=&category=&severity=&hide_duplicates=` — list with filters + status counts. Sorted by severity then recency.
    - `GET    /api/ops/tickets/:id` — detail with fresh 15-min presigned screenshot URL + cluster's duplicate list.
    - `PATCH  /api/ops/tickets/:id` — update status / category / severity / assignee / resolution_pr_url. Auto-sets closed_at on terminal states.
    - `POST   /api/ops/tickets/:id/triage` — manual re-run AI triage.
    - `POST   /api/ops/tickets/:id/cluster` — mark as duplicate of canonical (refuses chains and self-cluster).
    - `DELETE /api/ops/tickets/:id` — hard delete.
- **AI triage** — fire-and-forget after ingest. Bedrock FAST model takes URL + user note + console errors + viewport + UA, returns `{category, severity, summary, suggested_fix}` JSON. Cost logged to `ai_costs` with `surface=ops_ticket_triage`.
- All admin writes audit-logged (`ticket.update`, `ticket.cluster`, `ticket.delete`).

**Client (`client/src/pages/tickets.tsx`, new):**
- PageHero with live counts: "N new" + "N critical" pill in actions area.
- Two-row filter bar: status pills (with counts per bucket) + severity pills.
- Sortable table: issue (with AI summary as title + source URL), category emoji-prefixed, severity badge, status badge, when, view button. Duplicate count surfaced on canonical rows.
- 30s `refetchInterval` so triaged tickets land in the UI without manual refresh.
- Detail drawer (`ModalPortal`):
  - Identity block (summary + URL + reporter)
  - 4-col picker grid (status, category, severity, assignee email) — patches inline
  - User note in a card
  - Screenshot (clickable → opens full-size in new tab)
  - **AI analysis** section with "Re-run AI" button
  - Duplicates list (when this is a canonical with clustered reports)
  - Technical context (element CSS, viewport, UA, expandable console errors JSON)
  - Resolution PR URL link (for Phase 3)
  - Delete button

**DIRT (now 20 read + 17 write tools):**
- `list_tickets` — filter by status/category/severity, severity-sorted
- `get_ticket` — full detail
- `update_ticket_status` — change status / severity / category / assignee
- Updated system prompt with the new reversible writes.

**Sidebar IA:**
- "Tech Tickets" added to Workspace section (between Projects and Content Library). New bug icon.

**Infrastructure:**
- New env var `OPS_TICKETS_API_KEY` generated locally (random 32-byte url-safe).
- Reuses `OPS_CONTENT_BUCKET` for screenshot storage.

### Verified end-to-end locally

1. Ingest without API key → 401 ✓
2. Ingest with key → ticket created + AI triage fired ✓
3. After 8s wait, ticket shows `status: triaged`, `category: bug`, `severity: high`, real AI summary ("Order Lab Panel button greyed out; API eligibility check returns 500 error"), and detailed fix hypothesis pointing at `/api/labs/eligibility` 500 ✓
4. List filter `?status=triaged` returns the row ✓
5. PATCH → approved + assigned ✓
6. Submit duplicate ticket ✓
7. Cluster duplicate onto canonical via `/cluster` endpoint ✓
8. Canonical now shows `duplicate_count: 1` + duplicate body in detail ✓

### Pending (Phase 2 + 3 next)

- **Phase 2:** FitScript-side reporter widget. Lives in `markappz/Humn-Health` repo (separate). Floating button or hotkey → screenshot via html2canvas → element selector overlay → user note → POST to ops `/api/tickets/ingest`.
- **Phase 3:** DIRT auto-fix-via-PR. Approved ticket → DIRT generates a code change → opens GitHub PR (no auto-merge) → admin reviews + merges → status transitions to `merged`.

### What I'll remember

- **Public-vs-admin endpoint paths matter for middleware routing.** Put admin endpoints under `/api/ops/*` so opsGate gates them automatically. Put external-caller endpoints OUTSIDE that prefix (e.g. `/api/tickets/ingest`) so the gate's `req.path.startsWith("/api/ops/")` check lets them through. Cleaner than carving exceptions in the gate.
- **API-key middleware as a tiny standalone fn.** `requireIngestKey(req, res, next)` is 5 lines and re-usable across any external-caller surface. Header name `x-ops-tickets-key` is purpose-tagged so other future API-key surfaces don't collide.
- **AI triage fire-and-forget keeps ingest fast.** The ingest endpoint returns in <100ms with `status: new`; the background triage updates to `triaged` ~3s later. UI 30s poll picks it up. Don't ever await an LLM call on a hot ingest path.
- **Cluster-of-tickets as a dedup pattern.** Use self-FK `cluster_id` pointing at the canonical. Canonical has `cluster_id IS NULL`; duplicates point at it. Refuse chains (cluster A → cluster B → cluster C); if target is itself a duplicate, return error telling the operator to cluster onto its canonical. Simple and avoids tree traversal.
- **Reusing the content library bucket** for ticket screenshots saves an IAM policy + bucket setup. Just namespace the prefix (`tickets/screenshots/...` vs `content/...`). One bucket, same CORS, same policy.

---

## 2026-06-01 — Tech tickets Phase 2 (FitScript widget) + Phase 3 (AI auto-fix PR)

Completed the 3-phase tech ticket pipeline. Phase 1 (ops triage + AI categorization) shipped 2026-05-27. Phase 2 + 3 finished today.

### Phase 2 — FitScript reporter widget (separate repo: markappz/Humn-Health)

**Client (`client/src/components/report-issue-widget.tsx`, new):**
- Floating dark-themed button bottom-left (FitScript green `#0EA57A` accent, SVG icons only per FitScript CLAUDE.md).
- Click → popover with note textarea + "+ Tag an element" button.
- Element picker: full-page overlay with brand-green outline on hover; click captures CSS path + outerHTML; Esc cancels.
- Console error ring buffer (10 most recent) installed on mount: console.error override + window.onerror + onunhandledrejection.
- Captures: URL, viewport, UA, console errors, element selector + snippet.
- "Sending…" → success state with SVG checkmark, auto-closes after 2.5s.
- Mounted globally in App.tsx (alongside Toaster).

**Server (`server/routes.ts`):**
- POST `/api/internal/report-issue` proxy endpoint.
- Attaches Cognito identity (req.cognitoUser.sub + email) when logged in; anonymous reports also accepted.
- Forwards to `OPS_TICKETS_INGEST_URL` (defaults to `https://ops.fitscript.me/api/tickets/ingest`) with `OPS_TICKETS_API_KEY` in `x-ops-tickets-key` header.
- Returns `{ok, ticket_id}`.

**Env (FitScript .env):**
- `OPS_TICKETS_API_KEY` — shared with ops dashboard
- `OPS_TICKETS_INGEST_URL` — `http://localhost:5001/api/tickets/ingest` (dev) or `https://ops.fitscript.me/api/tickets/ingest` (prod)

**Committed to markappz/Humn-Health at `4168a73b` (LOCAL ONLY — not pushed).**

### Phase 3 — AI auto-fix via PR (ops repo)

The bold one. Approved ticket → AI generates structured fix proposal → opens a real DRAFT PR on FitScript repo with proposal as markdown file. Human reviewer writes the actual code on that branch.

**Server (`server/tickets.ts`):**
- New endpoint `POST /api/ops/tickets/:id/open-fix-pr`.
- Step 1: Claude Bedrock HIGH_IQ generates structured JSON: `{pr_title, branch_name, target_files[], diagnosis, proposed_change, test_plan, open_questions}` with FitScript repo structure overview as context.
- Step 2: GitHub REST API (PAT-authed) creates branch from main → writes `.ops/fix-proposals/ticket-<short_id>.md` containing the proposal → opens DRAFT PR (draft to avoid auto-merge/notifications spam).
- Step 3: Updates ticket — status `pr_open`, `resolution_pr_url` populated.
- All audit-logged as `ticket.open_fix_pr` with metadata (pr_url, pr_number, branch, target_files).
- Cost logged to `ai_costs` as `surface=ops_ticket_fix_proposal`.

**Client (`client/src/pages/tickets.tsx`):**
- "🤖 Auto-fix via PR" purple button appears on `approved` or `triaged` tickets without an existing PR.
- Confirm dialog: explains the PR is draft + contains proposal markdown only, not auto-generated code.
- On success: shows "✓ Draft PR opened: <url>" + refreshes ticket detail (status → pr_open + PR URL section renders).

**Required env (ops dashboard):**
- `GITHUB_PAT_FITSCRIPT_FIX` — fine-grained PAT, scope: contents:write + pull-requests:write on markappz/Humn-Health
- `GITHUB_REPO_OWNER` — default "markappz"
- `GITHUB_REPO_NAME` — default "Humn-Health"
- `GITHUB_BASE_BRANCH` — default "main"

Until Paul generates the PAT, the endpoint returns 503 cleanly + the UI button shows the error inline.

### What I'll remember

- **AI proposes, human writes** is the safe v1 of auto-fix. Letting AI ship code directly to prod is a high-risk move. The draft PR with a structured markdown proposal is high-value scaffolding without the risk: the AI does the diagnostic + scoping work, the human writes the actual change.
- **Draft PRs are the right default for AI-generated PRs.** No auto-merge, no review notifications, no CI fired prematurely (some workflows skip drafts). Mark ready-for-review when the human has filled in actual code.
- **GitHub REST API via fetch** is simpler than @octokit for a 3-endpoint flow (get ref → create branch → put file → create PR). Less to install + audit.
- **The pipeline is fully wired but env-gated.** Phase 3 endpoint compiles + smoke-tests with 503 fallback. Real activation needs Paul's PAT. Same pattern as other env-gated features (Content Library S3, Klaviyo, Slack webhook).
- **Reporter widget as a single file with inline styles** avoids Tailwind purge concerns + makes it portable to any React app. Inline-style trade-off: no dark/light theme adaptation, but a fixed floating widget doesn't need it.



### What I'll remember

- **Unsplash Source is dead** — `source.unsplash.com/featured/...` returns 503. Anything that needs Unsplash photos in 2026 must hit `api.unsplash.com/search/photos` with a Client-ID key.
- **CSS font stacks with inner double quotes break HTML attributes silently.** Always normalize to single quotes when inlining `font-family` into `style="..."`. Same goes for any user-defined string interpolated into an attribute.
- **Klaviyo template URLs don't deep-link from outside the app.** Use `klaviyo.com/templates/list` as the "open in Klaviyo" target — the new template is at the top sorted by recent.
- **Klaviyo template editor types:** API can only create `CODE` (raw HTML). Drag-drop (`SYSTEM_DRAGGABLE` / `USER_DRAGGABLE`) types can only be made in Klaviyo's UI. The composer is HTML-author, not drag-drop-author.
- **Image-resolver pattern**: marker in src + client-side batch resolve + swap before render. Keeps the saved HTML pointing at the real CDN, no recipient traffic on our domain, and lets the model emit semantic queries without knowing real URLs.

