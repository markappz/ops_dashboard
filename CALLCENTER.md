# Real Peptides Call Center — Operating Runbook

Built 2026-10-06. The communication/follow-up layer over the existing Retell agents
(workspace org_yRJt1t51djc6EJ2C), living inside ops at `/realpeptides/call-center`.

## What's live in the code
- **Webhook ingestion** — `POST /api/integrations/retell/webhook` (public, raw-body
  HMAC via the retell-sdk verifier, agent allowlist). Durable inbox
  (`cc_webhook_inbox`) → worker loop (10s) with retries/backoff → dead-letter +
  replay UI. Handles call/chat started/ended/analyzed, transcript updates,
  transfers, duplicates, out-of-order and end-without-start.
- **Live agent tools** — `POST /api/integrations/retell/tools/:tool`, same signature
  verification + per-agent server-side capability allowlist
  (`AGENT_CAPABILITIES` in `server/callcenter-tools.ts`): search-products,
  get-product, get-coa, start-order-verification, verify-order-access,
  get-order-status, create-followup, create-wholesale-inquiry,
  get-handoff-options (+ send-requested-resource, intentionally not granted to
  any agent until an approved channel exists). Writes are idempotent — a retry
  returns the original receipt.
- **Data** — `server/callcenter-schema.sql` (cc_conversations, cc_contacts,
  cc_requests, cc_wholesale_inquiries, cc_webhook_inbox, cc_tool_calls,
  cc_verifications, cc_call_attempts, cc_events, cc_sync_state, cc_config_audit),
  auto-created at boot. All UTC; staff UI shows ET.
- **Catalog authority** — the storefront's public `/api/search` (live price/stock,
  "bromatane"→Bromantane matching, letter-spelling collapse). Orders/wholesale via
  the site's token-gated `/api/ops-orders` / `/api/ops-wholesale` feeds.
- **UI** — Overview, Conversations (+detail: summary-first, transcript, recording,
  tool history, timeline, test-flag), Follow-ups (my/unassigned/due/overdue/
  awaiting/resolved; assign/schedule/snooze-with-reason/notes/outcomes; call
  attempts never auto-close), Wholesale requests, Settings & health (capability
  truth, dead-letter replay, reconcile/backfill, approved transfer destinations).
- **RBAC** — viewers read-only; `realpeptides:call-center` grant (Settings → Team)
  unlocks queue work only. Webhook/tool routes are signature-auth, not session.
- **Tests** — `npm test` (vitest; needs `createdb ops_callcenter_dev`): signature
  valid/invalid/replay, inbox dedupe + out-of-order, analysis-vs-staff-edit,
  live-tool suppression, dead-letter, tool allowlist, idempotent receipts,
  verification gating + rate limit, product matching. 21 tests, all mocked
  externally — nothing dials or messages customers.

## Enablement checklist (in order)
1. **Deploy**: add `RETELL_API_KEY` (+ optional `RETELL_WEBHOOK_API_KEY`,
   `RETELL_TOOL_AUTH_SECRET`) and `OPS_PUBLIC_BASE_URL=https://ops.fitscript.me`
   to `prod/ops-secrets` AND the task definition's `secrets` list (a key in the
   JSON alone is NOT injected). Push → ECS deploy → verify
   `/api/ops/realpeptides/callcenter/health` shows retell configured.
2. **Wire Retell** (after the webhook URL is live):
   `npx tsx scripts/retell-sync.ts diff` → review → `apply`.
   Draft-only, reversible: it merges `ops_cc_*` tools into each LLM (end_call/
   agent_swap untouched), writes the marked prompt block, sets agent webhook_urls,
   snapshots before/after into `scripts/retell-snapshots/` (gitignored).
   Rollback: `npx tsx scripts/retell-sync.ts rollback <pre-apply dir>`.
3. **Test calls**: Retell dashboard test-call each agent; confirm conversations,
   tool receipts and follow-ups land in ops. Flag them as test sessions.
4. **Backfill**: Settings → "Backfill history" (resumable) imports existing Retell
   calls/chats. Google Voice history is NOT imported (separate project if ever).
5. **Publish + phone** (Paul decisions, never automated): publish agent versions,
   point phone routing at published versions, port/purchase the number in Retell.
   Zero numbers are attached today — +18133300290 still rings Google Voice.

