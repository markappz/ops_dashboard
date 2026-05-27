/**
 * Team chat — channels + messages with SSE for live updates.
 *
 * Tables:
 *   ops_chat_channels (id UUID, name UNIQUE, description, created_by, created_at)
 *   ops_chat_messages (id BIGSERIAL, channel_id, sender_email, body, created_at, edited_at)
 *
 * Endpoints (all opsGate'd):
 *   GET    /api/ops/chat/channels                           — list
 *   POST   /api/ops/chat/channels                           — create
 *   DELETE /api/ops/chat/channels/:id                       — delete (with messages)
 *   GET    /api/ops/chat/channels/:id/messages?since=&limit=
 *   POST   /api/ops/chat/channels/:id/messages              — send
 *   DELETE /api/ops/chat/messages/:id                       — delete own message (or any if admin)
 *   GET    /api/ops/chat/stream                             — SSE stream of new messages across all channels
 *
 * On boot, auto-seeds a "general" channel if no channels exist so a
 * fresh install lands on a usable surface.
 */
import type { Express, Request, Response } from "express";
import { randomUUID } from "crypto";
import { pool } from "./db";
import { logAdminAction } from "./lib/auditLog";

interface AdminReq extends Request {
  adminEmail?: string;
}

// In-process broadcaster for SSE. Every connected client gets a write()
// fn appended; we splice on close. This scales to ~hundreds of admins
// per pod without backpressure issues for a chat-volume workload.
type Subscriber = (msg: BroadcastEvent) => void;
const subscribers = new Set<Subscriber>();

interface BroadcastEvent {
  type: "message" | "channel_created" | "channel_deleted" | "message_deleted";
  payload: any;
}

function broadcast(event: BroadcastEvent) {
  for (const sub of subscribers) {
    try { sub(event); } catch { /* dead connection, will be cleaned on next ping */ }
  }
}

