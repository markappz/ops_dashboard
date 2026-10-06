/**
 * Retell custom-function endpoints — the live half of the integration.
 * PUBLIC routes (registered before express.json), verified per request:
 *   1. X-Retell-Signature over the exact raw body (same scheme as webhooks);
 *   2. optional shared header x-ops-tool-auth = RETELL_TOOL_AUTH_SECRET;
 *   3. the agent in the provider envelope must be on the server-side
 *      capability allowlist for the tool — tool descriptions in prompts are
 *      NOT the access control, this map is.
 *
 * Narrow by design: no SQL, no admin routes, no URL fetching, no mutations
 * beyond create-followup / create-wholesale-inquiry / verification, all
 * idempotent. Responses use shared statuses (ok | not_found | ambiguous |
 * verification_required | unavailable | rejected) with a short
 * customer_message and minimal data.
 */
import express, { type Express, type Request, type Response } from "express";
import { createHash, randomInt, timingSafeEqual } from "crypto";
import type { Pool } from "pg";
import { verifyRetellSignature, retellCfg, RP_VOICE_AGENTS, RP_CHAT_AGENTS } from "./callcenter-retell";
import {
  createRequest, logCcEvent, suggestContact, toolReceipt, getSyncState,
  normalizePhone, normalizeEmail, digestOf,
} from "./callcenter-db";
import { searchProducts, getProductById, findOrder, findWholesaleMatch } from "./callcenter-commerce";
import { upsertConversation } from "./callcenter-worker";

type ToolName =
  | "search-products" | "get-product" | "get-coa"
  | "start-order-verification" | "verify-order-access" | "get-order-status"
  | "create-followup" | "create-wholesale-inquiry"
  | "send-requested-resource" | "get-handoff-options";

const LOOKUP_TOOLS: ToolName[] = ["search-products", "get-product", "get-coa", "get-handoff-options"];
const FD = [...LOOKUP_TOOLS, "create-followup"] as ToolName[];
const SUPPORT = [...FD, "start-order-verification", "verify-order-access", "get-order-status"] as ToolName[];
const WHOLESALE = [...FD, "create-wholesale-inquiry"] as ToolName[];
const EDUCATION = FD;
const CHAT_DESK = [...new Set([...SUPPORT, ...WHOLESALE])] as ToolName[];

/** Server-side allowlist: agent id → tools it may call (prompt §7). */
export const AGENT_CAPABILITIES: Record<string, ToolName[]> = {
  agent_067b4ec911fad52c81d22a0535: FD,        // Front desk — Marissa (voice)
  agent_aa811252242b2dca1907ff78ea: SUPPORT,   // Support — Grace (voice)
  agent_dbff7019c07d8782878ec50373: WHOLESALE, // Wholesale — Sloane (voice)
  agent_934983123a41ba27f58830f6df: EDUCATION, // Education — Sloane (voice)
  agent_63e95e33b57ce9105b3e1c9264: CHAT_DESK, // Central chat desk — Marissa
  agent_68c03ff37ba998b8614c589575: SUPPORT,   // Support chat — Grace
  agent_4a61971caaad5b15a227645157: WHOLESALE, // Wholesale chat — Sloane
  agent_0bc0cf30289731847b7c9e6655: EDUCATION, // Education chat — Sloane
};

interface ToolContext {
  conversationExternalId: string | null;
  conversationId: number | null;
  agentId: string | null;
  channel: "voice" | "chat";
  fromNumber: string | null;
  args: Record<string, any>;
}

interface ToolResult {
  status: "ok" | "not_found" | "ambiguous" | "verification_required" | "unavailable" | "rejected" | "error";
  customer_message: string;
  data?: unknown;
  receipt_id?: string | number;
}

const str = (v: unknown, max = 400): string => String(v ?? "").trim().slice(0, max);

