# Ops Dashboard Session Log

Running history of every development session. Autom reads this at the start of each session.

---

## 2026-09-06 (later) — RP Content tab live data + Content → sales attribution fixed

Paul flagged two stale RP views. Both were data-source problems, not display bugs.

- **SEO → Content → sales showed zeros.** The pixel on realpeptides.co records full URLs and posts live
  at root slugs, so the old `page_url ~ '^/(blog|…)/'` filter matched nothing, and RP article CTAs
  carry no `utm_source=content`. `content-performance` now normalises paths, takes articles from
  `ops_site_pages` (kind=blog) and, for untagged sites, attributes by sequence (article → product
  within 30 min = CTA click; last article view within 7 days before a purchase = attributed sale).
  One window-function pass, one pooled client, `statement_timeout 25s`. 30-day RP result at fix time:
  55,879 article views, 234 CTA clicks, 68 attributed purchases ($15.3k).
- **Content tab showed only the Clomark queue** (audit score from 10/2025, "0 published"). New
  "Live on realpeptides.co" block reads the site's token-gated `/api/ops-content` (realpeptides
  395c345, pushed by the ops session) via `/api/ops/rp/content-live` (10-min cache): published posts,
  new vs updated in 7/30 days, hubs, References count, calculators, recent changes, plus 30-day
  Search Console. Clomark audit scores older than 60 days now read "stale — last audit <date>".
- **Incident while testing:** the first draft of the attribution query used lateral joins and never
  returned; retries stacked 16 copies on the shared RDS for 20+ minutes and the pixel ingest queued
  behind them. Cancelled via `pg_stat_activity`; the timeout above is the guard. Memory note written.

## 2026-09-06 — RP SEO tab: Ranking Machine scoreboard (weekly Search Console cohorts)

Paul asked for the SEO program's measurement loop to live in ops instead of a laptop script.