let tablesEnsured = false;
async function ensureChatTables() {
  if (tablesEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_chat_channels (
      id UUID PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      created_by TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ops_chat_messages (
      id BIGSERIAL PRIMARY KEY,
      channel_id UUID NOT NULL REFERENCES ops_chat_channels(id) ON DELETE CASCADE,
      sender_email TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      edited_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_chat_msgs_channel_id_id
      ON ops_chat_messages (channel_id, id DESC);
  `);
  // Seed #general on first run.
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ops_chat_channels`);
  if (r.rows[0].n === 0) {
    await pool.query(
      `INSERT INTO ops_chat_channels (id, name, description, created_by)
       VALUES ($1, 'general', 'Team-wide chat for everything', 'system')
       ON CONFLICT (name) DO NOTHING`,
      [randomUUID()],
    );
    console.log("[OPS][CHAT] Seeded #general channel");
  }
  tablesEnsured = true;
}

function normChannelName(raw: string): string {
  // lowercase, alphanumeric + hyphen, max 32, strip leading #
  return raw
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

export function registerChatRoutes(app: Express) {
  // Warm the tables + seed on boot.
  ensureChatTables().catch((e) =>
    console.warn("[OPS][CHAT] ensure tables on boot failed:", e.message),
  );

  // ─── Channels ──────────────────────────────────────────────────

  app.get("/api/ops/chat/channels", async (_req, res) => {
    try {
      await ensureChatTables();
      const r = await pool.query(`
        SELECT c.id, c.name, c.description, c.created_by, c.created_at,
               (SELECT MAX(created_at) FROM ops_chat_messages m WHERE m.channel_id = c.id) AS last_message_at,
               (SELECT COUNT(*)::int FROM ops_chat_messages m WHERE m.channel_id = c.id) AS message_count
        FROM ops_chat_channels c
        ORDER BY c.name ASC
      `);
      res.json({ channels: r.rows });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/ops/chat/channels", async (req: AdminReq, res) => {
    try {
      await ensureChatTables();
      const adminEmail = req.adminEmail || "unknown";
      const { name, description } = req.body ?? {};
      const normalized = normChannelName(String(name || ""));
      if (!normalized) return res.status(400).json({ error: "Channel name required (a-z, 0-9, hyphens)" });
      const id = randomUUID();
      let row;
      try {
        const r = await pool.query(
          `INSERT INTO ops_chat_channels (id, name, description, created_by)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, description, created_by, created_at`,
          [id, normalized, description?.trim() || null, adminEmail],
        );
        row = r.rows[0];
      } catch (e: any) {
        if (e.code === "23505") {
          return res.status(409).json({ error: `Channel #${normalized} already exists` });
        }
        throw e;
      }
      await logAdminAction({
        adminEmail,
        actionType: "chat.channel.create",
        targetKind: "chat_channel",
        targetId: row.id,
        targetLabel: `#${row.name}`,
        status: "ok",
      });
      broadcast({ type: "channel_created", payload: row });
      res.json({ channel: row });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/ops/chat/channels/:id", async (req: AdminReq, res) => {
    try {
      await ensureChatTables();
      const adminEmail = req.adminEmail || "unknown";
      const id = req.params.id;
      // Refuse to delete #general — every team needs a home channel.
      const pre = await pool.query(`SELECT name FROM ops_chat_channels WHERE id = $1`, [id]);
      if (pre.rows.length === 0) return res.status(404).json({ error: "Channel not found" });
      if (pre.rows[0].name === "general") {
        return res.status(400).json({ error: "Cannot delete #general — it's the team default channel" });
      }
      await pool.query(`DELETE FROM ops_chat_channels WHERE id = $1`, [id]);
      await logAdminAction({
        adminEmail,
        actionType: "chat.channel.delete",
        targetKind: "chat_channel",
        targetId: id,
        targetLabel: `#${pre.rows[0].name}`,
        status: "ok",
      });
      broadcast({ type: "channel_deleted", payload: { id } });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Messages ──────────────────────────────────────────────────

  app.get("/api/ops/chat/channels/:id/messages", async (req, res) => {
    try {
      await ensureChatTables();
      const channelId = req.params.id;
      const limit = Math.min(parseInt(String(req.query.limit || "100")) || 100, 500);
      // ?since=<id> for incremental polls (SSE clients use this for catch-up
      // after reconnect). Defaults to most-recent N.
      const since = req.query.since ? parseInt(String(req.query.since)) : null;
      let sql = `
        SELECT id, channel_id, sender_email, body, created_at, edited_at
        FROM ops_chat_messages WHERE channel_id = $1
      `;
      const params: any[] = [channelId];
      if (since) {
        sql += ` AND id > $2 ORDER BY id ASC LIMIT $3`;
        params.push(since, limit);
      } else {
        sql += ` ORDER BY id DESC LIMIT $2`;
        params.push(limit);
      }
      const r = await pool.query(sql, params);
      // Always return chronological (oldest first) for the client.
      const messages = since ? r.rows : r.rows.reverse();
      res.json({ messages });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/ops/chat/channels/:id/messages", async (req: AdminReq, res) => {
    try {
      await ensureChatTables();
      const adminEmail = req.adminEmail || "unknown";
      const channelId = req.params.id;
      const body = String(req.body?.body || "").trim();
      if (!body) return res.status(400).json({ error: "Message body required" });
      if (body.length > 8000) return res.status(400).json({ error: "Message too long (max 8000 chars)" });
      // Verify channel exists.
      const c = await pool.query(`SELECT name FROM ops_chat_channels WHERE id = $1`, [channelId]);
      if (c.rows.length === 0) return res.status(404).json({ error: "Channel not found" });

      const r = await pool.query(
        `INSERT INTO ops_chat_messages (channel_id, sender_email, body)
         VALUES ($1, $2, $3)
         RETURNING id, channel_id, sender_email, body, created_at, edited_at`,
        [channelId, adminEmail, body],
      );
      const msg = r.rows[0];
      broadcast({ type: "message", payload: msg });
      // No audit log for individual messages — too noisy. Channel CRUD is logged.
      res.json({ message: msg });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/ops/chat/messages/:id", async (req: AdminReq, res) => {
    try {
      await ensureChatTables();
      const adminEmail = req.adminEmail || "unknown";
      const msgId = parseInt(req.params.id);
      const pre = await pool.query(
        `SELECT id, sender_email, channel_id FROM ops_chat_messages WHERE id = $1`,
        [msgId],
      );
      if (pre.rows.length === 0) return res.status(404).json({ error: "Message not found" });
      // Only the author can delete their message. Future: admin override.
      if (pre.rows[0].sender_email !== adminEmail) {
        return res.status(403).json({ error: "Only the author can delete a message" });
      }
      await pool.query(`DELETE FROM ops_chat_messages WHERE id = $1`, [msgId]);
      broadcast({ type: "message_deleted", payload: { id: msgId, channel_id: pre.rows[0].channel_id } });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── SSE stream — live message updates ─────────────────────────

  app.get("/api/ops/chat/stream", async (_req, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    // Initial hello so the client knows the channel is live.
    res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

    const sub: Subscriber = (event) => {
      try {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
      } catch {
        // closed connection — will be removed below
      }
    };
    subscribers.add(sub);

    // Heartbeat every 25s to keep proxies from killing the connection.
    const heartbeat = setInterval(() => {
      try {
        res.write(`: keepalive ${Date.now()}\n\n`);
      } catch {
        clearInterval(heartbeat);
        subscribers.delete(sub);
      }
    }, 25_000);

    _req.on("close", () => {
      clearInterval(heartbeat);
      subscribers.delete(sub);
    });
  });
}
