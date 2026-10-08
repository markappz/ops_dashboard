/**
 * Retell webhook receiver — PUBLIC route, verified by X-Retell-Signature over
 * the exact raw body. MUST be registered BEFORE app.use(express.json()) in
 * index.ts: the global JSON parser consumes the body stream and raw-body HMAC
 * verification becomes impossible after it.
 *
 * Accept-fast contract: verify → durably insert into cc_webhook_inbox → 204.
 * All real work happens in the worker loop (Retell's webhook timeout is 10s
 * with 3 retries; our own retries/dead-letter live on the inbox rows).
 */
import express, { type Express } from "express";
import type { Pool } from "pg";
import { acceptWebhookEvent } from "./callcenter-db";
import { verifyRetellSignature, retellCfg, knownAgentIds } from "./callcenter-retell";

const KNOWN_EVENTS = new Set([
  "call_started", "call_ended", "call_analyzed", "transcript_updated",
  "transfer_started", "transfer_bridged", "transfer_cancelled", "transfer_ended",
  "chat_started", "chat_ended", "chat_analyzed",
]);

export function registerCallCenterWebhook(app: Express, pool: Pool) {
  app.post(
    "/api/integrations/retell/webhook",
    express.raw({ type: "*/*", limit: "5mb" }),
    async (req, res) => {
      try {
        if (!retellCfg()) return res.status(503).json({ error: "Retell not configured" });
        const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : "";
        const ok = await verifyRetellSignature(rawBody, req.headers["x-retell-signature"] as string | undefined);
        if (!ok) return res.status(401).json({ error: "Invalid signature" });

        let payload: any;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return res.status(400).json({ error: "Invalid JSON" });
        }
        const eventType = String(payload?.event ?? "");
        if (!KNOWN_EVENTS.has(eventType)) {
          // Unknown-but-signed events are accepted into the inbox for review
          // rather than dropped — schema may evolve ahead of this code.
          console.warn(`[OPS][CC] webhook unknown event type: ${eventType || "(none)"}`);
        }
        const entity = payload?.call ?? payload?.chat ?? {};
        const externalId = entity.call_id ?? entity.chat_id ?? null;
        const agentId = entity.agent_id ?? null;
        if (agentId && !knownAgentIds().has(String(agentId))) {
          // Signed, but not one of our RP agents — never write another
          // workspace's traffic into the RP call center.
          console.warn(`[OPS][CC] webhook for unknown agent ${agentId} rejected`);
          return res.status(202).json({ ignored: true });
        }

        // Durable persistence BEFORE the 2xx — if this insert fails we answer
        // 500 so Retell retries instead of us acknowledging lost data.
        await acceptWebhookEvent(pool, { eventType: eventType || "unknown", externalId, payload });
        res.status(204).end();
      } catch (e: any) {
        console.error("[OPS][CC] webhook persist failed:", e.message);
        res.status(500).json({ error: "persist failed" });
      }
    },
  );
}
