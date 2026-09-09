/**
 * pawgen Command Center feed — one windowed payload for the overview, the same
 * shape of truth the Real Peptides one uses: current vs previous window of equal
 * length, zero-filled daily series, new customers = first paid order, leads from
 * the guide magnet, fulfilment backlog, and pixel traffic for pawgen.com.
 */
import type { Express, Request, Response } from "express";
import { pool, pawgenPool } from "./db";
import * as rest from "./pawgen-rest";
import { windowOf, type Window } from "./lib/window";

const DAY = 86_400_000;
const cache = new Map<string, { at: number; data: any }>();
const CACHE_MS = 60_000;

type Order = {
  created_at: string; amount_usd: string | number; pack_id: string; method: string; source: string | null;
  payment_status: string; fulfillment_status: string; customer_email: string | null; ref_source: string | null; ref_medium: string | null; ref_campaign: string | null;
};
type Lead = { email: string; source: string | null; created_at: string; guide_sent: boolean | null };

async function loadOrders(): Promise<Order[]> {
  if (rest.pawgenRestConfigured()) return (await rest.ordersForAnalytics()) as Order[];
  if (!pawgenPool) throw new Error("pawgen database not connected");
  return (await pawgenPool.query(`SELECT created_at, amount_usd, pack_id, method, source, payment_status, fulfillment_status, customer_email, ref_source, ref_medium, ref_campaign FROM orders ORDER BY created_at DESC`)).rows;
}
async function loadLeads(): Promise<Lead[]> {
  if (rest.pawgenRestConfigured()) return (await rest.fetchLeads()) as Lead[];
  if (!pawgenPool) throw new Error("pawgen database not connected");
  return (await pawgenPool.query(`SELECT email, source, created_at, guide_sent FROM leads ORDER BY created_at DESC`)).rows;
}

const money = (o: Order) => Number(o.amount_usd) || 0;
const cents = (n: number) => Math.round(n * 100) / 100;
const within = (iso: string, from: Date, to: Date) => { const t = new Date(iso).getTime(); return t >= from.getTime() && t <= to.getTime(); };

function bucket(list: Order[]) {
  const emails = new Set(list.map((o) => (o.customer_email ?? "").trim().toLowerCase()).filter(Boolean));
  const revenue = cents(list.reduce((s, o) => s + money(o), 0));
  return { revenue, orders: list.length, aov: list.length ? cents(revenue / list.length) : 0, customers: emails.size };
}

function series(list: Order[], win: Window) {
  const byDay = new Map<string, { revenue: number; orders: number }>();
  for (let i = win.days - 1; i >= 0; i--) byDay.set(new Date(win.to.getTime() - i * DAY).toISOString().slice(0, 10), { revenue: 0, orders: 0 });
  for (const o of list) {
    const cur = byDay.get(o.created_at.slice(0, 10));
    if (cur) { cur.revenue = cents(cur.revenue + money(o)); cur.orders++; }
  }
  return [...byDay.entries()].map(([date, v]) => ({ date, ...v }));
}

function tally(list: Order[], key: keyof Order, label?: (k: string) => string) {
  const m = new Map<string, { count: number; value: number }>();
  for (const o of list) {
    const k = String(o[key] ?? "(none)");
    const cur = m.get(k) ?? { count: 0, value: 0 };
    cur.count++; cur.value = cents(cur.value + money(o)); m.set(k, cur);
  }
  return [...m.entries()].map(([k, v]) => ({ key: label ? label(k) : k, ...v })).sort((a, b) => b.value - a.value).slice(0, 8);
}

/** Emails whose FIRST paid order falls in each window. */
function newCustomers(paid: Order[], win: Window) {
  const first = new Map<string, number>();
  for (const o of paid) {
    const e = (o.customer_email ?? "").trim().toLowerCase(); if (!e) continue;
    const t = new Date(o.created_at).getTime();
    if (!first.has(e) || t < first.get(e)!) first.set(e, t);
  }
  const now = Date.now();
  const count = (from: number, to: number) => [...first.values()].filter((t) => t >= from && t <= to).length;
  return { today: count(now - DAY, now), week: count(now - 7 * DAY, now), month: count(now - 30 * DAY, now), window: count(win.from.getTime(), win.to.getTime()), previous: count(win.prevFrom.getTime(), win.prevTo.getTime()) };
}