function parseEnvelope(body: any): { entity: any; args: Record<string, any>; channel: "voice" | "chat" } {
  // Voice custom functions use {name, call, args} (args_at_root false). Chat
  // payloads are inspected rather than assumed: accept {name, chat, args},
  // and fall back to treating the body as bare args with no provider context.
  if (body && typeof body === "object" && ("args" in body || "call" in body || "chat" in body)) {
    const entity = body.call ?? body.chat ?? null;
    return { entity, args: body.args ?? {}, channel: body.chat ? "chat" : "voice" };
  }
  return { entity: null, args: body ?? {}, channel: "voice" };
}

/* ------------------------------------------------------------------ */
/* Tool implementations                                                */
/* ------------------------------------------------------------------ */

const MAX_VARIANTS = 8;

function publicVariant(v: any) {
  const sold_out = v.stock !== null && v.stock <= 0;
  return {
    variant_id: v.variantId, sku: v.sku, option: v.label,
    price_usd: v.price, currency: "USD",
    on_sale: v.discountName ? { was: v.listPrice, promo: v.discountName } : null,
    availability: sold_out ? "sold_out" : "in_stock",
  };
}

function publicProduct(p: any) {
  return {
    product_id: p.productId, name: p.name, url: p.url, coa_page: p.coaUrl,
    options: p.variants.slice(0, MAX_VARIANTS).map(publicVariant),
    checked_at: p.checkedAt, source: "realpeptides.co live catalog",
  };
}

async function toolSearchProducts(pool: Pool, ctx: ToolContext): Promise<ToolResult> {
  const query = str(ctx.args.query ?? ctx.args.product ?? ctx.args.name, 120);
  if (!query) return { status: "rejected", customer_message: "What product should I look up?" };
  const out = await searchProducts(query);
  if (out.status === "unavailable") {
    return { status: "unavailable", customer_message: "I can't check the live catalog right now. I can save your question for the team instead." };
  }
  if (out.status === "not_found") {
    return { status: "not_found", customer_message: `I don't see "${query}" in our catalog. It may go by another name — want me to note it for the team?` };
  }
  const data = { products: out.products.slice(0, 5).map(publicProduct), corrected_query: out.correctedQuery ?? null };
  if (out.status === "ambiguous") {
    return { status: "ambiguous", customer_message: "A few products match — which one do you mean?", data };
  }
  return { status: "ok", customer_message: "Found it.", data };
}

async function toolGetProduct(pool: Pool, ctx: ToolContext): Promise<ToolResult> {
  const id = str(ctx.args.product_id ?? ctx.args.variant_id, 80);
  if (!id) return { status: "rejected", customer_message: "I need the product from the search first." };
  let p = await getProductById(id);
  if (!p) {
    const name = str(ctx.args.name, 120);
    if (name) {
      const s = await searchProducts(name);
      p = s.products.find((x) => x.productId === id || x.variants.some((v) => v.variantId === id)) ?? s.products[0] ?? null;
    }
  }
  if (!p) return { status: "not_found", customer_message: "I couldn't pull that product up — let's search for it again by name." };
  return { status: "ok", customer_message: "Here are the details.", data: publicProduct(p) };
}

async function toolGetCoa(pool: Pool, ctx: ToolContext): Promise<ToolResult> {
  const name = str(ctx.args.product ?? ctx.args.query ?? ctx.args.name, 120);
  const lot = str(ctx.args.lot, 60) || null;
  if (!name) return { status: "rejected", customer_message: "Which product's report do you need?" };
  const s = await searchProducts(name);
  if (s.status === "unavailable") return { status: "unavailable", customer_message: "I can't check that right now." };
  if (!s.products.length) return { status: "not_found", customer_message: `I don't see "${name}" in the catalog.` };
  const p = s.products[0];
  return {
    status: "ok",
    customer_message: `Testing reports for ${p.name} are on our COA page.`,
    data: {
      product: p.name, coa_page: p.coaUrl, product_page: p.url,
      lot_match: lot ? "unknown — lot-level matching needs the team to confirm which report covers your lot" : null,
      note: "The newest public report does not prove which lot shipped in a specific order.",
    },
  };
}

/* ---- order verification + status ---- */

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