- **Server** `server/rp-ranking.ts`: tables `ops_rp_seo_cohorts` / `ops_rp_seo_snapshots` / `ops_rp_seo_runs`
  (created on boot, raw SQL). Cohort membership seeds from `server/data/rp-seo-cohorts.json`
  (903 URLs: 30 compound hubs, 763 twin-merge winners, 23 query-mined pages, 86 calculator posts, the
  flagship calculator) — append there, upserts on boot. `runScoreboard()` pulls Search Console by page
  (7d ending 3 days ago + 28d, #fragment rows folded) through the existing RP Google connection and
  writes one snapshot row per cohort/window. Weekly loop: Monday 11:00 UTC, plus a catch-up on boot when
  the last snapshot is older than 6 days (prod only, or `OPS_ENABLE_SCAN=1`).
- **Routes** `/api/ops/rp/ranking` (cohorts, latest vs previous, 28d, sparkline series, run stamps,
  `connected`), `/api/ops/rp/ranking/cohort?name=` (per-URL 28d drill-down, 1h cache),
  `POST /api/ops/rp/ranking/run` (snapshot now), `POST /api/ops/rp/ranking/freshness` (stamp the
  quarterly freshness cycle, which still runs from clomark-nexus by hand).
- **UI** `client/src/components/rp-ranking-machine.tsx`, rendered inside the SEO tab for Real Peptides
  only: cohort table with week-over-week delta chips (red past a 25% drop), 28d clicks, click-trend
  sparkline, expandable URL list, "Snapshot now" and "Mark freshness run" buttons, and a reconnect
  banner when the Google token cannot refresh.
- **Blocker found while testing:** the stored pc@realpeptides.co Google token in ops no longer
  refreshes (`getAuthenticatedClient` returns null). Paul reconnects Google for Real Peptides via
  Integrations; the first snapshot then runs on boot. Tables + cohort seed already exist in RDS
  (created by the local test run).
- Not pushed yet — awaiting Paul's go.

## 2026-09-01 — RP Email tab: Sales column for campaigns (broadcast attribution)

Paul: opens/clicks/sales from email weren't showing in ops. Root cause was upstream — the
Resend sending domain had open + click tracking OFF (fixed by Paul in Resend: custom tracking
domain links.realpeptides.co, both toggles on, API-verified). Second gap was ours: the site's
/api/ops-email-summary attributed sales to flows only. Site commit 7e5cf91 (realpeptides)
now attributes to broadcasts as well (coupon first, else latest click within 7 days across
flows AND broadcast clicks; one destination per order). This repo: Campaigns table gets a
**Sales** column (`attributedOrders` / `attributedRevenueCents` on each campaign), subtitle
updated, empty-state colSpan 8. Vite build green. Needs the site deploy first — until then the
new fields are simply absent and the column renders "—".

---

## 2026-08-31 (close) — Full RP stack live; session state saved

Everything verified live as of close: Overview (site sales), Orders (source attribution,
beacon firing), Email (4 flows + guide funnels feeding, 111+ contacts), Wholesale (6 real
inquiries — ALGO $35,380 the big one; 2 dev-test rows to Decline), Leads, Marketing/Traffic
(pixel on store + all 3 guide funnels, CORS verified per-origin, bare→www 301s live),
COA Tracker (bulk upload/labs/delete), Inventory (live order sync 99.9% unit coverage,
POs, velocity, import/export, mobile sheet). SKU reconciliation vs site sheet: 83/83 exact.

Cross-repo state: RP repo main = wholesale endpoint (34f9a8a) + email endpoint + BIBLE mapping,
all deployed. Both my worktree branches merged + cleaned by the RP terminal. Tracker + ops in
sync with origin.

Outstanding forwards only: Justin (true-ups, AOD5/ARA16/SERM5 counts, labels), devs (MOTS 15mg
label, items[].sku, pending mapping). Nothing code-side pending anywhere.
---

## 2026-08-30 (late) — Email LIVE + Wholesale tab + Inventory import/export

**Email endpoint deployed by RP terminal** (cherry-picked 3d1f47d + 4adeb61 BIBLE→fat-loss-bible
coupon mapping). Verified live end-to-end: 4 flows reporting (post-purchase 23 / browse-abandon
18 / abandoned-checkout 15 / welcome 0), 105 marketable contacts, perSendStatsSince
2026-08-30T05:32Z. Guide funnels (fatlossbible.co, hairgrowthprotocol.com, peptide101guide.com)
will add flow keys as they feed — FLOW_LABEL fallback renders unknown keys raw.

**Wholesale tab** (/realpeptides/wholesale, nav Wholesale/users): the site ALREADY stores
inquiries (WholesaleOrder model — ref/status/business/contact/phone/items snapshot/totals).
RP-repo worktree branch **ops-wholesale-endpoint** (commit 5582599, off origin/main 20fa8de,
typecheck clean): GET /api/ops-wholesale (list w/ items, days param) + PATCH status (admin's
VALID_STATUSES). Ops: server/realpeptides-wholesale.ts proxy (5-min cache, PATCH passthrough
logs who) + page: status chips as filters, expandable cards (contact mailto/tel, label pref,
timeline, notes, line-item table), workflow buttons NEW→CONTACTED→APPROVED/DECLINED.
Browser-verified vs stub. WENT LIVE 2026-08-30 late: RP pushed 34f9a8a; verified direct + via ops — 6 real inquiries (4 NEW incl. ALGO $35,380 / 59 SKUs; 2 look like the dev team's own test rows — Justin can Decline those to clear them).

**Inventory import/export** (coa/InventoryImport.tsx + Export button): Export = CSV of all
inventory (round-trips into Import). Import = CSV/XLSX (SheetJS, dynamic import so the main
bundle stays lean), flexible header detection (SKU/Current Stock/Ideal Stock/Label Stock/Label
Ideal — Justin's master-sheet headers match), preview with old→strikethrough→new diffs,
unknown SKUs listed never guessed, apply via audited stock route (note: "spreadsheet import:
<file>") + target PATCHes. E2E: 152→160 + target 300 applied, RP-NOPE99 flagged, audit note
verified.
---

## 2026-08-30 (night) — RP Email analytics tab

Spec from the RP-repo terminal (their SESSION_LOG 2026-08-30 — email instrumentation commit
1d6e48b, LOCAL/unpushed). Architecture deviation, deliberate: spec said "read RP Postgres
directly" but the RP RDS is PubliclyAccessible:false with SG open only to RP tasks — ops' VPC
can't reach it, and the standing decision is token-gated endpoints, never second DB creds. So
the aggregation lives in the RP repo as `GET /api/ops-email-summary` (same authoriseOps +
realOrdersWhere/REVENUE_STATUSES as ops-summary; Resend broadcast names resolved site-side
where RESEND_API_KEY already lives — no new ops secret). Written on worktree branch
**ops-email-endpoint** (~/Projects/real-peptides-worktrees/ops-email, commit 7830100, typecheck
clean) so the other terminal's checkout is untouched — THEY merge/push it with their
instrumentation deploy.

Endpoint contract: per-flow (sends/instrumented split, open/CTR on instrumented only, per-step
drilldown, unsubs attributed to last send before unsubscribedAt, sales = coupon source
WELCOME/CARTSAVER first then last-click-within-7d by contact email, one flow per order,
realOrdersWhere + PAID/FULFILLED), per-campaign from EmailEvent by broadcastId (unique
opens/clicks by email), totals (marketable/unsub/suppressed bounced-vs-spam split, windowed
instrumented rates, attributed revenue, lifetime per-contact counters SEPARATE),
perSendStatsSince for the UI caveat.

Ops: server/realpeptides-email.ts proxy (10-min cache, graceful 404 waiting state) +
/realpeptides/email page (nav Email/mail): 6-stat strip, caveat banner (start date + lifetime
totals + UTC note), flows table w/ expandable step drilldown + partial-instrumentation notes,
campaigns table. Verified against a stub payload in browser.

Goes live when: RP terminal merges ops-email-endpoint + Paul approves their push (migration +
endpoint deploy together). Until then the tab shows the wired-and-waiting state.
---

## 2026-08-30 (later) — Inventory v2: live sync, POs, forecasting, mobile (Shelf Planner dead)

Paul's batch: mobile adjust broken; Justin wants POs + forecasting; kill Shelf Planner — live
order→inventory sync. Pairs with tracker a856f2c.

- **`server/realpeptides-inventory.ts`**: 10-min loop (startRpInventorySyncLoop in index.ts)
  fetches site /api/ops-orders (7d window) → tracker /api/orders/consume; hard cutoff
  RP_ORDER_SYNC_SINCE=2026-08-26T13:00Z (sheet-seed moment — NEVER lower, double-decrements).
  Manual POST /api/ops/realpeptides/inventory/sync; GET /inventory-stats = 28d velocity per SKU
  (site order items name-matched via tracker /skus/match, 10-min cache) + lastSync state.
- **Inventory tab v2** (realpeptides-inventory.tsx):
  - Mobile: < md renders tap-cards; tap (or clicking any product name on desktop) opens SkuSheet —
    big ± buttons w/ qty, exact count, target, label file, recent movements. This is the fix for
    "can't add inventory on phone".
  - "Selling" column: n/wk · weeks-left (red < 4w); stock cell shows "+N on order"; sync
    timestamp chip next to the view toggle.
  - **POs** (coa/PurchaseOrders.tsx): modal list; "New PO from current shortfall" drafts one from
    every below-target product (qty = target − stock − on_order); Mark ordered → on-order;
    Receive → stock in; PDF per PO (downloadPoPdf). orderQty() now subtracts on_order so the
    Order PDF stops re-suggesting bought stock.
  - Proxy allowlist + Justin's grant extended to /pos.
E2E on scratch stack (stub site): cutoff/idempotency/unmatched verified, PO lifecycle verified
(47→147 on receive), sheet +5 via UI, PO modal renders. Both prod builds pass.

---

## 2026-08-30 — Orders attribution VERIFIED live

Devs shipped /api/ops-orders (55+ orders, exact contract, 401 sans token) and — after one
false "completed" (beacon absent: 0 purchase touchpoints ever, post-deploy order untracked,
no fsTrack in chunks) — the purchase beacon on redeploy. Verified with REAL orders: last 24h
= 6 direct / 3 organic-search (Yahoo + Google w/ landing pages) / 1 email (campaign
"site_relaunch_bundle_intro_2026") / 1 social (Instagram → Semax page); pre-beacon history
correctly "untracked". Synthetic ingest test from site origin returned 200 (revenue-0,
unmatched order id — harmless). Known wrinkle: some sessions start ON /checkout/success/
(session rolled mid-checkout) → classified direct with that landing; acceptable, revisit if
direct% looks inflated. RP sync is now COMPLETE end-to-end.
---

## 2026-08-29 (night) — RP Orders tab with source attribution

Paul: "orders tab... organize by how the order came in — seo page, blog, email campaign etc."
Built on the pixel that just went live on the new site:
- `server/realpeptides-orders.ts` — pulls the site's (to-be-shipped) token-gated
  `GET /api/ops-orders`, joins purchase touchpoints by `event_data->>'order_id'` to sessions,
  classifies: email (utm_medium/CR/Moosend) > paid (gclid/fbclid/cpc) > ai > social >
  organic-search vs blog (landing /blogs/) > referral > direct; no beacon match = "untracked",
  never guessed. Event-level first-touch UTMs beat session-level.
- `/realpeptides/orders` page — channel revenue tiles double as filters, orders table with
  source chip + "came in via" (landing · campaign · referrer), 7/30/90d, search.
- Spec artifact extended (same URL): §1 purchase beacon one-liner
  (`fsTrack("purchase",{order_id,revenue})` on confirmation page), §3 /api/ops-orders contract,
  acceptance updated (pixel + ops-summary marked done; flagged their pending==orders mapping).
Verified locally: stub site API + seeded sessions → blog/email/organic-search/untracked all
classified right, tiles + table render. Graceful waiting state until devs ship ops-orders.
---

## 2026-08-29 (later) — Sync ops to the NEW realpeptides.co (Vercel)

Paul: "new website live, sync it to the dashboard." Diagnosis of the new site (Next.js, custom
commerce API — /api/cart in cents; no Woo, no exposed DB):
- **Sales dead**: /wp-json/wc/v3 404s on both hosts → Overview sales card was erroring.
- **Pixel gone**: no /t.js tag on the new site (Moosend + GTM only).
- **Fine**: sitemap.xml live (Pages tab OK), COA feed consumed by product pages + /coas.

Shipped ops-side: `server/realpeptides-site.ts` — connector for the site's future
`GET /api/ops-summary` (bearer RP_SITE_OPS_TOKEN, cents → SalesSummary shape, 10-min cache);
overview prefers it when RP_SITE_API_URL is set, Woo 404 now degrades to a "site migrated"
connect state instead of an error. Spec artifact for the Vercel team (pixel tag + endpoint
contract + acceptance): https://claude.ai/code/artifact/12d5065c-e007-42b0-abed-302ae4348290

DEV TEAM SHIPPED + VERIFIED 08-29 night: /api/ops-summary live (401 sans token, full contract
with it), pixel tag on the site (t.js loads, /api/t beacons, pixelInstalled true, sessions
flowing). Overview shows real sales — BUT the new backend only holds new-site orders: 30d =
$11.6k / 48 orders, previous window $0, ~all volume dated 08-29 (launch-era data). The
$500k+/mo Woo history is NOT in this source — don't read the delta as a crash. pending=48 ==
orders — their fulfillment status mapping may need a look.
WIRED 08-29 evening: Paul ran scripts/wire-rp-site.mjs — token minted (delivered to devs
out-of-band), both secrets in prod/ops-secrets, task-def rev 192; the concurrent GH-Action
deploy built rev 193 ON TOP of 192 (inherited the refs + newest image) — race resolved right.
Verified live: overview sales = configured:false "wired and waiting" hint. Now purely on the
dev team: pixel tag + /api/ops-summary (+ RP-MOT25-NS SKU on site); everything lights up
automatically when they ship. @aws-sdk/client-ecs added as devDependency for the script.
Note: only 1/89 tracker SKUs has product_url set (new /products/<slug>/ style) — backfill is a
nice-to-have for cert deep-links.
---

## 2026-08-29 — History panel: delete a test or vault file (inline confirm)

Pairs with tracker per-certificate deletion. Trash icon on each "Tests on record" row (deletes
the test + its files) and each "Files in the vault" row (single file); two-step inline confirm —
never confirm()/prompt(), native dialogs freeze the tab. Grant realpeptides:coa-upload now allows
DELETE on coa/api/(skus|documents|coas)/:id so Justin can remove a wrong cert himself.
Reason: lab-typo cert ("Thymulin") under Thymalin was feeding the site's certificate history and
was un-removable from the UI; product delete+re-add is soft by design and keeps certs.

---

## 2026-08-26 (seed complete) — Prod inventory is real; Justin's reconciliation applied

Paul ran scripts/sync-master-sheet.mjs + finish-seed.mjs (classifier blocks Autom's own prod
writes; the ! prefix works). Applied per Justin's answers: RP-MOT-NS → RP-MOT25-NS (website may
still carry the old code — RP devs), PID-8207 → RP-ORFO12C "Orforglipron Capsules", discontinued
RP-ARA16V + RP-SERM5V, added his 8. Seeded stock on all + targets on 83 (RP-SEM-NS / RP-TESAIPA105V
were negative on the sheet — oversold — floored to 0 with a note; Orforglipron 153/7 via new SKU).

Verified on prod: 89 tracked / 89 stocked / 23,644 units, 45 below target (Order PDF ready),
11 out, old codes gone, public feed serving stock (RP-MOT25-NS stock 70 inStock true).
Labels view live; label counts start empty for Justin to enter. Reta-label question: no label
files on record — Justin uploads current art to the Labels column, vault becomes truth.

---

## 2026-08-26 (labels are inventory) — Vials/Labels toggle on Inventory

Paul clarified: track printed vial labels + when to reorder, not just the artwork file. Inventory
page now has a Vials & units / Printed labels toggle: same table + audited adjust/targets/history
per item (log rows tagged vials/labels, purple chip), "Label print order" PDF in labels view vs
the manufacturer purchase order in vials view. KPI "No label file" = missing artwork (both views).
Replaced prompt() stock/target editors with inline cell inputs (Enter saves, Esc cancels) —
native prompts freeze the tab. Browser-verified locally: label +200/−50/+25 flows, 175/500 →
"to print 325", per-item logs, vial stock untouched.

NOTE for Paul's question "COA tab only shows a few products": that was the Chrome tab Autom was
test-driving — localhost:5002 against a 10-SKU scratch DB. Prod (ops.fitscript.me) had all 83
SKUs / 60 family cards the whole time (verified via API at the same moment).

---

## 2026-08-26 (later) — Real Peptides Inventory tab (Justin) — built + tested, NOT pushed

Paul: "inventory tab... add inventory, take away, and it updates the live site. same with labels...
order pdf for low stock... run report/download and send to manufacturer."

- **`/realpeptides/inventory`** (`realpeptides-inventory.tsx`, nav "Inventory", package icon).
  Rides the existing COA proxy + `realpeptides:coa-upload` grant — zero new auth surface (stock
  route lives under /skus/:id/stock which the grant's POST pattern already matches).
- **Stock**: per-row − [qty] + steppers (delta), click the number to set an exact count, floors
  at 0; history icon expands the audit trail. The ops proxy stamps `by = adminEmail` onto stock
  posts so the tracker's inventory_log records who. Null stock renders "—" and counts as
  untracked, NOT out-of-stock (tile consistency fix).
- **Targets**: click target cell → set ideal_stock (PATCH). "To order" = ceil(ideal − current);
  no target + out → red "no target" chip.
- **Labels**: chip per product — download (product-named), replace, or dashed "Add label"
  (any file type, vaulted as category='label'). KPI tile "Missing label" filters to gaps.
  Tightened FamilyDetail doc filters to category==='coa' so labels never render as certs.
- **Order PDF** (`coa/order-pdf.ts`, jsPDF + autotable — client-side, no server deps): black/gold
  RP-branded purchase order of everything below target with ORDER QTY; blank ____ where no
  target is set. Verified output (2-page render, correct math).
- KPI tiles All / Below target / Out of stock / Missing label double as filters; search.
- Sku type + export gains label_doc_id/ideal_stock; tracker /api/skus feeds it all.

**Verified in browser** (localhost:5002 vs local tracker): +10 BPC → log shows
changed_by=paulclotar@gmail.com → public feed stock:10 inStock:true (the Vercel contract),
label upload/download chip, history row, order PDF download. Both prod builds pass.

**Pending Paul:**
1. Push both repos (tracker 6fdac3f first, then ops).
2. Run `node <scratchpad>/sync-master-sheet.mjs` (supersedes add-missing-skus.mjs): adds the 8
   missing products AND seeds current_stock + ideal_stock for all 83 from the master sheet.
3. Tell the Vercel/RP devs: /api/public/products now carries `stock` and `inStock`.

---

## 2026-08-26 — COA tab: bulk uploader, labs, vault thumbnails, workflow filters, export (Justin)

Justin's requests, both repos touched (tracker commit 01a2ee8 pairs with this one):

- **Bulk upload** (`coa/BulkUpload.tsx`): drop N PDFs/images → tracker's new `/skus/match` maps
  filenames to products (aliases + dose-aware, test date parsed from MMDDYY/YYYYMMDD tokens) →
  editable staging table (product/date/lot/purity per row, one lab for the batch) → sequential
  uploads through the existing single-file endpoint with per-row status. Ambiguous files are
  flagged yellow, never guessed.
- **Labs**: pickers everywhere the lab was hardcoded — CoaUpload select, "Mark sent to <default>"
  split button (native <select> under the caret; a custom popover gets clipped by the card's
  overflow-hidden), Action Summary banner. Manage labs (add / make default / remove) lives in the
  bell modal (`AlertSettings` → LabsPanel). Kovera default; 9x Testing seeded.
- **Thumbnails fixed**: every card image was blank — wp-content hotlinks 403 cross-site (Cloudflare
  bot protection; dies with Vercel migration anyway). Now `thumbUrl()` in coa/api.ts renders the
  tracker's vaulted image (`image_doc_id`) through the proxy; 82/83 SKUs already have one.
- **Workflow filters**: "Send to lab" / "At the lab" tiles next to the status tiles (StatusDonut);
  family matches if any variant does. Shared `atLab`/`needsSend` helpers in coa/api.ts.
- **Export** (`coa/export.ts`): one-click CSV of every SKU — status, days left, action needed,
  test/expiry dates, lab, lot, at-lab-since/sent-to, doc count, stock. Urgent rows first. BOM'd
  for Excel.
- Proxy allowlist + `/labs`; upload route now accepts images like the tracker does (and forwards
  the real mimetype instead of hardcoded application/pdf).

**Verified locally end-to-end** (scratch pg 5499 + tracker :5101 + ops :5002, browser-tested:
filters, family detail, lab picker, 3-file bulk drop incl. one ambiguous, CSV download). Prod
builds pass in both repos. **Prod RDS was NOT reachable from this Mac today** (timeout) — ops ran
against a scratch DB with a hand-inserted ops_admins row.

**Pending / for Paul:**
1. Approve: `node <scratchpad>/add-missing-skus.mjs` adds the 8 master-list products missing in
   prod (ARA-290 10mg, Copper Peptide Serum, Dihexa caps, Glutathione 1500mg, Oxytocin 10mg,
   Sermorelin 10mg, Tesa+Ipa 12/3, Tesofensine). Classifier blocked me writing to prod.
2. ~~Push both repos~~ DONE 2026-08-26 ~17:10 ET — both deployed (ops run 32992005306, rebased onto
   dev's Bedrock commit 2f7a1e9; GH Actions lagged ~25 min before firing, added workflow_dispatch
   to ops deploy.yml). Browser-verified on prod: thumbnails render, tiles 47 send / 16 at lab,
   bundle index-B1qxfWi4.js matches local build.
3. Reconcile with Justin: RP-MOT-NS vs sheet RP-MOT25-NS (same product, rename?), PID-8207 needs
   real Orforglipron SKU, ARA-290 16mg vs 10mg, Sermorelin 5mg vs 10mg both live.
Master sheet parsed from ~/Downloads/"RP __ SKU's-2 (1).xlsx" (83 active products).

---

## 2026-08-21 (later) — RP sales via WooCommerce Analytics; Campaign Refinery fixed

**WooCommerce:** first prod numbers looked great ($593k/30d) but the *previous* window showed 118
orders vs ~2,140 real — the `wc/v3/orders` pager hit its 30-page cap on the 60-day fetch and
silently truncated. Rewrote `server/woocommerce.ts` on **`wc-analytics/reports/revenue/stats`**
(server-side totals + daily intervals, two requests per range) and **`reports/products`** for top
sellers. Revenue card = **net revenue** (after coupons/refunds, before shipping/tax), gross shown
in the sub. Verified vs `X-WP-Total`: 30d net $565k / 2,379 orders / AOV $238 / 1,703 customers;
prior 30d net $527k / 2,090 (+7%). Coupons are big here — gross prior window was $925k.

**Campaign Refinery:** the connector called `/rest/contacts`, which doesn't exist (404 in prod).
Documented route is `GET /rest/contacts/get_contacts` (bearer, newest-first, per_page ≤ 100,
`data.total`). **Its `contact_add_start/end` filters are ignored** — every variant returns the
full 57,220 — so "new in N days" walks pages until `contact_add_dts` passes the cutoff (cap 100
pages → `capped:true` and a "+" in the UI), 15-min cache. 30d = 5,581 new, 7d = 1,199 (~160/day).
Removed the old shape-guessing `pickArray`.

**Prod secrets dance today:** Paul added the CR key to `prod/ops-secrets` + task def rev 180 but
the service stayed on 179 until `UpdateService` — the console's revision dropdown trap again.
Overview "Not connected" in Paul's screenshot was the pre-180 task; prod is correct now.

---

## 2026-08-21 — Real Peptides Command Center (the one brand without an Overview)

Paul: "FitScript has Command Center with real numbers; I want this for each brand." pawgen and
PeptideU already had Overview pages with real revenue / MRR; Real Peptides was the gap (its nav
started at Leads and `/realpeptides` redirected there).

- `realpeptides-overview.tsx` at `/realpeptides` (nav "Overview", `COMPANY_ROOTS` updated): sales
  (connect state), sessions + Δ (pixel), search clicks + Δ (Pages summary), Moosend / Campaign
  Refinery, COA tiles, live URLs / getting impressions / Clomark suggestions / generated / SEO
  score, top products (when sales connected), integration health row. Range 7/30/90.
- `GET /api/ops/realpeptides/overview?range=` → sales + pixel traffic with previous-window delta
  (`trafficWindow`; params cast `::int` — untyped `$2 + $3` threw "operator is not unique").
- **`server/woocommerce.ts`**: read-only WooCommerce REST connector (`RP_WOO_CONSUMER_KEY/SECRET`,
  optional `RP_WOO_URL`): orders for 2×range, paid = completed/processing, revenue/orders/AOV/
  customers for current + previous window, daily series, top products, 10-min cache. Verified the
  live store's REST API is enabled (401 without key). **Unset → `configured:false` + instructions;
  the /realpeptides/* no-currency rule holds until the key lands.** After the Vercel launch the
  new site is Supabase-backed (preview HTML references it) → `RP_DATABASE_URL` becomes the source.
- `/api/ops/pages?summary=1` returns totals without the 23k rows.

**Prod wiring (same day):** Paul supplied a read-only WooCommerce key; verified against the store
(3 processing orders that morning). Added `RP_WOO_CONSUMER_KEY/SECRET` to Secrets Manager
`prod/ops-secrets` and registered task-def **rev 177** with the two secret refs via the AWS SDK
from this Mac (no aws CLI here; the .env AWS keys have the permissions). Found while there:
`RP_MOOSEND_API_KEY` and `RP_CAMPAIGN_REFINERY_API_KEY` were **never set in prod** — the RP Leads
tab has been showing "key not set" since 08-14. Asked Paul for them.

Local run (prod RDS, local Google client): sessions 1,138 (+100%), search clicks 23,259 (+34%,
1.57M impressions), 23,812 live URLs, 9,464 getting impressions (40%). GSC worked locally this
time — the earlier `deleted_client` was transient. Prod-only keys (Moosend, CR, COA, Clomark)
show as "key not set" locally and fill on deploy.

---

## 2026-08-20 (late night) — Pages: sitemap × Search Console × pixel, per brand

Paul, looking at the RP Content tab: "how is it correlated to ranking, traffic, etc for each of
the pages? add fields for traffic based on Search Console and accurate info with the sitemap."
Clomark's own status is useless for that — RP shows 0 published while its WordPress sitemap lists
thousands of posts — so the sitemap is the source of truth and GSC is the scoreboard.

**`server/pages.ts` — `GET /api/ops/pages?company=&days=28[&refresh=1]`**
- Sitemap crawl from robots.txt (index → children, regex XML, 80 sitemaps / 60k URLs cap), cached
  in `ops_site_pages` (+ `ops_sitemap_runs`) for 6h; URLs that drop out of the sitemap are deleted.
  Kind comes from the WordPress sitemap name first (post-/page-/product-sitemap), then path.
- GSC `searchanalytics` by `page`, paginated 25k/startRow, current + previous window (end = today−2d
  for GSC lag) → per-row click/impression/position deltas. A GSC failure degrades to a banner
  (`deleted_client` → "reconnect Google in Integrations"), never a 500.
- Pixel per path: page_view touchpoints (views/visitors), visitor_sessions.landing_page (sessions),
  and landing-page revenue (purchase touchpoints joined to their session's landing page).
- Rows = sitemap ∪ GSC pages; GSC-only rows flagged `inSitemap:false` (orphans / 404s Google still
  shows). Totals: live, "getting impressions" (closest indexed proxy), zero impressions, orphans,
  clicks/impressions with deltas, revenue, byKind.

**`company-pages.tsx`** at `/pages` (FitScript), `/pawgen/pages`, `/realpeptides/pages`: KPI tiles,
views (in sitemap / zero impressions / not in sitemap / everything), type + sort + path filter,
table with deltas, show-more paging (RP has 23k rows). GSC tiles show "—" when not connected.

**Real crawls (prod RDS now holds the cache):** Real Peptides **23,812 URLs / 33 sitemaps**
(20,589 blog, 2,397 page, 515 location, 310 product); pawgen 1,006 (854 location); FitScript 415.
**GSC could not be verified from this Mac** — the local GOOGLE_CLIENT_ID is a deleted OAuth client
(`deleted_client`), prod's is fine (SEO tab works there). Check /realpeptides/pages on prod.
PeptideU has no public site → `configured:false`. `npm run dev` is plain tsx, not watch — restart
after server edits (bit me once tonight).

---

## 2026-08-20 (night) — Clomark content per brand: pawgen, Real Peptides, PeptideU tabs

Paul wants each brand's Clomark SEO pages / blogs visible in its own ops section, like FitScript's
/content. The bridge already existed (Clomark Nexus `server/ops-api.ts` ↔ ops `server/clomark.ts`)
but was pinned to one business id via `CLOMARK_BUSINESS_ID`.

- `server/clomark.ts`: `COMPANY_BUSINESS` map (fitscript 533eac81…, pawgen 71d86e68…, realpeptides
  b68ed2a5…, peptideu c9843d66…), `CLOMARK_BUSINESS_ID_<COMPANY>` env override, every route takes
  `?company=` (default fitscript, unknown → fitscript). `getConfig(company)` → 17 call sites.
- `content.tsx`: `ClomarkCompanyContext` + `useClomark()` (`url()` appends company; cache keys include
  it). 12 fetches + 16 queryKeys rewritten; `const cl = useClomark()` in the 7 components that
  fetch. New export `CompanyContent({company,label})` = hero + the full `ClomarkSection`
  (queue, add content, location pages, drafts viewer, approvals, bulk publish). FitScript page
  unchanged (default context).
- Routes `/pawgen/content`, `/realpeptides/content`, `/peptideu/content` + nav "Content" entries.

**Clomark DB facts (Neon, queried 2026-08-20):** Real Peptides profile under paul@clomark.ai has
**19,660 generated pieces / 16,542 suggestions**; pawgen 25; FitScript 3 (under a third user
ef95a5b0); PeptideU exists only as "UPeptides" (peptide-u.replit.app) under demo@clomark.ai with
2 pieces — needs a real profile under Paul's account, then set `CLOMARK_BUSINESS_ID_PEPTIDEU`.
The pawgen id in memory (b19357ec) no longer exists; 71d86e68 is current.

**Can't verify against live Clomark from this Mac** — `CLOMARK_BASE_URL/OPS_TOKEN/BUSINESS_ID`
live only in the ECS task secrets. Verified locally: per-company routing, unknown company falls
back, all three tabs render the setup state, FitScript /content unchanged, tsc + build clean.
Real check = open /realpeptides/content on prod after deploy. Note `CLOMARK_BUSINESS_ID` in prod
secrets may point at a different FitScript profile than the DB default — it still wins for fitscript.

---

## 2026-08-20 (evening) — Full COA tracker UI ported into ops

Paul wanted the tracker experience itself (cards → click → variants → history), not just a
table, plus product URLs for the coming Vercel storefront. Replaced the table page with a port of
the tracker client under `client/src/pages/coa/`:

- `api.ts` (types, proxy base `/api/ops/realpeptides/coa/api`, shared `ui` classes),
  `families.ts` / `summary.ts` (copied verbatim from the tracker), `StatusDonut`, `FamilyGrid`,
  `FamilyDetail` (variants: COA preview/download, product image, History panel with tests / vault
  files / lab send-outs, inline **Upload COA** that records the test, **Edit** name/SKU/product URL,
  **Delete**, Oryn cert, "Mark sent to Kovera"), `ActionSummary` (copy/push/Kovera post now),
  `AlertSettings` (Slack/WhatsApp status, test message, recipients). Page: hero actions (Action
  Summary, Import CSV, alerts, refresh, Add product modal with URL), donut filters, search.
- Proxy allowlist widened to `/lab-tests`, `/team`, `/notify`; viewer grant covers document POSTs.
- Reads `/api/skus` through the proxy (family keys, thumbnails, test_status) — the old ops-only
  summary endpoint is no longer used by the page but still exists.
- `FamilyDetail` keeps previous data during refetch (`keepPreviousData`) and closes panels before
  the refetch so a click mid-refresh isn't undone. `data-variant` / `data-panel` attributes on
  variant cards exist for tests.

Headless E2E: open family → upload on a variant (goes fresh) → History shows the test + file →
Edit saves a product URL → Escape closes → Add product modal → card appears → Action Summary.
Three false alarms in the harness worth remembering: the minted session cookie expires after 1h
(page silently becomes the login screen); a wait condition satisfied by stale DB state let a click
land mid-upload; CSS `uppercase` labels need case-insensitive assertions. None were app bugs.

**Lot / batch #** field added to the variant upload form (forwarded as `lot_number`); History rows
show `lot …`. Needed so the public COA searcher can match what's printed on a vial.

Styling note: ops' `fitscript-green` token renders the dashboard's blue accent here — consistent
with the rest of ops, intentionally not the tracker's gold.

---

## 2026-08-20 (later) — COA tab becomes the COA manager; tracker UI retired

Paul's call: two places doing the same thing is one too many. coa.realpeptides.co's UI now
redirects here; its service stays headless (DB, S3 vault, Slack schedulers) and ops drives it
through a token-gated proxy. Justin's real needs: upload COAs, add / rename / delete products.

- `server/realpeptides.ts`: `app.all("/api/ops/realpeptides/coa/api/*")` passes JSON and raw
  multipart (express.raw on that route) to the tracker with the bearer, streams bytes back
  (PDF/image downloads, presigned S3 redirects followed server-side). Allowlist: `/skus`,
  `/documents`, `/coas` only — team/notify/auth are not reachable.
- `realpeptides:coa-upload` grant now also covers POST/PATCH/DELETE on `/skus`.
- `realpeptides-coa.tsx` rewritten: Add product (hero action), top upload panel (kept), search,
  table with Certificate "View" link, and per-row **inline** Upload COA / Rename / Delete. The
  old row button only preselected the top form and scrolled — Paul read that as broken. Same
  `CoaForm` powers both the panel and the inline row.
- Removed the "everything else lives at coa.realpeptides.co" footer; it doesn't anymore.

Headless E2E (puppeteer, same recipe): add → inline upload (row flips fresh) → rename → delete,
zero page errors. tsc + prod build clean. Deploy order: tracker first.

**Parked:** the "Build" widget (chat → agent edits a tab's source → PR → Paul merges) lives on
local branch `build-widget-wip`, untested, not pushed. It was the answer to "let Justin change the
COA tracker" before Paul narrowed that to upload/add/rename/delete. Revisit only if asked.

**Update (evening):** everything below was ported after all — see the entry above.

---

## 2026-08-20 — COA uploader on the Real Peptides tab (for Justin)

Paul wants Justin to file new COAs from ops instead of the tracker. Built it as the **one write**
the RP COA tab is allowed.

**Finding that shaped the design:** in coa.realpeptides.co, uploading a PDF only creates a
`documents` row — it never records a test. `coas` rows (what status is derived from) can only be
created via a raw `POST /api/coas` nobody calls from the UI. That is why 78 of 83 SKUs sit at
expired/untested with `lab_name` null: the team has been uploading certificates that never counted.
The ops uploader records the test **and** vaults the PDF in one call, so the SKU flips to fresh.

**Tracker (`realpeptides-coa`, `server/ops-summary.ts`):** new `POST /api/ops-coa-upload`, same
`COA_OPS_TOKEN` bearer as the summary, registered ahead of the password gate. Multipart
`file` (PDF ≤25MB) + `sku_code`, `test_date` (YYYY-MM-DD), optional `lab_name` (defaults Kovera),
`purity`, `uploaded_by`. Inserts the `coas` row (expiry via `expiryFromTestDate`), then
`ingestDocument({coaId})`, then stamps `file_s3_key` back on the COA. **Not a transaction on
purpose:** `ingestDocument` writes through the shared pool and `documents.coa_id` is an FK, so
the COA must be committed before the document can reference it — a single-client transaction
would deadlock on itself. Compensation: delete the COA if vaulting fails. Summary rows now also
carry `id`.

**Ops:** `POST /api/ops/realpeptides/coa/upload` (multer → `FormData`/`Blob` fetch to the
tracker; ops never touches its bucket/DB). New scoped grant `realpeptides:coa-upload` in
`PERMISSION_ROUTES` so a viewer account can be given this write and nothing else.
`/api/ops/auth/me` now returns `permissions` (`["*"]` for admins) so the client can gate UI.
Justin (justin@justinillig.com) is already an **admin**, so he needs no grant.

**Client (`realpeptides-coa.tsx`):** upload panel above the stats (product select with current
status, test date defaulting today, lab, purity, PDF picker, File COA), shown only when
`canUpload`. Each table row gets an "Upload COA" link that preselects the product and scrolls up.
Success banner reports the computed expiry; the table refetches.

**Verified locally, end to end with real processes:** no Postgres on this Mac and the tracker's
RDS is private, so `brew install postgresql@16`, scratch cluster on :5499, tracker schema applied,
two SKUs seeded, tracker on :5101 with `COA_OPS_TOKEN=localtest`, ops on :5002 with
`COA_API_URL=http://localhost:5101`. curl: 401 without token, actionable 400s for bad date /
missing SKU / non-PDF, 404 for unknown SKU, viewer without grant → 403, admin upload → SKU
untested → fresh with correct expiry, file lands in the vault. Headless Chrome (puppeteer-core,
Chrome MCP can't reach localhost — see memory) filled the form, submitted, saw "Filed for BPC-157 …
valid until 2026-11-18" and the refreshed row. Gotcha: Vite's HMR client force-reloads the page
when its websocket fails under headless, wiping form state mid-test — stub `/@vite/client` via
request interception. Both repos `tsc` + prod build clean.

**Deploy order:** tracker first (new endpoint), then ops. No new env — both already share
`COA_OPS_TOKEN`. **Not pushed** — awaiting Paul.

**Pending:** Oryn-branded COAs and product images still only via the tracker UI. Consider a
backfill that turns the existing vault PDFs into `coas` rows (needs test dates — maybe from the
filenames) so the 47 "expired" SKUs with real certificates stop alarming.

---

## 2026-08-17 — Bot traffic dropped at the pixel (backfilled log)

Googlebot renders JS and fired the pixel on ~160 freshly crawled pawgen pages in one day — 95% of
"article views" were its Nexus 5X rendering UA. `server/tracking.ts` now answers 204 to known bot
UAs before writing anything; historical bot sessions + their page_view touchpoints were deleted
across all sites. Commit `a3e0902`.

---

## 2026-08-16 — Content → sales attribution on the SEO tab (backfilled log)

pawgen article CTAs stamp `utm_source=content / utm_medium=<kind> / utm_content=<slug>`, but the
touchpoints insert dropped medium/content/term, so a mid-session CTA click lost which article sent
the buyer. Ingest now stores `utm_medium/content/term` per touchpoint (columns + partial index
applied to RDS; schema file updated). New `GET /api/ops/content-performance?site=&days=`:
per-article views, CTA clicks (sticky split out), purchases, revenue — purchase credit = the buyer's
LAST content CTA before purchase (LATERAL), plus a content-influenced total. SEO tab renders it for
every brand from the first-party pixel. Commit `2473063`.

---

## 2026-08-14 (later still) — SEO tab crashed on real data: a type lie I introduced

`/realpeptides/seo` white-screened with `a.position.toFixed is not a function` the moment it had
actual Search Console data behind it.

**Cause:** `server/google-auth.ts` already calls `.toFixed(1)` on per-row `ctr` and `position` before
sending, so `topQueries[]` carries **strings** while `totals` carries **numbers**. My `Gsc` interface
in `company-google.tsx` declared both as `number`, so `tsc` happily allowed `q.position.toFixed(1)`
on a string. Confirmed against live RP data: `{'ctr': ('69.0', 'str'), 'position': ('2.3', 'str')}`
alongside `totals.ctr: 2.83 (float)`.

**`content.tsx` had it right all along** (`ctr: string; position: string`) — the pawgen page I
generalized from had it wrong and never crashed only because pawgen has no GSC data to render. The
bug shipped the moment a brand with real search traffic used it. When generalizing a component,
check its types against a consumer that actually has data.

**Second bug fixed in the same line.** `pct()` guessed the scale from magnitude —
`n <= 1 ? n*100 : n` — but both routes already return percent units. A genuine 0.8% CTR would have
rendered as 80%. No RP query is currently under 1% CTR so it never showed, but it was live and would
have appeared as soon as one was. Replaced with a plain formatter plus a `toNum()` coercion.

Verified locally against real RP data before pushing: SEO renders 20,827 clicks / 735,041 impressions
/ 2.8% CTR / avg position 11.0 with 25 query rows; Site Traffic renders 83,838 users / 100,603
sessions. tsc + build clean.

---

## 2026-08-14 (later) — RP corrections during rollout: wrong funnel domain, wrong email platform

Two things I had wrong, both caught by Paul actually rolling this out.

**1. The Peptide Playbook funnel is `peptide101guide.com`, not `peptideplaybook.com`.** The ecosystem
notes had the wrong domain and peptideplaybook.com answers nothing at all. This mattered: unknown
origins get no CORS headers, so the tag was live on peptide101guide.com and **every event was being
dropped at the preflight**. Both apex and `www.` added to `ORIGIN_SITE`. Verified locally — preflight
returns 204 with the allow-origin header, and an event lands as `site='realpeptides'`.

Worth remembering: a wrong origin fails *silently and completely*. Nothing errors in the dashboard;
the tab just shows no traffic, which is indistinguishable from no visitors.

**2. Real Peptides does NOT use Klaviyo — it uses Moosend and Campaign Refinery.** I built the Leads
tab on Klaviyo because that's FitScript's platform and I assumed it carried across. It doesn't.
Rebuilt on both real platforms:
- **Moosend** — `api.moosend.com/v3/lists.json?apikey=`, mailing lists + active member counts.
  Note Moosend answers **HTTP 200 with a non-zero `Code`** on failure, so status alone lies; the
  client checks the body. Verified against the live API with a deliberately bad key → `API_KEY_NOT_VALID`
  surfaced correctly, which also confirms the request shape.
- **Campaign Refinery** — bearer token, base `https://api.campaignrefinery.com`, `GET /rest/contacts`.
  Its response schema isn't published, so the parser accepts several common shapes and, when it can't
  find a contact array, **reports the top-level keys it did receive** instead of showing a zero. First
  real call diagnoses itself.
- The two are independent: one missing key or one API outage degrades that card alone. Verified.

`RP_KLAVIYO_API_KEY` is gone — do not add it. Env is now `RP_MOOSEND_API_KEY` and
`RP_CAMPAIGN_REFINERY_API_KEY`.

**Also confirmed live during rollout:**
- Google connected for realpeptides — GA4 `494045509`, `sc-domain:realpeptides.co`, under
  `pc@realpeptides.co`, its own row. Traffic + SEO are live.
- Pixel tag confirmed serving on **fatlossbible.co** and **peptide101guide.com**.
- **hairgrowthprotocol.com still isn't serving it** despite being added — served HTML is byte-identical
  (same bundle hash `index-B_U8SI-4.js`), no `ops.fitscript.me` anywhere. It's a Vite SPA carrying
  Moosend's `mootrack` and a Meta pixel, so tags do land there; ours isn't in the deployed build. Needs
  to be in `index.html` + a rebuild — editing a component won't do it.
- **The COA token deploy took three tries, and the lesson is worth keeping.** Both new task-def
  revisions were correct from the start (`realpeptides-coa-task:14`, `fitscript-ops-task:167`, valid
  ARNs, matching 64-char token in both secrets) but the *services* were never repointed — still on
  `:12` and `:166`. Then a second attempt ticked "Force new deployment" while leaving the **Revision
  dropdown on the current revision**, which cleanly redeployed the old config. The dropdown defaults
  to current, not latest. Resolved by calling `UpdateService` directly with
  `taskDefinition: realpeptides-coa-task:14`. The ops side fixed itself: the deploy workflow builds
  from the family's *latest* revision, so my push produced `:168` carrying the token.

**COA endpoint VERIFIED live** — the path that had never run. `GET /api/ops-summary` returns 200 with
real data: **83 tracked SKUs — 47 expired, 31 never tested, 5 fresh**, `validityDays: 90`. So the SQL,
the status derivation and the sort all work against the production schema.

**That number is a business finding, not just a green test:** 78 of 83 SKUs have no current COA.
`lab_name` is null on every row too, so the lab column will render "—" until COAs are attached.

---

## 2026-08-14 — Real Peptides added as the fourth company

Paul: *"I need to add Real Peptides to the dashboard."* RP is the awkward brand — realpeptides.co is
WordPress + WooCommerce and **no API credential for it exists anywhere on this machine** (grepped
`~/Projects` for `WOOCOMMERCE|ck_*` — nothing). Paul's call: build on what's readable today rather
than block on Woo keys. Tabs chosen: Leads, Marketing, Traffic, SEO, COA. **No Overview/Orders tab** —
an overview with no revenue on it is a page of dashes.

**Six tabs live at `/realpeptides/*`:** Leads · Marketing · Site Traffic · SEO · COA Tracker · Integrations.
The company switcher is now a **2×2 grid** — a fourth pill in a 256px sidebar wraps the labels.

**Each tab's real data source, and its honest empty state:**
- **Marketing** — the first-party pixel, `site='realpeptides'`. Verified end-to-end: POSTed an event
  with `Origin: https://realpeptides.co` against prod, confirmed `visitor_sessions.site` and
  `touchpoints.site` both landed as `realpeptides`, saw it surface in the tab, then deleted both rows
  (RP session count back to 0). Until a real event arrives the tab shows install instructions, not zeros.
- **Leads** — RP's **own** Klaviyo via `RP_KLAVIYO_API_KEY`. Deliberately not the existing
  `KLAVIYO_API_KEY`: that's FitScript's account and would report FitScript's subscribers under RP.
- **Traffic / SEO** — already company-scoped server-side, so this was pure UI.
- **COA** — proxied from coa.realpeptides.co's new token-gated endpoint (see below).
- Everything says "no revenue on this page" out loud. WooCommerce isn't readable; nothing here pretends
  otherwise.

**New: a standalone pixel at `GET /t.js` (public).** WordPress can't import `client/src/lib/tracking.ts`,
so ops now serves a ~2KB vanilla script — one `<script src="https://ops.fitscript.me/t.js" defer>` tag.
It derives its ingest host from its own `src`, keeps first-touch UTMs in localStorage (a later organic
visit must not overwrite the ad that won the visitor), and **never claims which brand it is** — the
server still decides that from the Origin. realpeptides.co, fatlossbible.co, peptideplaybook.com and
hairgrowthprotocol.com all map to `realpeptides`; the funnels are RP traffic, not brands of their own.
`TRACKING_ALLOWED_ORIGINS` is now derived from `ORIGIN_SITE` so the two lists can't drift.

**COA tracker (separate repo, `markappz/realpeptides-coa`):** added `GET /api/ops-summary`, read-only,
bearer-token gated on `COA_OPS_TOKEN`, registered **before** the shared-password gate. Ops can't reach
that app's RDS (different AWS account, private subnet), so this is the pawgen/ShippingEasy pattern —
the credential stays in one system. Auth verified in every branch: token unset → 503, no header → 401,
wrong token → 401, wrong token of equal length → 401 (timing-safe), correct token → past auth.
**The 200 path's SQL is NOT verified** — no Docker and no local Postgres on this machine, so nothing
could run the query. First real call against prod is the actual test.

**Two pre-existing bugs fixed in passing:**
1. `tsc` had been red since `f63a2d5` (two implicit-`any`s in `supplements-detail.tsx`). Fixed — the
   repo typechecks clean again, which is what makes a *new* type error visible.
2. Company-root nav items matched by prefix, so `/pawgen/orders` lit up "Overview" in the sidebar and
   the breadcrumb read "pawgen / Overview" on every pawgen page. Roots now match exactly.

`pawgen-google.tsx` became `company-google.tsx` (company/label/domain props); pawgen renders through
the same component, verified in-browser after the swap.

**Still needed from Paul, in priority order:**
1. **Connect Google for Real Peptides** (Integrations tab) → Traffic + SEO light up immediately. Nothing
   to deploy.
2. **`RP_KLAVIYO_API_KEY`** — read-only `pk_*` from RP's Klaviyo → Leads.
3. **`COA_OPS_TOKEN`** — one random value, set on *both* task definitions → COA tab.
4. **The `t.js` tag on realpeptides.co + the three funnels** (devs, one line in the header) → Marketing.
5. Optional later: a read-only WooCommerce key turns Marketing into real revenue attribution.

Verified locally against prod RDS (`humn-production…rds.amazonaws.com` — checked the host first).
`tsc` clean, `npm run build` clean in both repos. **Nothing pushed.**

---

## 2026-08-13 — pawgen dashboard complete · auth roles · the Neon trap

**The day's biggest lesson: `~/Projects/ops-dashboard/.env` had TWO database urls.**
The code reads `DATABASE_URL`, which held a dead **Neon** url from the Replit era, while
production ECS reads a different `DATABASE_URL` (RDS) from Secrets Manager. The correct one
sat beside it the whole time as `RDS_DATABASE_URL`. Every local script wrote to Neon while
production read RDS — silently, no error. It produced a chain of confident wrong answers:
admins "added" that a teammate couldn't use, passwords "set", a migration "verified", and a
claim that "FitScript's pixel was never deployed, 2 test rows" when prod had 682 sessions
and 1,040 touchpoints. **Print the DB host before trusting any local script.** Fixed here
and in ~/Projects/fitscript (both repointed to RDS, Neon line commented, backups kept).
**clomark is NOT the same** — its Neon DB is live with 36 tables and real data; leave it.

**pawgen tabs (7, all on real data):** Overview, Orders & Refunds, Leads, Marketing,
Site Traffic, SEO, Integrations. Leads shows 178 signups → 10 customers → $1,715 traced.
Marketing reads first-touch `ref_*` off orders and states attribution coverage honestly
rather than lumping unknowns into "direct".

**Auth, now role-aware and DB-backed:**
- password login (scrypt, Node stdlib) for team addresses that aren't Google accounts
- `role` on ops_admins: admin | viewer. Viewers read everything, mutate nothing
- `permissions TEXT[]` for scoped grants — `pawgen:refund` lets support refund pawgen
  orders and nothing else. Matcher verified against traversal, other brands, other methods
- **revocation is now absolute**: getAllowlist() used to fall back to ADMIN_EMAILS on a
  cold cache, so a removed admin was re-admitted for the window after every restart

**Google connection is per-company.** It was a single row and connect DELETEd the table, so
adding pawgen would have silently disconnected FitScript. Also fixed: both GA4/GSC overview
routes called getConnection() with no company and would have shown FitScript's numbers on
pawgen's tab; and OPS_GOOGLE_REDIRECT_URI was `http://`, which Google rejects — that flow
had never once completed, for any brand.

**Tracking is multi-brand.** `site` column across the pipeline, ingest derives the brand
from the browser-set Origin (never a client field), FitScript aggregates scoped. Verified
live: fitscript 732 / pawgen 9, side by side, no bleed.

## 2026-08-13 — pawgen referral breakdown ("Where orders come from")

chootherescue.com ($CHOO) is live and about to send real traffic to pawgen, so partner performance
needed to be visible without hand-running SQL.

- **`GET /api/ops/pawgen/referrals`**, implemented on **both** source paths. REST wins per `307f100`,
  but the pool branch is kept in step so precedence can flip without silently losing the feature.
  PostgREST has no GROUP BY, so the REST path pulls the (small) order set and aggregates in Node —
  fine at this volume, revisit past five figures of orders.
- **NULL `ref_source` is bucketed as `(direct)`, never dropped.** It's genuinely direct traffic plus
  every order placed before attribution existed. Hiding it would make the totals lie.
- **`link_clicks` is optional.** It only exists once `db/partner_links.sql` has run on the pawgen
  database, so a missing table degrades to clicks/conversion "—" plus a hint, rather than breaking
  the panel. (Paul ran it 2026-08-13; the panel now shows real click counts.)
- UI sits between the stat cards and the orders table on `/pawgen/orders`: source · clicks · orders ·
  paid · conversion · revenue · last order, sorted by revenue.

Verified live: panel renders `direct / untagged · 0 clicks · 17 orders · 16 paid · $2,828.55`.

**Two things worth knowing:**
1. **The shared checkout swept up my work.** Commit `891fda1` ("Fulfilment status…") from another
   terminal included my 65-line `referrals()` addition to `server/pawgen-rest.ts` — it ran
   `git add -A` while my edit was uncommitted. No damage, but the code shipped under someone else's
   message. **Use a worktree when two terminals share this repo.**
2. **`tsc` is red** in `client/src/pages/supplements-detail.tsx` — two implicit-`any` params from
   `f63a2d5`. Not mine, left alone. The Vite build doesn't typecheck, so deploys still pass — which
   is exactly how this hides a real error later.

## 2026-08-11 — pawgen tab re-verified; `PAWGEN_DATABASE_URL` creds finally corrected

Confirmed live: **$1,397.95 revenue · 7 paid orders · 5 to fulfill · 0 refunded**, order table
with pack/BAC add-on/fulfillment, refund panel expanding correctly ("Paid $256.00 by card" +
partial field + reason + the points-reversal note). Growth from the 08-05 numbers ($978 / 5) is
just new orders.

**Correction to what I told Paul in-session:** I said the tab was "still broken" without
re-checking it — I was repeating an observation from 08-01 and had not read the 08-05 entry
below. It had been working for six days via the REST path. **Re-read this log before asserting
the state of anything; a claim from earlier in a long session is not a current fact.**

Paul did update `PAWGEN_DATABASE_URL` on the task def to the proper session-pooler URI
(user `postgres.<project-ref>`, host `*.pooler.supabase.com:5432`, plaintext Value on
`fitscript-ops-task`, then force-deploy). That was **not what made the tab work** — REST takes
precedence per `307f100` — but it does retire the footgun documented on 08-05: a set-but-invalid
DSN no longer sits there as a trap if precedence is ever flipped back.

**The username gotcha, recorded for the next time this comes up:** Supabase's *Direct connection*
string uses the bare `postgres` user; the **session pooler** requires the project-scoped
`postgres.<project-ref>`. The mismatch surfaces as `password authentication failed for user
"postgres"` — which reads like a wrong password and sends the diagnosis down the wrong path
entirely. Check the username before touching the password.

---

## 2026-08-05 — pawgen orders: second way in (Supabase REST), no DB password needed

Paul: *"i'm still seeing that the ops dashboard doesn't show pawgen orders"* — prod still shows
"pawgen orders unavailable / password authentication failed for user \"postgres\"".

The 08-01 diagnosis was right (bad creds on `PAWGEN_DATABASE_URL`, needs the session-pooler
`postgres.nlejhymlnniwxwduvvqw` user) but the fix was blocked on a **Supabase DB password nobody
has to hand** — it isn't in this repo's `.env`, and pawgen's own app can't supply one because it
talks to Supabase over the JS client with a service-role key.

**So: added a REST path that reuses the credential that already exists and already works in
pawgen production.** `server/pawgen-rest.ts` reads/writes pawgen's Supabase over PostgREST with
`PAWGEN_SUPABASE_URL` + `PAWGEN_SUPABASE_SERVICE_ROLE_KEY`. `server/pawgen.ts` now picks a source:
**`pawgenPool` still wins whenever `PAWGEN_DATABASE_URL` is set** (keeps the aggregate SQL
server-side); REST is the fallback. Fixing the pooler URI later needs no code change.

Covers everything the tab does: orders list (+status filter, +pagination via `Prefer: count=exact`),
headline stats, per-status counts, single-order lookup, and the refund reconciliation writes
(`markRefunded`, `findRedemption`, `restorePoints` — the last idempotent against the unique
`(email, reason, order_id)` index).

**Verified against LIVE pawgen data** (ran the real module, not a mock):
```
STATS    → { paidOrders: 5, revenue: 978, refunded: 0, toFulfill: 3 }
STATUSES → { unfulfilled: 3, shipped: 2 }
ORDERS   → 5 rows  (Sabine Scales 4-pack $256 unfulfilled · Patrick gaffney 4-pack $256 shipped ·
            AIRFIX LLC 1-pack $110 shipped · Sam Cheow 4-pack $276 unfulfilled ·
            Paul Clotar 1-pack $80 unfulfilled)
FILTER unfulfilled → 3 · PAGINATION limit2 → total=5 pages=3 · getOrder(bogus) → null
```
So there IS real data behind the banner — **$978 across 5 paid orders and 3 still unfulfilled.**

**SHIPPED + VERIFIED LIVE.** Paul added the secret + the two task-def entries; deployed in three
commits (`bce554a` → `307f100` → the 416 fix). `ops.fitscript.me/pawgen` now renders
**$978.00 revenue · 5 paid orders · 3 to fulfill · 0 refunded** with the full order table.
Filters verified against prod: all=5, unfulfilled=3, shipped=2.

**Two bugs the deploy caught that local testing could not:**
1. **Precedence was backwards.** First deploy still showed the identical
   `password authentication failed for user "postgres"`. `new Pool()` never connects eagerly,
   so `pawgenPool` is non-null whenever `PAWGEN_DATABASE_URL` is merely SET — invalid creds
   included. The stale bad DSN silently shadowed the working REST config. **REST now wins when
   configured**; "pool exists" is not evidence the pool works.
2. **`?page=2` returned HTTP 500.** PostgREST answers **416** when a Range starts past the last
   row; SQL `OFFSET` just returns nothing. `rest()` now maps 416 → empty page (keeping the count
   off `Content-Range`), matching the SQL path. Verified: offset 50/5000 → 0 rows total=5,
   in-range paging unaffected.

**To go live, 2 env vars on the ECS task def** (the deploy workflow pulls the LIVE task def via
`describe-task-definition`, so they persist across deploys — the static-file footgun from 06-03
doesn't apply):
- `PAWGEN_SUPABASE_URL` — not secret, plaintext env is fine (`https://nlejhymlnniwxwduvvqw.supabase.co`)
- `PAWGEN_SUPABASE_SERVICE_ROLE_KEY` — **secret**; belongs in `prod/ops-secrets` + a `valueFrom`
  ref like the other 21, NOT plaintext. Note the 08-01 warning that a `valueFrom` addition once
  tripped the deploy circuit breaker — if it does again, that's a bad ARN/permission, not this code.
Values are in `~/Projects/pawgen/.env.local` as `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`.

**Caveat worth revisiting:** the service-role key bypasses RLS on all of pawgen's database, while
the tab only needs orders + points_ledger. Acceptable for an internal admin dashboard behind the
Google gate; a scoped Supabase key or a read-only DB role would be tighter if the surface grows.

**Scale note:** PostgREST can't SUM without an RPC, so `ordersSummary()` reduces in JS over a
capped fetch. Fine in the hundreds; past ~10k orders move it to a view or RPC.

---

## 2026-08-01 — pawgen tab crash fix (prod white-screen) + log backfill

`ops.fitscript.me/pawgen` was **white-screening in production** with `Cannot read properties of
undefined (reading 'pages')`. Two separate problems stacked:

**1. Client crash (fixed here, commit below).** `client/src/pages/pawgen-orders.tsx` typed the
orders response as if every field were always present, then rendered
`{data && data.pagination.pages > 1 && …}`. An error body (`{error: "…"}`) is truthy, so it blew
straight through the guard into `undefined.pages` → React unmounted the whole route.

- `OrdersResponse` fields (`orders`/`stats`/`statuses`/`pagination`) are now **optional**, so
  `tsc` forces a guard at every read — this bug class can't come back silently.
- Pagination guard → `data?.pagination && …`; Next-button bound to `data.pagination?.pages ?? 1`.
- `queryFn` now catches a non-JSON body (ALB/HTML error pages) and synthesizes
  `{error: "Orders request failed (HTTP <status>)"}` instead of throwing into a blank state.
- Error state renders cleanly: red banner ("pawgen orders unavailable" + server message), stats
  cards show "—", table shows "Not connected — no orders to show", no pagination row.
- Also fixed the React key warning in the same block — the row pair was wrapped in a bare `<>`
  with keys on the children; now a keyed `<Fragment key={o.id}>`.

**2. Root cause — BAD credentials, not a missing env var (Paul's action, AWS).** The working
assumption going in was that `PAWGEN_DATABASE_URL` had never been added to the ECS task def. The
deployed page disproved it: with the crash gone, the real server message is visible and it is
**`password authentication failed for user "postgres"`**, not
`pawgen database not connected (PAWGEN_DATABASE_URL unset)`. So the var **is** on the task def —
Postgres is rejecting it.

The user in the URI is plain `postgres`. Supabase's **session pooler** requires the project-scoped
user **`postgres.nlejhymlnniwxwduvvqw`** — a direct-connection URI pointed at the pooler host
fails exactly this way. Same shape that worked for `PEPTIDEU_DATABASE_URL` on 2026-07-19
("Session pooler :5432, `postgres.…` user"). Fix = copy the Session-pooler URI from the Supabase
dashboard (Connect → Session pooler, project `nlejhymlnniwxwduvvqw`, us-east-2), reset the DB
password if it isn't at hand, update the task-def env var, force-redeploy. Plaintext on the task
def works; a `ValueFrom` secret tripped the deploy circuit breaker last time.

Note pawgen's own app can't supply a URI to copy — it talks to Supabase over the JS client with
`SUPABASE_SERVICE_ROLE_KEY`, not a Postgres connection string.

Verified: `tsc --noEmit` clean, `npm run build` clean, deploy green, **served bundle hash changed**
`index-BqjAXZcs.js` → `index-B1yBo92e.js` (per the silent-deploy lesson), and `/pawgen` on prod now
renders the banner + "—" stats + "Not connected — no orders to show" instead of white-screening.
Local dev can't render the page without a Google sign-in (ops gate), so the visual check was done
on prod.

Also backfilled this log — it had gone stale at 2026-07-19 while five commits shipped (below).

---

## 2026-07-23 → 07-31 — Backfill: PeptideU authoring/moderation + pawgen tab

Log wasn't written at the time; reconstructed from commits `ef205fb…9f437e2`.

- **`9f437e2` (07-31) — pawgen company tab.** Third company in the top-bar switcher
  (FitScript / PeptideU / pawgen). `server/pawgen.ts` + a `pawgenPool` in `server/db.ts` read
  pawgen's Supabase Postgres over raw SQL; `client/src/pages/pawgen-orders.tsx` lists orders with
  headline stats (revenue, paid, to-fulfill, refunded), status filter, and an expandable
  **one-click refund** panel. Card refunds hit **pawgen's own Stripe account**
  (`PAWGEN_STRIPE_SECRET_KEY`, separate from FitScript's) and the `charge.refunded` webhook on the
  pawgen side reverses loyalty points; crypto orders are flagged manual-refund-only. Both
  connections are env-gated → 503 + "not connected" when unset.
- **`b7fc90d` (07-29) — PeptideU features: moderation queue + approve gate + built reward.**
  `pending` is now a real moderation state (members can't see a request until `approved`); the
  queue sorts pending first, then by votes. Status transitions stamp `approved_at` / `built_at`,
  and setting `built` fires `reward_feature_built($1)` — idempotent entries + points for the author.
- **`64c0a83` (07-25) — Library Updates review queue.** `/peptideu/library` +
  `GET/POST /api/ops/peptideu/library-updates(/:id/approve|dismiss)`. AI-drafted library edits land
  in a queue for human approve/dismiss instead of publishing straight to the app.
- **`bc3ee11` (07-24) — native AP Class authoring panel.** `/peptideu/ap` +
  `GET/POST/DELETE /api/ops/peptideu/ap`. Authors AP classes in ops instead of hand-writing SQL.
- **`a7c1a6b` (07-24) — PeptideU insights: daily auto-refresh + stored results.** Insight queries
  compute on a daily cadence and persist, so `/peptideu/questions` reads stored rows instead of
  re-running expensive aggregates on every page view.
- Earlier in the window (`f349e4b`, `a8d6561`, `ef205fb`, 07-23): coach queue now includes Commons
  posts with a source badge; drawing copy says "winner" (singular) when `num_winners = 1`;
  Prize Lineup editor for the auto-create queue.

---

## 2026-07-19 — PeptideU section: management + moderation + drawing (write-enabled)

Extended the PeptideU section from read-only analytics into a full admin surface. All raw SQL on `peptidePool`; every mutation is admin-only for free (`opsGate` 403s viewers on non-GET). Deployed to ops.fitscript.me (commits through `32bf652`).

- **Prod blocker fixed:** `PEPTIDEU_DATABASE_URL` was never set → section showed "not connected." Paul's dev added it (Session pooler :5432, `postgres.…` user, WRITE-capable) as a plaintext env var on the live ECS task def (a ValueFrom-secret attempt tripped the deploy circuit breaker — secret resolution failed at task start). "[OPS DB] Connected" confirmed. Persists across deploys (pipeline reads the live task def). **TODO: move to Secrets Manager** (+ execution-role `secretsmanager:GetSecretValue`) to get the password out of the task def.
- **Members** (`/peptideu/members`): search, comp/remove premium (logs `ops_comp` lifetime grant), set role. Kills the SQL-editor grind for the two most-common ops.
- **Requests** (`/peptideu/requests`): deny/approve member peptide+brand suggestions. Peptide approve → AI Library draft via the ops `anthropic` client (Sonnet 4.5, `BEDROCK_MODELS.HIGH_IQ`), prompt kept in sync with the app's `admin-generate-peptide` edge fn — no cross-repo secret. Draft lands `published=false`; publish from the app.
- **Moderation** (`/peptideu/moderation`): post-hoc take-down of live Commons posts (DELETE, cascades) + peptide/brand reviews (reject). No reports table yet — take-down, not triage.
- **Drawing** (`/peptideu/drawing`): entry leaderboard + totals + prize picker + "Run drawing" (weighted-random `run_drawing`, admin-only) + past winners. Reads/writes PeptideU's `entry_leaderboard`/`run_drawing`/`recent_winners` (migration 0052 in the PeptideU DB).
- Server: all endpoints in `server/peptideu.ts`. Nav: added Members/Requests/Moderation/Drawing to `PEPTIDEU_NAV_SECTIONS` (+ shield/gift icons). Docs in `PEPTIDEU_OPS.md`.

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

## 2026-06-06 — Session close: memory updates + pickup notes

End-of-arc state save before Paul closes the terminal. Memory updated, pending Paul-side items recorded.

### Memory updates

- `~/.claude/.../memory/project_ops_reports_section.md` — refreshed from "4 reports, June 1" snapshot to current 6 reports + Klaviyo split-metric rule + perf pattern (warmer, caches, kFetch retry cap). Edit-style updates so pre-existing gotchas + envelope contract + links stayed put.
- `~/.claude/.../memory/feedback_klaviyo_engagement_vs_revenue.md` — NEW. The split-metric rule from the 2026-06-04 regression captured as a feedback memory so future sessions can't repeat it. Linked into `MEMORY.md`.

### Open / pending

**Task #44 — DMARC Phase 2 activation** (in_progress, parked on Paul):
- Mailgun Inbound Route to create in their UI: `match_recipient("dmarc@email.fitscript.me")` → `forward("https://ops.fitscript.me/api/dmarc/inbound")` + optional `store()`
- Webhook Signing Key from Mailgun → Sending → Domain settings → Webhooks. Hand to me. I'll write to `prod/ops-secrets`, add to `.aws/task-definition.json`, push, verify.
- Update DMARC `_dmarc.fitscript.me` `rua=` to add `mailto:dmarc@email.fitscript.me` alongside the existing Brevo address.

**Deliverability followups:**
- Forward a real Klaviyo email's `Authentication-Results` header so we can confirm DKIM alignment on `send.fitscript.me` (the Klaviyo NS-managed zone showed empty when queried, but UI says Active — actual outbound auth status unverified)
- After 2-3 weeks of clean Brevo DMARC reports, upgrade `_dmarc.fitscript.me` from `p=none` to `p=quarantine`

**External approvals (passive wait):**
- Meta Ads system-user token (Meta Business Settings)
- Google Ads developer-token (waiting on Google approval; already submitted)

### Resume notes for next session

1. Read this entry + 2026-06-05 (later) + 2026-06-04 (late) entries above for full context.
2. Reports section is 100% built against Paul's original 5-source / 4-section brief. Six reports + Growth Overview live; CSV export on every report; FitScript GA4 events firing.
3. The bottleneck on email-revenue cards: needs first real Lab Order Placed event with `$value` to hit Klaviyo's classifier. Then `pickRevenueMetric` will resolve and revenue cards populate.
4. If anything breaks on `/reports/email`, first suspect: Klaviyo API change (filter operators, filterable fields shift every revision).
5. Localhost dev server stopped at session close — restart with `cd ~/Projects/ops-dashboard && npm run dev` (or `OPS_ENABLE_WARMER=1 npm run dev` to also test the warmer locally).

---

## 2026-06-05 (later) — /reports/email cache warmer + perf hardening

Paul tested `/reports/email` locally after the engagement regression fix and it was "taking too much time" — caught two remaining issues + added a background warmer.

### Issues caught

1. **`kFetch` 429 retries were uncapped.** Klaviyo's "Expected available in 60s" response triggered infinite retries that locked the request for minutes. Capped at 2 attempts with a max 10s Retry-After honor.
2. **Revenue-metric probe lied.** `pickRevenueMetric` was testing candidates with the `delivered` stat (engagement), which Klaviyo accepts for any metric. The real query then asks for `conversion_value` — which Klaviyo rejects with "metric does not support values data" if the metric hasn't been classified as values-data-compatible yet. So we picked "Lab Order Placed", the real query failed, and revenue stayed blank. Fix: probe with `conversion_value` for revenue candidates so the probe actually validates what the real query will do.
3. **Cold-load latency.** Klaviyo value-reports endpoint has a ~2/min sustained limit. A single page load fires 4 calls (engagement + revenue × campaigns + flows). The 60s TTL response cache (commit `61d60e6`) helped — cold ~21s, warm <100ms — but the cold experience was still painful.

### Cache warmer (commit `856f42c`, task def `:105`)

- Extracted `buildEmailReport(days)` from the express handler so both the handler and a background loop can call it.
- Bumped response-cache TTL from 60s to 6 min so the 5-min warmer always refreshes BEFORE entries expire — user requests effectively never see a cold cache.
- New `startEmailReportWarmer()` in `server/reports.ts`:
  - 60s startup delay (lets the container settle)
  - Then every 5 min: warm both 30d and 7d windows (the two windows the UI defaults to)
  - Auto-enabled when `NODE_ENV=production`; dev opt-in via `OPS_ENABLE_WARMER=1`
- Wired into `server/index.ts` alongside `startDirtScanLoop` + `startDirtDailyReportLoop`.

### Verification

Local (`OPS_ENABLE_WARMER=1`):
```
[email-warmer] enabled — first run in 60s, then every 5min for windows 30,7d
[email-warmer] startup 30d warmed in 13986ms
[email-warmer] startup 7d warmed in 17339ms
```
Subsequent local user requests: 61-62ms.

Prod (`ops.fitscript.me`):
- `generated_at` is 7s old (warmer is firing cleanly)
- User-side requests: 384-497ms (ALB + network, not Klaviyo)
- No 429s

Klaviyo gets exactly 2 calls per 5 min for value-reports — well under their 2/min sustained limit and far below the prior bursty pattern.

---

## 2026-06-04 (late) → 2026-06-05 — DMARC Phase 2 webhook + /reports/email engagement regression fix

### DMARC Phase 2 — Mailgun inbound auto-ingest (commit `7ebd1b6`, task def `:101`)

`email.fitscript.me` already has Mailgun MX (`mxa.mailgun.org` / `mxb.mailgun.org`) so no new DNS work. Built a public webhook that auto-ingests DMARC reports once Paul wires the Mailgun side.

**`server/dmarc.ts`** — added `POST /api/dmarc/inbound`:
- Sits outside `/api/ops/*` so `opsGate` lets Mailgun's unauth'd POSTs through
- HMAC-SHA256 signature verification (Mailgun's `webhook signing key` over `timestamp + token`)
- 15-min replay window enforced via timestamp check
- multer-parsed multipart, 25MB cap per file, 20 files max per POST
- Each attachment runs through existing `extractXmlFromBuffer` + `parseDmarcXml` + `storeReport`
- ALWAYS returns 200 to Mailgun (per-file errors logged) — non-2xx triggers Mailgun retries which just re-fail on bad XML

**Deployed but dormant** — three things still on Paul's plate to activate:
1. Mailgun UI → Receiving → Routes → create `match_recipient("dmarc@email.fitscript.me")` → `forward("https://ops.fitscript.me/api/dmarc/inbound")` + optional `store()` for backup
2. Hand me the Webhook Signing Key (from Mailgun → Sending → Domain settings → Webhooks)
3. Update DMARC `rua=` in Cloudflare to add `mailto:dmarc@email.fitscript.me` alongside the existing Brevo address

Endpoint currently returns 503 `"webhook signing key not configured"` — by design, until secret lands.

### /reports/email engagement REGRESSION — caught + fixed (commit `cb6b146`)

While auditing the original brief at session end, noticed open/click/bounce/unsub all reading `None` in production. Root cause: the earlier "promote Lab Order Placed to conversion metric" change broke engagement aggregation. Klaviyo's `campaign-values-reports` + `flow-values-reports` filter their output to campaigns/flows that have conversions of the specified `conversion_metric_id`. Switching from `Received Email` (engagement) to `Lab Order Placed` (revenue) meant only campaigns that drove actual lab orders showed up — and there have been zero. Engagement columns silently went blank.

**Fix:**
- Split `pickConversionMetric` into `pickEngagementMetric` + `pickRevenueMetric` with distinct candidate lists
- Run BOTH per surface in parallel (so each campaign + flow gets queried twice — once for engagement, once for revenue)
- Merge: engagement counts come from the engagement-metric pass, `conversions` + `conversion_value` come from the revenue-metric pass
- `meta` block now exposes both metric names (`campaign_engagement_metric` + `campaign_revenue_metric`, same for flows) plus back-compat aliases for the existing client

**Performance fallout:** 4 separate metric picks (campaign engagement + revenue, flow engagement + revenue) each calling `/metrics/` + up to 4 probe POSTs blew past Klaviyo's response times — first cold call hit 2-min timeout. Fix: hoisted `/metrics/` into a module-level cache (30-min TTL) shared across all picks; resolved (path, candidates) → metric is also cached the same way. Cold call now ~3-5s, warm <200ms.

**Verified on prod:** open=34.13% · click=0.15% · bounce=9.81% · unsub=0.45% · revenue available=true · per-subscriber=$0 (no paid orders in window yet — will populate as Lab Order Placed events with `$value` start flowing).

### Audit against Paul's original 5-source / 4-section brief — 100% built

| Brief item | Status |
|---|---|
| GA, WooCommerce, Hyros, Meta, Google Ads, Campaign Refiners | GA live; rest wired-but-quiet awaiting credentials |
| SITE TRAFFIC (5 page types + popup) | All bucketed; popup waits on event firing |
| CONVERSION RATES (5 funnels) | All wired; populate as GA4 ecommerce events fire |
| EMAIL (6 metrics) | All live including revenue per subscriber |
| SALES (7 metrics) | All live; $0 until paid lab orders happen |

Plus extras: Ads & Attribution report, DMARC report (Phase 1 + Phase 2 endpoint), Growth Overview on Command Center, CSV export on every report, FitScript GA4 event firing.

### Pending followups

- Hand me Mailgun webhook signing key → write to prod/ops-secrets + task def → DMARC reports auto-flow
- After 2-3 weeks of clean Brevo DMARC reports → upgrade `_dmarc.fitscript.me` from `p=none` to `p=quarantine`
- Forward a real Klaviyo email's `Authentication-Results` header so we can confirm DKIM alignment on `send.fitscript.me`

---

## 2026-06-04 (evening) — Reports → DMARC ingestion (Phase 1)

### What shipped (commit `7ceb683`, task def `:99`)

After the Jun 4 DMARC apex fix sent Brevo into report-receiving mode, built a manual-upload surface so the reports are actually visible.

**`server/dmarc.ts`** — new module:
- Two new tables: `dmarc_reports` (one row per aggregate report, unique on `(org_name, report_id)` for dedup) and `dmarc_records` (one row per source-IP rollup inside a report). FK + cascade delete. Indexed on `date_range_start DESC` + `source_ip`.
- Parser handles `.xml`, `.xml.gz`, and `.zip` via `node:zlib.gunzipSync` + `adm-zip`. Magic-byte fallback if filename extension is missing.
- `POST /api/ops/dmarc/upload?filename=...` — raw body (20MB cap), returns `{ inserted, duplicate, records_count, total_messages }`.
- `GET /api/ops/dmarc/aggregate?days=N` — summary (aligned %, DKIM/SPF pass %, quarantine/reject counts) + senders table + reporting-orgs breakdown + recent reports list.
- `DELETE /api/ops/dmarc/reports/:id` for cleanup.

**`client/src/pages/reports-dmarc.tsx`** — new page:
- Drag-drop upload card with batch + per-file status (Ingested / Duplicate / Failed).
- 4 stat cards (total / aligned% / DKIM% / SPF%) plus quarantine+reject cards when those are non-zero.
- Sender table with messages-bar + tone-colored alignment % per source IP.
- Reporting-orgs grid + recent-reports table.

Sidebar entry added under Reports (now 6 reports: Traffic, Conversions, Email, Sales, Ads, DMARC).

### Deps added

`fast-xml-parser` + `adm-zip` (+ `@types/adm-zip`). ~290kb total.

### Verification

- Local: synthetic Google + Yahoo reports uploaded, aggregations correct, dedup blocks re-uploads, fully-failed sender renders `0%` (not `null`) after a small SQL fix (COALESCE around the SUM-with-FILTER inside the pct calc).
- Prod: task def `:99` running, endpoint returns `reports_count: 0, total_messages: 0` (correct — no reports uploaded yet), `dmarc_records` + `dmarc_reports` tables present in RDS.

### Phase 2 — deferred

Mailgun inbound route → webhook so reports flow in automatically from a `dmarc@<mg-subdomain>` address added to the DMARC `rua=`. ~1 hour of work when needed. Noted inline on the page + in the commit so it's not lost.

### Pending followups

- Wait for first real Brevo-forwarded reports → upload → see actual sender alignment for Klaviyo (`send.fitscript.me`), Mailgun, Google Workspace, LeadConnector
- If alignment is poor for any sender, that drives the next deliverability fix

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


## 2026-08-31 — Admin allowlist: Morelli switched to personal Gmail

Session in ops UI only (no code changes, no deploy). Via Settings → Admins on ops.fitscript.me:

- **Added `morellifit@gmail.com`** as admin (Michael Morelli — he logs in with his personal Gmail, not the fitscript.me address).
- **Removed `mm@fitscript.me`** from the allowlist (was env-bootstrap seeded).
- Allowlist is back to 8 admins; both actions are in the Admin Log tab.

### What I'll remember
- The dashboard's Live mode swaps company views under you mid-interaction — coordinate clicks are unreliable on ops; use element refs (find/read_page) for anything that mutates state.
- Add-admin dedupes by email server-side: a double-submitted email still produced exactly one row.

## 2026-09-01 — Justin's inventory suite: custom POs, paste check-in, forecast, team permissions, lab send-outs

Everything Paul asked for Justin, in the RP Inventory + COA tabs (tracker-side engine committed in realpeptides-coa `fcd4629`).

### Inventory (`realpeptides-inventory.tsx` + `coa/PurchaseOrders.tsx`, new `coa/Forecast.tsx`)
- **Custom PO builder** — search products, set quantities (prefilled with target shortfall), supplier/note → draft PO.
- **Check-ins are per-line and partial**: each PO card gets a Check in expander (inputs prefilled with what's open); "Check in & close short" for what will never arrive. PO shows "partly received · 40/90 in"; remainder keeps counting as on-order.
- **Paste check-in**: textarea for fulfilment texts ("Klow 80mg - 440 Total") → dry-run preview (which PO, what applies, what stays open, unmatched lines flagged) → one click applies + reports what's left on the PO.
- **Forecast modal**: blended 4/8-week sales rate → next-4w/8w projections → wanted = rate × (cover + lead time); cover default 6w (picker), per-product override via `cover_weeks` (sheet input, shown as "8w*"), lead default 2w; minus stock and on-order → order qty; one click → draft PO.
- **New table columns**: On order (from open POs) and Sold 4w · 8w. Stats endpoint now takes `?windows=` (14/28/42/56/84d) and buckets one order fetch into all windows; fetch limit raised 500→2000.
- **Do not replenish** toggle in the product sheet: excluded from isLow/orderQty/shortfall PDF/forecast, "NO REORDER" chip in the To order column.

### COA tab
- **Send to lab** (`coa/LabOrder.tsx`): expired/no-COA/expiring toggles shown together, per-product checkboxes, lab picker + shipping address (editable, stored on labs), Slack message preview, Copy list, "Push to Slack & mark N at the lab" (skips products already at the lab).
- **Stuck statuses fixed**: FamilyDetail now surfaces queued tests too and "Clear status" cancels queued/sent/in_testing (tracker mark-unsent widened).

### Settings → Team (was "Admins")
- Add members with a **role** (Admin — full access / Viewer — read-only + picks) and **selectable permissions** from a server-driven catalog (`PERMISSION_CATALOG` in admin-auth.ts: realpeptides:coa-upload, pawgen:refund). Edit any member's role/permissions inline (PATCH /api/ops/admins/:email, audit-logged, self/last-admin demotion blocked).

### Plumbing
- COA proxy allowlist + realpeptides:coa-upload grant now cover `/lab-orders` and labs PATCH; proxy stamps `by` on pos + lab-orders too.

Tested E2E locally (scratch pg16 :5499 as tracker DB + ops dev on :5002 with scratch ops_admins): every flow browser-verified, both repos `tsc` + `vite build` clean. **Committed only — NOT pushed, NOT deployed.** Local dev pair left running for Paul to click through (Chrome on this Mac already has a session cookie for localhost:5002).

## 2026-09-01 (later) — Mobile audit pass, whole dashboard

Paul: team will run ops largely from phones; also confirmed the new Justin features must be (and are) plain admin-native — every control gates on `role === "admin"`, the viewer grant is just the extra non-admin path.

Audited all 29 pages + 8 modal surfaces at a true 390×844 viewport (headless puppeteer, scratchpad harness): **zero horizontal overflow anywhere** — the shell (slide-out sidebar, sticky header, p-4→p-8 scale) and table `overflow-x-auto` wrappers from earlier sessions hold up. Three real defects found and fixed:
- Forecast modal table couldn't h-scroll on phones (`overflow-y-auto` → `overflow-auto`; verified 880w content scrolls in 372w container).
- "PO #N" + status chip wrapped mid-label on narrow cards (whitespace-nowrap).
- SkuSheet "Forecast cover" description crushed to one word per line (flex-wrap + min-w).

Harness gotcha worth keeping: a /@vite/client stub MUST implement `updateStyle` to actually inject CSS (a no-op renders the whole app unstyled and the layout viewport explodes) and `createHotContext` needs `prune`/`dispose`.

## 2026-09-01 (deploy) — LIVE on ops.fitscript.me
All three commits deployed via CI. Verified in prod browser: new inventory columns + Forecast with real sales data (80 SKUs matched), Settings → Team with role/permission editor, tracker endpoints through the proxy. Order-sync broke post-deploy — root cause was the TRACKER's 100kb express.json limit (my 500→2000 order-fetch bump pushed the consume payload over it; Express 413s with HTML). Fixed tracker-side (5mb limit) + ops now surfaces non-JSON consume responses with status/text instead of a JSON.parse error. Sync verified healthy: {applied:0, alreadyApplied:500} — idempotency held, no stock double-counts.

## 2026-09-01 (later) — Command Center range picker
Growth Overview gets a Today / 7d / 30d picker (Today = last 24h). Reports endpoints accept days=1 (Klaviyo timeframe "today", Meta date_preset "today"; GA4/RDS date math unchanged). Deployed + verified on prod.
Note: another terminal is active in this checkout (RP Email commits + pnpm files appearing) — I committed only my own files; local `tsc` now shows a pnpm-node_modules TS2742 in google-auth.ts that is environmental (CI builds with npm in Docker, unaffected).

## 2026-09-01 (later) — RP Command Center: Last 24 hours
The RP overview range dropdown gains "Last 24 hours" (labels switch to "· 24H"); server `days()` already accepted 1, site /api/ops-summary honors days=1. Deployed + verified ($41.5k/159 orders in the last 24h at time of check). FitScript Command Center got its own Today/7d/30d picker earlier today.

## 2026-09-02 — Site stock-sync audit (no code change)
Paul suspected the site wasn't reflecting ops inventory — confirmed. Scraped all 70 realpeptides.co product pages (schema.org offers) vs the tracker's public feed: 15/90 variants disagree (8 oversell-risk, 7 blocked-sales; both directions ⇒ stale launch snapshot, feed never wired). Our side is correct and live (feed = direct DB read, 5-min cache). Fix is site-side: gate availability on feed `inStock` keyed by `sku`, ISR 300s. Handed off via the COA API artifact v1.1 (Live stock section + drift table + Next.js recipe) and a pushed SESSION_LOG entry in the real-peptides repo. Audit script: scratchpad stock-compare.

## 2026-09-02 — Josh's tools: team task board + email content calendar

**Tasks** (`/realpeptides/tasks`, nav "Tasks"; server/tasks.ts, ops_tasks auto-created): Monday-style kanban — Inbox/Ready/In progress/Complete/On hold, drag between columns (tap-to-edit on phones), quick-add per column. Cards: priority chip, brand tag (all 4 + other), labels, assignee (roster = ops_admins), due date w/ overdue tint. Filters by brand + owner. Complete stamps completed_at; done cards age out of the board after 30 days.

**Email calendar** (`EmailCalendar` in email-calendar.tsx; server/email-planner.ts, ops_email_plans): month grid mounted at the top of the RP and FitScript Email tabs (per-brand via company prop — mount in other email tabs as they appear). Plans carry copy (subject/preheader), date+time, status (idea→draft→approved→scheduled→sent), from, audience, notes, and pasted HTML design with an inline sandboxed preview (Josh pastes from his design tool). **Resend link is env-gated per brand:** RESEND_API_KEY_<COMPANY> (+ optional RESEND_FROM_<COMPANY>) on ops → audience picker lights up and "Push to Resend" creates the broadcast + schedules it for the slot (date+time ET). Until the key is set, everything but push works and the button explains what's missing.

E2E: API CRUD + graceful no-key push tested locally against prod RDS (tables are new/additive); both UIs headless-verified desktop + 390px. Gotcha fixed: pg DATE columns arrive as full ISO timestamps — slice(0,10) before new Date() or you render "Invalid Date".

TODO for Paul: add RESEND_API_KEY_REALPEPTIDES (RP's key, from the site's env or Resend dashboard) + RESEND_FROM_REALPEPTIDES to prod/ops-secrets to arm the push.

## 2026-09-02 (later) — Resend armed for RP email calendar
prod/ops-secrets + RESEND_API_KEY_REALPEPTIDES + RESEND_FROM_REALPEPTIDES (task def rev 214, Paul executed the SDK script; classifier blocks Claude running it directly). Live key is real-peptides/web/.env.local's (verified via /audiences — 18 RP segments); web/.env's is dead. Verified on prod: resendConnected true, audience picker fills, from prefills "Real Peptides <support@realpeptides.co>". Josh's Push to Resend is live.

## 2026-09-02 (later) — Full physical inventory count applied
Paul's shelf-count CSV (85 rows) applied to the tracker via audited set-counts ("Physical count 2026-09-02"): 79 changed, 4 already right, 0 failures. Corrections en route: Thymulin=105/Thymalin=0 (sheet swap, per Paul), Tesa+Ipa 10/5 was −3 → set 0 (needs recount), Thymulin mapped to RP-THYMU10 (no V in tracker), Bromataine Caps (RP-BRO) created + 244. Ten zero-stock SKUs restored incl. all 8 from the drift audit. Public feed verified 11/11 spot-checks; 8 products remain genuinely out of stock. NOT counted in the CSV (kept old values, worth a follow-up count): 5amino30C(10), ARA16V(37), BAC3V(4340), CAGR5V(22), SERM5V(44), AOD5V(0), DSIP10V(0), RETA24V(0). Site-side live sync still pending the dev team wiring the feed (SESSION_LOG entry + API doc v1.1 already handed off).

## 2026-09-03 — 8 phantom variants removed
Team confirmed zero physical stock for the 8 uncounted sibling-dose SKUs (5amino30C, AOD5V, ARA16V, BAC3V, CAGR5V, DSIP10V, SERM5V, RETA24V). Each zeroed (audited) then soft-deactivated on the tracker; verified gone from the public feed (94→86 products). Site-side variant removal handed to the dev team via real-peptides SESSION_LOG — product PAGES stay (SEO rule), only the dose options go.

## 2026-09-03 — Sync passes order status; holds surface in Inventory
runRpInventorySync: 30-day window (holds stay visible until shipped/refunded; site caps limit at 1000), passes status + windowStart to the tracker consume, logs held/deducted/released. Inventory UI shows "N held" under In stock and in the product sheet; orderQty counts held units against the position (as good as gone).

## 2026-09-03 (later) — Site wired to ops stock (done by us, in the RP repo)
Implemented the storefront side ourselves (Paul's call): stockSync.ts in the site reconciles Variant.stock from the feed's `available`, heartbeated by our own 10-min ops-orders poll; the 8 phantom variants archived in the same stroke. Verified live: Sermorelin 5mg gone from its page, Thymalin OutOfStock (count=0), ARA-290 unbuyable. The whole loop is closed: shelf count / PO check-in / paid-hold / ship-deduct in ops → feed → site in ~15 min.

## 2026-09-03 (Justin's Loom) — PO rounding, draft editing, PDF polish, name-match fixes
Per Justin's videos: (1) order suggestions round UP to the nearest 10 everywhere (To order column, shortfall PO, forecast — boxes come in tens); (2) draft PO lines get inline qty edit + remove in the POs modal; (3) PO PDF: thousand separators + lines/total footer row. Data fixes: RP-BRO → RP-BROM100C "Bromantane - 100mg (100 capsules)" (site SKU + spelling; count sheet had "Bromataine" typo — sales now match AND site stock now syncs), aliases queued for MOT25-NS ("MOTS-c Liquid Spray - 15mg" — site renamed the dose) and Ada10V (site long name). Velocity unmatched list is the audit tool for this class of bug. Justin's WP-sales-history ask: needs Woo creds/export (not on this Mac) — open.

## 2026-09-03 (Josh) — Email calendar syncs BOTH ways with Resend
pullFromResend(company) in email-planner.ts: on calendar load (5-min throttle), broadcasts created directly in Resend (Josh's AI workflow) upsert into ops_email_plans — new ones pull full detail (subject/html/audience/from, created_by 'resend-sync', note "Created in Resend"), linked ones take status + schedule from Resend (it's the truth for anything it knows). 90-day lookback, 200 cap, ET slot conversion. Tested against the live account: found his real Bromantane broadcasts, sent ones on their days.

## 2026-09-04 — Woo sales history backfilled into velocity/forecast
Paul exported 8 weeks of Woo orders (full-field export). Loaded into new ops table `rp_sales_history` (scratchpad load-woo-history.mjs, idempotent by source='woo'): completed/processing only, refund qtys netted, hard cutoff at the 2026-08-24 site launch (site feed owns everything after — no overlap by construction). 12,032 line items → 2,163 daily-aggregate rows, 21,385 units, 07-03→08-23. velocityBySku blends history rows into the same name→matcher buckets as site orders — Sold 4w/8w and the Forecast now run on a continuous two-month demand line. Unmatched names surface in the stats `unmatched` list as usual (alias via skus.coa_name).

## 2026-09-04 (later) — Top sellers graph + durable sales timeline
BAC 3ml confirmed deliberately discontinued (10ml only now) — no action. New: (1) the 10-min order sync also archives site orders into rp_sales_history (source='site', unique (source, order_ref, item_name) — idempotent), making it THE analytics timeline: Woo era by sku_code, site era by name; (2) velocityBySku now reads only that table (SKU_FOLD maps dead Woo codes: MOT15→MOT25, RP-BRO→BROM100C), windows extended to 1/7/30/90/180/365; (3) Top sellers card on the Inventory tab (product view): live units ranking with 24h/Week/Month/6mo/Year picker, CSS bar chart, thumbnails, top 20→50. Year view honest as history accrues; site-era gap 08-24→08-26 is the only known hole (Woo covers to 08-23).

## 2026-09-04 (later) — Weeks-of-cover targets + Settings pinned
Inventory gets a "Stock up for: Manual / 4w / 6w / 8w / 12w" switch (persisted in localStorage): a weeks mode derives every product's target from live velocity (weekly × weeks) and flows through Target, To order (still rounds to 10s), Below-target KPI, Order PDF and shortfall POs; Manual = saved ideal_stock as before. Sidebar: "Settings & Team" pinned to the footer, visible from every company tab (it previously lived only in FitScript's System section — Paul lost it on RP).

## 2026-09-04 (later) — Bromantane reconciliation + unmatched-sales alarm
Bromantane launch (Josh's 09-01 emails) sold 263 in 4 days while the product was still misnamed in ops — order-sync matched nothing, orders got marked processed (idempotent), stock never moved. Post-rename sync works (33 units deducted/held today). Reconciled: stock set 212→3 (audited; 209 missed units), physical recount requested — Paul's "250 received" vs 244 counted + 263 sold doesn't close, shelves are the referee. Guard shipped: Inventory shows a red banner whenever the sync reports unmatched item names ("sales are NOT deducting for: …") — this failure class is loud now. Bundles checked: Woo-era only, no live gap.

## 2026-09-04 (audit) — Full ledger reconciliation vs Weds count
Cross-checked all 86 SKUs: Weds 7pm-ET count + Justin's additions (MM house stock: +730 R10/+220 R20/+150 Tesa, logged 09-03 20:16; PO #3 check-in +250 BAC 20:22) − site sales since. Verdict: ONLY Bromantane truly missed deductions (263 sold during the misname window; reconciled to 3, recount requested). All other SKUs land within noise explained by (a) Weds-evening boundary, (b) refunds/cancellations (history keeps demand rows; ledger correctly never deducts them), (c) paid-not-yet-fulfilled in flight. Audit gotchas fixed en route: stock-log now takes ?limit= (50-row default truncated high-volume SKUs and faked "missing" deductions); ops hold-release window now anchored to the oldest order actually in the fetched batch (feed returns newest-1000, not the full 30d). Holds semantics confirmed for Paul: unpaid/pending checkouts NEVER hold ops stock (feed only carries paid/fulfilled); holds = paid-awaiting-shipment, auto-released on refund. PO #1 is a stale Aug-31 draft (pre-rounding shortfall) — suggest deleting.

## 2026-09-04 (final) — Bromantane presell executed
Per Paul: Bromantane set −13 (true oversold; negative-set shipped for it), stale PO #1 deleted, PO #4 created from the live forecast (6w cover + 2w lead, 27 lines / 3,050 units, rounded to 10s) and marked ORDERED — which opens the presell window. Backorder built end-to-end same stroke: tracker skus.backorder_message → feed sells available = stock − held + inbound-PO and carries the badge → site Variant.backorderNote (migration) → PDP gold note replaces the stock line. Verified live: Bromantane buyable at 384 presell units with "Shipping week of 9/16/2026" on the page. Gotcha: getProductBySlug maps variant fields explicitly — new Variant columns must be added to that mapping or they silently vanish from the PDP.

## 2026-09-04 (evening) — RP Command Center goes live-data (contacts, COA, sitemap)
Paul flagged the RP overview as stale. Diagnosis: (1) Contacts read Campaign Refinery, which froze at the 08-24 relaunch — the new site's Postgres is the CRM and mirrors to Resend; (2) COA tiles read the tracker's per-SKU /api/ops-summary while the COA tab groups families + at-lab/send-to-lab, so numbers never matched; (3) sitemap WAS re-crawled that day (6h cache) but counted every URL twice (site serves legacy WP sitemap names next to /sitemaps/*.xml → 49,788 vs 24,894 distinct) and nothing showed when it was crawled; (4) the Sales card rendered "Not connected yet" while loading.
Shipped (local only, NOT pushed — awaiting Paul's go; needs the site deploy first): site `GET /api/ops-contacts?days=N` (same bearer gate; totals/marketable/buyers/leads/unsubscribed, new today/7d/30d/window, bySource, daily, recent 50 — bulk imports (source='campaign-refinery', landed 08-31) excluded from "new"); ops `server/realpeptides-contacts.ts` → `/api/ops/realpeptides/contacts` (60s cache); Command Center rebuilt: Leads row (contacts + new today/7d/30d), Certificates row = COA tab's `familyCounts` (products, expired, no COA, expiring, fresh, send to lab, at the lab — shared helper in coa/families.ts), sales loading state, tiles poll every 60s, Refresh button forces everything incl. a sitemap re-crawl, "crawled 5:08 PM" on Live URLs, health row per source with as-of times. Leads tab rebuilt on the same feed (stat row, daily bars, by-source, latest 50, CR/Moosend demoted to "pre-launch archive"). pages.ts: URLs keyed by URL (count now = distinct), CACHE_HOURS 6→1, taxonomy regex before product so product_tag/product_cat classify right.
Verified: site endpoint locally (401 unauth, 200 with token, import exclusion works), ops prod build + tsc clean, headless screenshots desktop+390px of both pages against the local site, sitemap refresh from local → 24,894 = 24,894 with the original kind split. COA/Clomark tiles show "!" locally only because those tokens aren't in the local .env.
Next: Paul's go → push real-peptides (CodeBuild) then ops (CI); browser-verify prod tiles match the COA tab and Leads shows real today/7d/30d.

## 2026-09-04 (deploy) — Command Center live feeds shipped
Pushed on Paul's go in order: real-peptides `96c710f` (GH Actions → CodeBuild → ECS; /api/ops-contacts 404→401 at 8:44pm ET), then ops `d46f584`+`3ec4ddc` (Pages tab: 5-min auto-refetch + "Google data through <date>"). Served bundle verified to contain the new code; browser-verified prod: Contacts 58,404 / 145 new today / 1,471 7d (CRM captures began ~08-29 so 7d = 30d for now; offer-capture 58%, account 16%, checkout 16%); Certificates row = COA tab tile-for-tile (65/21/6/13/25/34/0); Live URLs 24,894 "crawled 5:23 PM"; Getting impressions 9,953 (40%) on the 30d window. Sales card now shows a loading state instead of "Not connected yet".

## 2026-09-04 (late) — New leads = marketing captures; New customers tile
Paul: "is new leads new contacts?" → split. Site /api/ops-contacts: `new.*` now excludes checkout, account, webhook, sweep and the CR import (NON_LEAD_SOURCES); adds `newCustomers {today, week, month, window}` = emails whose FIRST real PAID/FULFILLED order (same filter as ops-summary) landed in the window. Ops: Command Center Leads row gets a 5th tile "New customers" (today · 7d · 30d), Leads tab stat row + chart/source/latest relabelled to marketing captures. Pushed site `068c86e` then ops `9cc54f6` on Paul's go; served bundle grep-verified; browser-verified: 120 new leads today / 993 7d (offer-capture 86%, playbook 10%), 70 new customers today / 886 7d = 30d. That 7d=30d equality is real: realOrdersWhere's launch cutoff means paid-order history starts 08-29, so every customer so far is first-time and matches the sales tile's 886 customers by construction — diverges from 09-05.

## 2026-09-05 — Orders tab un-truncated + 24h; Inventory audit feed + auto product images
Paul: Orders stats stale/no 24h. Justin: images missing in Inventory, "no record" of a manual +250. Root causes: (1) site /api/ops-orders returns newest-first capped at 500 → 30d (960+ orders) tiles/totals built from half the data; (2) inventory_log already recorded who/what but was hidden behind a per-row clock icon and quick +/- wrote no note; (3) tracker images only existed when hand-uploaded.
Shipped (deploy order tracker → site → ops, all on Paul's go, prod-verified 8:10pm ET): tracker `GET /api/stock-log?limit=` (global feed, joined names); site `ops-orders` gains `before=` cursor + new `GET /api/ops-catalog` (variant sku → storefront image); ops orders pages until a short page (60s cache, MAX 40 pages), ranges 24h/7d/30d/90d, 60s refetch, as-of; Inventory "Recent stock moves" panel (product · delta → new · reason · by user; site-sync rows read "website order"), quick +/- log "manual add"/"manual remove"; `server/realpeptides-images.ts` fills product_image docs from the site catalog 30s after boot + every 6h, plus "Fill N missing images" button; PROXY_ALLOW += /stock-log.
Prod: Orders 30d now 1,063 orders / $249,821 (was capped at 500). Recent moves shows Justin's +250 BAC (Sep 5 6:17pm, by justin@justinillig.com). Image sync first run: 9 uploaded, 2 have no photo on the site (5-Amino 60MG Tablets, Tesa+Ipa 12/3 blend) — someone needs to add those on the site or upload by hand.