function leadStats(leads: Lead[], paid: Order[], win: Window) {
  const now = Date.now();
  const count = (from: number, to: number) => leads.filter((l) => { const t = new Date(l.created_at).getTime(); return t >= from && t <= to; }).length;
  const buyers = new Set(paid.map((o) => (o.customer_email ?? "").trim().toLowerCase()).filter(Boolean));
  const inWin = leads.filter((l) => within(l.created_at, win.from, win.to));
  const bySource = new Map<string, number>();
  for (const l of inWin) bySource.set(l.source || "(unknown)", (bySource.get(l.source || "(unknown)") ?? 0) + 1);
  return {
    total: leads.length,
    today: count(now - DAY, now), week: count(now - 7 * DAY, now), month: count(now - 30 * DAY, now),
    window: inWin.length, previous: count(win.prevFrom.getTime(), win.prevTo.getTime()),
    converted: leads.filter((l) => buyers.has(l.email.trim().toLowerCase())).length,
    guideSent: leads.filter((l) => l.guide_sent).length,
    bySource: [...bySource.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
    daily: dailyLeads(inWin, win),
  };
}
function dailyLeads(list: Lead[], win: Window) {
  const byDay = new Map<string, number>();
  for (let i = win.days - 1; i >= 0; i--) byDay.set(new Date(win.to.getTime() - i * DAY).toISOString().slice(0, 10), 0);
  for (const l of list) { const k = l.created_at.slice(0, 10); if (byDay.has(k)) byDay.set(k, byDay.get(k)! + 1); }
  return [...byDay.entries()].map(([date, count]) => ({ date, count }));
}

async function traffic(from: Date, to: Date) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS sessions, COUNT(DISTINCT visitor_id)::int AS visitors FROM visitor_sessions WHERE site = 'pawgen' AND created_at > $1 AND created_at <= $2`, [from, to]);
  return rows[0];
}

async function build(win: Window) {
  const [orders, leads, cur, prev, ever] = await Promise.all([
    loadOrders(), loadLeads(), traffic(win.from, win.to), traffic(win.prevFrom, win.prevTo),
    pool.query(`SELECT EXISTS(SELECT 1 FROM visitor_sessions WHERE site = 'pawgen') AS ok`),
  ]);
  const paid = orders.filter((o) => o.payment_status === "paid");
  const inWin = paid.filter((o) => within(o.created_at, win.from, win.to));
  const inPrev = paid.filter((o) => within(o.created_at, win.prevFrom, win.prevTo));
  const backlog = orders.filter((o) => o.payment_status === "paid" && (o.fulfillment_status === "unfulfilled" || o.fulfillment_status === "processing"));
  const oldest = backlog.map((o) => new Date(o.created_at).getTime()).sort((a, b) => a - b)[0];
  const byEmail = new Map<string, number>();
  for (const o of paid) { const e = (o.customer_email ?? "").trim().toLowerCase(); if (e) byEmail.set(e, (byEmail.get(e) ?? 0) + 1); }
  return {
    generatedAt: new Date().toISOString(),
    window: { from: win.from.toISOString(), to: win.to.toISOString(), days: win.days, custom: win.custom },
    sales: {
      current: bucket(inWin), previous: bucket(inPrev),
      allTime: { revenue: cents(paid.reduce((s, o) => s + money(o), 0)), orders: paid.length, customers: byEmail.size, repeatCustomers: [...byEmail.values()].filter((n) => n > 1).length },
      pendingPayments: orders.filter((o) => o.payment_status === "pending").length,
      refunded: orders.filter((o) => o.payment_status === "refunded").length,
      series: series(inWin, win),
      byPack: tally(inWin, "pack_id", (k) => ({ "1-pack": "1 pack", "2-pack": "2 packs", "4-pack": "4 packs" } as Record<string, string>)[k] ?? k),
      byMethod: tally(inWin, "method"),
      bySource: tally(inWin, "ref_source", (k) => (k === "(none)" ? "direct / untagged" : k)),
    },
    newCustomers: newCustomers(paid, win),
    backlog: { count: backlog.length, value: cents(backlog.reduce((s, o) => s + money(o), 0)), oldestAt: oldest ? new Date(oldest).toISOString() : null },
    leads: leadStats(leads, paid, win),
    traffic: { pixelInstalled: ever.rows[0]?.ok === true, current: cur, previous: prev },
  };
}

export function registerPawgenCommand(app: Express) {
  app.get("/api/ops/pawgen/command", async (req: Request, res: Response) => {
    if (!rest.pawgenRestConfigured() && !pawgenPool) {
      return res.json({ configured: false, hint: "pawgen database not connected — set PAWGEN_SUPABASE_URL + PAWGEN_SUPABASE_SERVICE_ROLE_KEY." });
    }
    const win = windowOf(req.query as Record<string, unknown>);
    const hit = cache.get(win.key);
    if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.data);
    try {
      const data = { configured: true, ...(await build(win)) };
      cache.set(win.key, { at: Date.now(), data });
      res.json(data);
    } catch (e: any) {
      console.error("[OPS][pawgen] command:", e.message);
      res.status(502).json({ error: e.message });
    }
  });
}