async function toolStartOrderVerification(pool: Pool, ctx: ToolContext): Promise<ToolResult> {
  const orderRef = str(ctx.args.order_reference ?? ctx.args.order, 60);
  if (!ctx.conversationExternalId) return { status: "rejected", customer_message: "I can't verify from this channel." };
  if (!orderRef) return { status: "rejected", customer_message: "What's the order number?" };

  const started = await pool.query(
    `SELECT COUNT(*)::int AS n FROM cc_verifications WHERE conversation_external_id = $1`,
    [ctx.conversationExternalId],
  );
  if (started.rows[0].n >= 3) {
    return { status: "rejected", customer_message: "We've hit the verification limit for this call. The team can help on a callback." };
  }

  // The challenge goes ONLY to the contact already on the order — never to a
  // destination the caller supplies. No connected transactional channel yet →
  // honest unavailable + human fallback (never fabricated verification).
  let onFile: string | null = null;
  try {
    const lookup = await findOrder(orderRef);
    onFile = lookup.found ? lookup.order?.email ?? null : null;
  } catch {
    return { status: "unavailable", customer_message: "I can't reach the order system right now. I can have the team call you back instead." };
  }

  const code = String(randomInt(100000, 999999));
  const masked = onFile ? onFile.replace(/^(.).*(@.).*(\..+)$/, "$1***$2***$3") : null;
  await pool.query(
    `INSERT INTO cc_verifications (conversation_external_id, order_reference, purpose, channel, destination_masked, code_hash, expires_at)
     VALUES ($1, $2, 'order_status', 'email', $3, $4, NOW() + interval '10 minutes')`,
    [ctx.conversationExternalId, orderRef, masked, hashCode(code)],
  );

  const sent = await sendVerificationChallenge(onFile, code);
  if (!sent) {
    // Row exists for audit; without a delivery channel the flow stops here.
    // Deliberately the same message whether or not the order exists.
    return {
      status: "unavailable",
      customer_message: "I can't send verification codes from this line yet, so I can't open order details here. I can save a request and the team will follow up using the contact on the order.",
    };
  }
  return {
    status: "ok",
    customer_message: "If that order exists, a 6-digit code was just sent to the contact on file. Read it back when you have it.",
    data: { destination_hint: masked },
  };
}

/** Delivery adapter. No approved transactional channel is connected yet, so
 *  this reports failure honestly. Wire CC_VERIFY_WEBHOOK_URL to the RP email
 *  engine's transactional endpoint when it ships (never a new ESP from here). */