## Order-verification email (2FA) — wired 2026-10-06 (Josh's handoff)
**Architecture**: ops generates + stores the challenge; the RP site sends it.
- Challenge store: `cc_verifications` — keyed HMAC-SHA256 verifier
  (`CC_VERIFY_HASH_SECRET`, falls back to `OPS_SESSION_SECRET`), 10-min expiry,
  single-use atomic consumption, superseded-on-reissue, 60s resend cooldown,
  ≤3 sends/hour per order AND per recipient (HMAC'd keys, no plaintext),
  ≤5 wrong attempts per challenge, delivery_status + provider_message_id.
- Delivery: `POST {RP site}/api/ops-transactional` (route in the real-peptides
  repo, `src/app/api/ops-transactional/route.ts`), standard `authoriseOps`
  bearer. Ops defaults the endpoint from `RP_SITE_API_URL` +
  `RP_SITE_OPS_TOKEN` — **no new secrets**; `CC_VERIFY_WEBHOOK_URL/TOKEN`
  override if ever needed. Contract: `{ping:true}` → `{ok,pong}` health probe;
  `{kind:"order-verification", to, code, expiresInMinutes, idempotencyKey}` →
  `{ok, status:"accepted", messageId}`. Idempotency is owned by ops (one send
  per challenge row; tool retries return the stored receipt).
- Template: sender `sendOrderVerificationCodeEmail` in the RP repo's
  `lib/server/email.ts`, alias `order-verification-code` — editable in the ops
  email editor via EmailOverride, listed in the site-email catalog (Account
  group) with a preview sample. From `RESEND_FROM_EMAIL`, reply-to
  support@realpeptides.co, no unsubscribe footer (transactional), code never
  in the subject. HTML only — the Mailgun transport has no text part and the
  transport files were frozen by in-flight SES work; documented deviation.
- Honesty: identical generic reply whether the order exists or not (no
  enumeration, no masked-recipient hint to callers); "accepted" means provider
  acceptance, not inbox receipt — the agent wording says "may take a moment",
  and Settings & health separates configured / reachable (ping) / last send /
  last confirmed delivery (stays null: the engine doesn't store delivered
  events; inbox receipt is checked manually in the E2E).
- Failure paths: provider failure → agent says it couldn't send and offers a
  saved follow-up; locked/expired codes → callback path; access failures never
  fall through to an unverified lookup (tested).
- Rollback: revert the ops commit (verification returns to honest
  unavailable); the site route is additive and inert if unused.
- E2E check (after both deploys): call Grace's support line/chat, give an
  isolated staff test order (e.g. Josh's order 112), confirm the code lands in
  that inbox, read it back, get order status. Flag the session as a test.

## Still disconnected (honest states, shown in Settings & health)
- **Two-way SMS** — needs a Retell-connected messaging number (Google Voice does
  not forward SMS). UI shows SMS unavailable until configured AND tested.
- **Staff browser dialer** — needs a telephony provider (Twilio Voice JS SDK
  pattern documented in the prompt). Until then Call buttons are a labeled tel:
  fallback with manual outcome logging (attempted/no_answer/voicemail/connected/
  failed in `cc_call_attempts`).
- **send-requested-resource** — exists but granted to no agent until an approved
  SMS/email channel is connected.
- **Hades** — no such workflow exists in any repo; checkout-recovery analysis
  routes to the `sales_recovery` queue for his owner instead. If/when a Hades
  automation ships, integrate at `routeAnalysis()` in `server/callcenter-worker.ts`.

## Notes & guardrails encoded
- Commercial focus: product, price, quantity, issue. No prices/stock quoted except
  from the live tool; wholesale quotes are always human-reviewed; agents never mark
  orders paid/approved/shipped and never touch rep attribution or commissions.
- A caller matching an existing wholesale quote links to it (never re-entered as a
  new lead). Rep ownership is read-only here.
- Analysis is evidence: it never reopens staff-resolved requests, never duplicates
  a live-tool save, and wrong_brand creates no lead. Ambiguous callback times stay
  `needs_scheduling` with the customer's words — no invented deadlines.
- Retention: optional `CC_RETENTION_DAYS` (≥30) scrubs transcripts/recordings/
  analysis + inbox payloads on a 6h loop. Retell-side retention is separate and
  its everything_except_pii setting is NOT assumed to scrub.
- Metrics exclude flagged test sessions; avg daily calls states its exact
  numerator/denominator/timezone in the API payload and UI.
