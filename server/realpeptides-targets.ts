/**
 * Inventory targets that keep up with demand (Justin, 2026-09-10).
 *
 * Every 4 weeks, look at the last 8 weeks of sales and reset each product's
 * saved target (tracker `ideal_stock`) to weekly velocity × (cover + lead)
 * weeks, rounded up to boxes of ten. Cover is the product's own `cover_weeks`
 * when set, else 6; lead is 2 (manufacturer turnaround) — the same math the
 * Forecast tab and PO #4 used. Products with no sales in the window keep
 * their manual target; do-not-replenish products are left alone.
 *
 * Sales history already covers Jul 3 onward (Woo backfill + live site orders),
 * so the first refresh runs on deploy instead of waiting eight weeks.
 * Every run is recorded with per-product before/after, and the Inventory tab
 * shows last/next run with a "Refresh targets now" button.
 */
import type { Express } from "express";
import { pool } from "./db";
import { velocityBySku } from "./realpeptides-inventory";

const WINDOW_DAYS = 56;               // eight weeks of demand
const EVERY_DAYS = 28;                // refresh cadence
const DEFAULT_COVER_WEEKS = Number(process.env.RP_TARGET_COVER_WEEKS || "6");
const LEAD_WEEKS = Number(process.env.RP_TARGET_LEAD_WEEKS || "2");
const CHECK_EVERY_MS = 60 * 60_000;

export interface TargetChange { sku_id: number; sku_code: string; product_name: string; weekly: number; cover: number; before: number | null; after: number }
export interface TargetRun { id: number; ran_at: string; trigger: string; changed: number; unchanged: number; skipped: number; changes: TargetChange[]; error: string | null }

let running = false;

function trackerCfg() {
  const token = process.env.COA_OPS_TOKEN;
  return token ? { base: (process.env.COA_API_URL || "https://coa.realpeptides.co").replace(/\/$/, ""), token } : null;
}

async function ensureTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS rp_target_refresh_runs (
    id SERIAL PRIMARY KEY, ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), trigger TEXT NOT NULL,
    changed INT NOT NULL DEFAULT 0, unchanged INT NOT NULL DEFAULT 0, skipped INT NOT NULL DEFAULT 0,
    changes JSONB NOT NULL DEFAULT '[]', error TEXT)`);
}

const roundTen = (n: number) => Math.ceil(n / 10) * 10;

async function trackerJson(path: string, init?: RequestInit) {
  const t = trackerCfg();
  if (!t) throw new Error("tracker not configured");
  const r = await fetch(`${t.base}/api${path}`, { ...init, headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json", ...(init?.headers || {}) }, signal: AbortSignal.timeout(60_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`tracker ${path} → ${r.status}: ${text.slice(0, 120)}`);
  return JSON.parse(text);
}

/** New target for one product, or null when it should be left alone. */
function proposedTarget(s: any, units8w: number): { weekly: number; cover: number; after: number } | null {
  if (s.do_not_replenish) return null;
  if (!units8w || units8w <= 0) return null;
  const weekly = units8w / (WINDOW_DAYS / 7);
  const cover = (s.cover_weeks != null ? Number(s.cover_weeks) : DEFAULT_COVER_WEEKS) + LEAD_WEEKS;
  return { weekly: Math.round(weekly * 10) / 10, cover, after: Math.max(10, roundTen(weekly * cover)) };
}

export async function runTargetRefresh(trigger: "scheduled" | "manual" | "deploy"): Promise<TargetRun> {
  if (running) throw new Error("a target refresh is already running");
  running = true;
  const changes: TargetChange[] = [];
  let unchanged = 0, skipped = 0, error: string | null = null;
  try {
    const [vel, skus] = await Promise.all([velocityBySku([28, WINDOW_DAYS]), trackerJson("/skus")]);
    for (const s of skus.skus ?? []) {
      const units = vel.bySku?.[s.sku_code]?.units?.[WINDOW_DAYS] ?? 0;
      const p = proposedTarget(s, units);
      if (!p) { skipped++; continue; }
      const before = s.ideal_stock == null ? null : Number(s.ideal_stock);
      if (before === p.after) { unchanged++; continue; }
      await trackerJson(`/skus/${s.id}`, { method: "PATCH", body: JSON.stringify({ ideal_stock: p.after }) });
      changes.push({ sku_id: s.id, sku_code: s.sku_code, product_name: s.product_name, weekly: p.weekly, cover: p.cover, before, after: p.after });
    }
  } catch (e: any) {
    error = e.message;
    console.error("[OPS][RP] target refresh:", e.message);
  } finally {
    running = false;
  }
  const { rows } = await pool.query(
    `INSERT INTO rp_target_refresh_runs (trigger, changed, unchanged, skipped, changes, error) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [trigger, changes.length, unchanged, skipped, JSON.stringify(changes), error]);
  console.log(`[OPS][RP] target refresh (${trigger}): ${changes.length} changed, ${unchanged} unchanged, ${skipped} skipped${error ? ` — ${error}` : ""}`);
  return rows[0];
}

async function lastRun(): Promise<TargetRun | null> {
  const { rows } = await pool.query(`SELECT * FROM rp_target_refresh_runs WHERE error IS NULL ORDER BY ran_at DESC LIMIT 1`);
  return rows[0] ?? null;
}

export function nextRunAfter(last: TargetRun | null): Date {
  return last ? new Date(new Date(last.ran_at).getTime() + EVERY_DAYS * 86_400_000) : new Date();
}

/** Hourly check: run when the last successful refresh is 4+ weeks old (or never happened). */
export function startTargetRefreshLoop() {
  if (!trackerCfg()) return;
  const tick = async () => {
    try {
      await ensureTable();
      const last = await lastRun();
      if (Date.now() >= nextRunAfter(last).getTime()) await runTargetRefresh(last ? "scheduled" : "deploy");
    } catch (e: any) { console.error("[OPS][RP] target loop:", e.message); }
  };
  setTimeout(tick, 90_000);
  setInterval(tick, CHECK_EVERY_MS);
}

export function registerTargetRefresh(app: Express) {
  app.get("/api/ops/realpeptides/inventory/targets", async (_req, res) => {
    try {
      await ensureTable();
      const last = await lastRun();
      const { rows } = await pool.query(`SELECT id, ran_at, trigger, changed, unchanged, skipped, error FROM rp_target_refresh_runs ORDER BY ran_at DESC LIMIT 12`);
      res.json({ configured: !!trackerCfg(), everyDays: EVERY_DAYS, windowDays: WINDOW_DAYS, coverWeeks: DEFAULT_COVER_WEEKS, leadWeeks: LEAD_WEEKS, last, nextRunAt: nextRunAfter(last).toISOString(), runs: rows });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  app.post("/api/ops/realpeptides/inventory/targets/refresh", async (_req, res) => {
    try { await ensureTable(); res.json(await runTargetRefresh("manual")); }
    catch (e: any) { res.status(502).json({ error: e.message }); }
  });
}