async function sendVerificationChallenge(destination: string | null, code: string): Promise<boolean> {
  const hook = process.env.CC_VERIFY_WEBHOOK_URL;
  const token = process.env.CC_VERIFY_WEBHOOK_TOKEN;
  if (!hook || !token || !destination) return false;
  try {
    const r = await fetch(hook, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: destination, template: "cc-verification", code }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function toolVerifyOrderAccess(pool: Pool, ctx: ToolContext): Promise<ToolResult> {
  const code = str(ctx.args.code, 12).replace(/\D/g, "");
  if (!ctx.conversationExternalId || !code) return { status: "rejected", customer_message: "Read me the 6-digit code when you have it." };
  const row = (await pool.query(
    `SELECT * FROM cc_verifications
      WHERE conversation_external_id = $1 AND verified_at IS NULL AND expires_at > NOW()
      ORDER BY id DESC LIMIT 1`,
    [ctx.conversationExternalId],
  )).rows[0];
  if (!row) return { status: "rejected", customer_message: "There's no active code for this call — we'd need to start again." };
  if (row.attempts >= row.max_attempts) return { status: "rejected", customer_message: "Too many tries on that code. The team can help on a callback." };
  await pool.query(`UPDATE cc_verifications SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
  const a = Buffer.from(hashCode(code));
  const b = Buffer.from(String(row.code_hash));
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { status: "rejected", customer_message: "That code doesn't match." };
  }
  await pool.query(`UPDATE cc_verifications SET verified_at = NOW() WHERE id = $1`, [row.id]);
  return { status: "ok", customer_message: "You're verified for this call.", data: { order_reference: row.order_reference } };
}

async function toolGetOrderStatus(pool: Pool, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.conversationExternalId) return { status: "rejected", customer_message: "I can't open orders from this channel." };
  const grant = (await pool.query(
    `SELECT order_reference FROM cc_verifications
      WHERE conversation_external_id = $1 AND verified_at IS NOT NULL AND expires_at > NOW() - interval '30 minutes'
      ORDER BY verified_at DESC LIMIT 1`,
    [ctx.conversationExternalId],
  )).rows[0];
  if (!grant) {
    return { status: "verification_required", customer_message: "I need to verify the order first — it only takes a moment." };
  }
  let lookup;
  try {
    lookup = await findOrder(grant.order_reference);
  } catch {
    return { status: "unavailable", customer_message: "The order system isn't answering right now. Want a callback once we've checked it?" };
  }
  if (!lookup.found || !lookup.order) return { status: "not_found", customer_message: "I can't find that order in the system — the team will need to dig in." };
  const o = lookup.order;
  // Minimal permitted fields only. A label/tracking number is not proof of
  // carrier pickup — the status wording keeps those states distinct.
  return {
    status: "ok",
    customer_message: "Here's where the order stands.",
    data: {
      reference: o.reference, placed_at: o.createdAt, status: o.status,
      items: o.items.slice(0, 20),
      tracking: o.trackingNumber ? { number: o.trackingNumber, carrier: o.trackingCarrier, note: "A created label means it's queued to ship — the carrier's first scan confirms pickup." } : null,
    },
  };
}

/* ---- writes ---- */

async function ensureConversation(pool: Pool, ctx: ToolContext, entity: any): Promise<number | null> {
  if (ctx.conversationId) return ctx.conversationId;
  if (!entity || !(entity.call_id || entity.chat_id)) return null;
  return upsertConversation(pool, entity, { channel: ctx.channel, eventType: "tool" });
}

async function toolCreateFollowup(pool: Pool, ctx: ToolContext, entity: any): Promise<ToolResult> {
  const concern = str(ctx.args.concern ?? ctx.args.summary, 1000);
  if (!concern) return { status: "rejected", customer_message: "Tell me what the team should help with." };
  const reason = str(ctx.args.issue_type ?? ctx.args.reason, 60) || "callback";
  const phone = normalizePhone(str(ctx.args.phone, 40)) ?? normalizePhone(ctx.fromNumber);
  const email = normalizeEmail(str(ctx.args.email, 120));
  const permission = ctx.args.contact_permission === undefined ? null : !!ctx.args.contact_permission;
  if (permission === false) {
    // An explicitly declined contact request is respected: log, don't schedule.
    return { status: "rejected", customer_message: "Understood — we won't reach out. The note stays on file if you call back." };
  }
  const windowRaw = str(ctx.args.preferred_window ?? ctx.args.callback_window, 200) || null;
  const tz = str(ctx.args.timezone, 60) || null;

  const conversationId = await ensureConversation(pool, ctx, entity);
  const idempotencyKey = `cf:${ctx.conversationExternalId ?? "x"}:${digestOf({ concern, reason, phone, email, windowRaw })}`;
  const contactId = await suggestContact(pool, { phone, email, name: str(ctx.args.name, 120) || null, businessName: str(ctx.args.business_name, 160) || null });
  const { id, created } = await createRequest(pool, {
    conversationId, contactId,
    kind: "support", reason,
    concern,
    productRefs: ctx.args.product ? [{ name: str(ctx.args.product, 160), qty: Number(ctx.args.quantity) || null }] : [],
    orderReference: str(ctx.args.order_reference, 60) || null,
    priority: /urgent|asap/i.test(str(ctx.args.urgency, 40)) ? "high" : "normal",
    contactPermission: permission,
    contactChannel: str(ctx.args.contact_channel, 20) || (phone ? "phone" : email ? "email" : null),
    callbackWindowRaw: windowRaw,
    // Never invent a deadline from ambiguous wording: no tz/time → needs_scheduling.
    needsScheduling: !!windowRaw && !tz,
    callbackTz: tz,
    source: "live_tool",
    idempotencyKey,
  });
  return {
    status: "ok",
    receipt_id: id,
    customer_message: created
      ? "I've saved your request — the team will follow up."
      : "That request is already saved — you're covered.",
    data: { request_id: id, state: "new", note: "A callback request is a queue entry, not a guaranteed appointment time." },
  };
}

async function toolCreateWholesaleInquiry(pool: Pool, ctx: ToolContext, entity: any): Promise<ToolResult> {
  const business = str(ctx.args.business_name, 160);
  const items = Array.isArray(ctx.args.items) ? ctx.args.items.slice(0, 30) : [];
  const phone = normalizePhone(str(ctx.args.phone, 40)) ?? normalizePhone(ctx.fromNumber);
  const email = normalizeEmail(str(ctx.args.email, 120));
  if (!business && !email && !phone) return { status: "rejected", customer_message: "I need the business name or a way to reach you to save this." };

  // Existing quote? Link it — never re-enter a known partner as a new lead.
  let existing = null;
  try { existing = await findWholesaleMatch({ phone, email, business }); } catch { /* feed down — proceed as new */ }

  const conversationId = await ensureConversation(pool, ctx, entity);
  const contactId = await suggestContact(pool, { phone, email, name: str(ctx.args.contact_name, 120) || null, businessName: business || null });
  const lines = items.map((i: any) => ({
    product: str(i.product ?? i.name, 160), variant: str(i.variant ?? i.option, 120) || null,
    qty: Number(i.qty ?? i.quantity) || null, notes: str(i.notes, 200) || null,
  })).filter((l: any) => l.product);
  const idempotencyKey = `wi:${ctx.conversationExternalId ?? "x"}:${digestOf({ business, email, phone, lines })}`;

  const { id, created } = await createRequest(pool, {
    conversationId, contactId,
    kind: "wholesale", queue: "wholesale",
    reason: existing ? "quote_question" : "needs_quote",
    concern: str(ctx.args.summary, 1000) || `Wholesale inquiry from ${business || email || phone}`,
    productRefs: lines,
    wholesaleRefs: existing ? { orderRef: existing.ref, status: existing.status, existing: true } : {},
    contactPermission: true,
    contactChannel: phone ? "phone" : "email",
    callbackWindowRaw: str(ctx.args.timing, 200) || null,
    source: "live_tool",
    idempotencyKey,
  });
  if (created) {
    await pool.query(
      `INSERT INTO cc_wholesale_inquiries (request_id, business_name, contact_name, contact_phone, contact_email, lines, labeling, timing, stage, quote_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, business || null, str(ctx.args.contact_name, 120) || null, phone, email,
       JSON.stringify(lines), JSON.stringify({ label_needs: str(ctx.args.labeling, 300) || null }),
       str(ctx.args.timing, 200) || null, existing ? "draft_quote" : "inquiry", existing?.ref ?? null],
    );
  }
  return {
    status: "ok",
    receipt_id: id,
    customer_message: created
      ? (existing ? "You're already set up with us — I've flagged your question on the existing quote and the team will follow up." : "I've saved your wholesale request — our team will review it and reach out with a quote.")
      : "That request is already saved.",
    data: { request_id: id, review: "human_quote_review", existing_quote: existing?.ref ?? null },
  };
}

async function toolSendRequestedResource(): Promise<ToolResult> {
  // No approved outbound SMS/email channel is connected to ops yet. Honest
  // unavailable — never a fake "sent". (Settings/health shows this state.)
  return { status: "unavailable", customer_message: "I can't text or email links from this line yet. Everything is on realpeptides.co, or the team can send it when they follow up." };
}

async function toolGetHandoffOptions(pool: Pool): Promise<ToolResult> {
  const dests = ((await getSyncState(pool, "handoff_destinations")) ?? []) as any[];
  const open = dests.filter((d) => d && d.enabled);
  if (!open.length) {
    return { status: "unavailable", customer_message: "No one is free to take a live transfer right now — I can save a callback request instead.", data: { destinations: [] } };
  }
  return {
    status: "ok", customer_message: "I can connect you.",
    data: { destinations: open.map((d) => ({ key: d.key, label: d.label, hours: d.hours ?? null })) },
  };
}

/* ------------------------------------------------------------------ */
/* Route registration                                                  */
/* ------------------------------------------------------------------ */

const WRITE_TOOLS = new Set<ToolName>(["create-followup", "create-wholesale-inquiry"]);

export function registerCallCenterTools(app: Express, pool: Pool) {
  app.post(
    "/api/integrations/retell/tools/:tool",
    express.raw({ type: "*/*", limit: "1mb" }),
    async (req: Request, res: Response) => {
      const tool = String(req.params.tool) as ToolName;
      try {
        if (!retellCfg()) return res.status(503).json({ status: "unavailable", customer_message: "Tools are offline." });
        const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : "";

        const sigOk = await verifyRetellSignature(rawBody, req.headers["x-retell-signature"] as string | undefined);
        const secret = process.env.RETELL_TOOL_AUTH_SECRET;
        const secretOk = !secret || req.headers["x-ops-tool-auth"] === secret;
        if (!sigOk || !secretOk) return res.status(401).json({ status: "rejected", customer_message: "Unauthorized." });

        let body: any;
        try { body = JSON.parse(rawBody || "{}"); } catch { return res.status(400).json({ status: "rejected", customer_message: "Bad request." }); }
        const { entity, args, channel } = parseEnvelope(body);
        const agentId = entity?.agent_id ? String(entity.agent_id) : null;

        // Capability check against the SIGNED envelope's agent — model args
        // can never widen access (and an unknown agent gets nothing).
        const allowed = agentId ? AGENT_CAPABILITIES[agentId] ?? [] : [];
        if (!agentId || !allowed.includes(tool)) {
          console.warn(`[OPS][CC] tool ${tool} denied for agent ${agentId ?? "(none)"}`);
          return res.status(403).json({ status: "rejected", customer_message: "That isn't available on this line." });
        }

        const ctx: ToolContext = {
          conversationExternalId: entity?.call_id ?? entity?.chat_id ?? null,
          conversationId: null,
          agentId,
          channel,
          fromNumber: entity?.from_number ?? null,
          args: typeof args === "object" && args ? args : {},
        };

        // Idempotent writes: a provider retry after our commit returns the
        // original receipt rather than creating another task.
        if (WRITE_TOOLS.has(tool)) {
          const idemKey = `${ctx.conversationExternalId ?? "x"}:${digestOf(ctx.args)}`;
          const receipt = await toolReceipt(pool, {
            conversationExternalId: ctx.conversationExternalId, agentId, tool, idempotencyKey: idemKey, args: ctx.args,
          });
          if (receipt.existing) {
            const prev = receipt.existing.response;
            if (prev) return res.json(prev);
            return res.json({ status: "ok", customer_message: "That request is already being saved." });
          }
          const result = tool === "create-followup"
            ? await toolCreateFollowup(pool, ctx, entity)
            : await toolCreateWholesaleInquiry(pool, ctx, entity);
          await receipt.record(result, result.status === "ok" ? "ok" : "error");
          return res.json(result);
        }

        let result: ToolResult;
        switch (tool) {
          case "search-products": result = await toolSearchProducts(pool, ctx); break;
          case "get-product": result = await toolGetProduct(pool, ctx); break;
          case "get-coa": result = await toolGetCoa(pool, ctx); break;
          case "start-order-verification": result = await toolStartOrderVerification(pool, ctx); break;
          case "verify-order-access": result = await toolVerifyOrderAccess(pool, ctx); break;
          case "get-order-status": result = await toolGetOrderStatus(pool, ctx); break;
          case "send-requested-resource": result = await toolSendRequestedResource(); break;
          case "get-handoff-options": result = await toolGetHandoffOptions(pool); break;
          default: return res.status(404).json({ status: "rejected", customer_message: "Unknown tool." });
        }
        res.json(result);
      } catch (e: any) {
        console.error(`[OPS][CC] tool ${tool} error:`, e.message);
        res.status(200).json({ status: "error", customer_message: "That check didn't go through — I can save it for the team instead." });
      }
    },
  );
}
