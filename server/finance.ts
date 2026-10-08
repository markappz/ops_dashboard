/**
 * Brand financials (2026-10-07, Paul + Michael): expenses, retainers and
 * manual revenue per brand, rolled up into per-brand Financials tabs and one
 * cross-brand Master view.
 *
 * Access is grant-based and STRICTER than role=admin on purpose:
 *   finance:master — Paul + Michael (and whoever they grant): everything,
 *                    including the Master roll-up and deletes.
 *   finance:entry  — Josh / Justin / Mike Burnett (CFO): view brand tabs and
 *                    add/edit entries. No Master view.
 * Seed: FINANCE_MASTER_EMAILS env (comma list) is always treated as master so
 * the first login can hand out grants in Settings → Team. Enforced in every
 * route here — the UI hiding a tab is not the gate.
 *
 * Money is stored in cents. `recurring='monthly'` entries count once in every
 * month they're active (from entry_date until ended_at) — that's how
 * retainers and fixed costs roll into each month without re-entry.
 */
import type { Express, Request, Response, NextFunction } from "express";
import { pool } from "./db";
import { emailHasPermission } from "./admin-auth";
import { logAdminAction } from "./lib/auditLog";
import { anthropic, BEDROCK_MODELS, isAIConfigured } from "./lib/bedrock";
import { logAiCost } from "./aiCostLogger";

export const FINANCE_KINDS = ["expense", "revenue", "retainer"] as const;
export const FINANCE_CATEGORIES = [
  "ai_credits", "ads", "software", "contractors", "payroll", "inventory",
  "shipping", "legal", "fees", "retainer", "sales", "other",
] as const;
export const FINANCE_BRANDS = ["fitscript", "peptideu", "pawgen", "realpeptides", "northblu", "reverra", "clomark", "shared"] as const;

let tablesEnsured = false;
export async function ensureFinanceTables(): Promise<void> {
  if (tablesEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_finance_entries (
      id BIGSERIAL PRIMARY KEY,
      brand TEXT NOT NULL,
      kind TEXT NOT NULL,                         -- expense | revenue | retainer
      category TEXT NOT NULL DEFAULT 'other',
      vendor TEXT,
      description TEXT,
      amount_cents BIGINT NOT NULL,
      entry_date DATE NOT NULL,
      recurring TEXT NOT NULL DEFAULT 'none',     -- none | monthly
      ended_at DATE,                              -- recurring entries stop counting after this
      source TEXT NOT NULL DEFAULT 'manual',      -- manual | dirt | cfo
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS ops_finance_brand_idx ON ops_finance_entries (brand, entry_date) WHERE deleted_at IS NULL;
  `);
  tablesEnsured = true;
}

function masterSeed(): Set<string> {
  return new Set(
    (process.env.FINANCE_MASTER_EMAILS || "paulclotar@gmail.com")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}

export function financeLevel(email: string | undefined): "master" | "entry" | "none" {
  const e = (email || "").toLowerCase();
  if (!e) return "none";
  if (masterSeed().has(e) || emailHasPermission(e, "finance:master")) return "master";
  if (emailHasPermission(e, "finance:entry")) return "entry";
  return "none";
}

type FinReq = Request & { adminEmail?: string };

const needAccess = (min: "entry" | "master") => (req: FinReq, res: Response, next: NextFunction) => {
  const level = financeLevel(req.adminEmail);
  if (level === "none" || (min === "master" && level !== "master")) {
    return res.status(403).json({
      error: min === "master"
        ? "Master financials are restricted — ask Paul for the finance:master grant."
        : "Finance access is grant-based — ask Paul for the finance:entry grant in Settings → Team.",
    });
  }
  next();
};

const toCents = (v: unknown): number | null => {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 100_000_000) return null;
  return Math.round(n * 100);
};

export interface NewEntry {
  brand: string; kind: string; category?: string; vendor?: string; description?: string;
  amountUsd: number; entryDate?: string; recurring?: string; source?: string; createdBy: string;
}

/** Shared insert — the API routes and the Dirt tool both land here. */
export async function addFinanceEntry(e: NewEntry): Promise<{ id: number } | { error: string }> {
  await ensureFinanceTables();
  const brand = String(e.brand || "").toLowerCase().trim();
  if (!(FINANCE_BRANDS as readonly string[]).includes(brand)) return { error: `brand must be one of: ${FINANCE_BRANDS.join(", ")}` };
  if (!(FINANCE_KINDS as readonly string[]).includes(e.kind)) return { error: `kind must be one of: ${FINANCE_KINDS.join(", ")}` };
  const category = (FINANCE_CATEGORIES as readonly string[]).includes(String(e.category)) ? String(e.category) : e.kind === "retainer" ? "retainer" : "other";
  const cents = toCents(e.amountUsd);
  if (cents == null) return { error: "amount must be a non-zero dollar figure" };
  const date = e.entryDate && /^\d{4}-\d{2}-\d{2}$/.test(e.entryDate) ? e.entryDate : new Date().toISOString().slice(0, 10);
  const recurring = e.recurring === "monthly" || e.kind === "retainer" ? "monthly" : "none";
  const r = await pool.query(
    `INSERT INTO ops_finance_entries (brand, kind, category, vendor, description, amount_cents, entry_date, recurring, source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [brand, e.kind, category, (e.vendor || "").slice(0, 120) || null, (e.description || "").slice(0, 500) || null,
     cents, date, recurring, e.source || "manual", e.createdBy],
  );
  return { id: r.rows[0].id };
}

/** Months a recurring entry covers inside [from, to] → how many times it counts. */
const MONTHLY_SQL = `
  CASE WHEN f.recurring = 'monthly' THEN
    GREATEST(0, (
      (date_part('year', LEAST(COALESCE(f.ended_at, $2::date), $2::date)) * 12 + date_part('month', LEAST(COALESCE(f.ended_at, $2::date), $2::date)))
      - (date_part('year', GREATEST(f.entry_date, $1::date)) * 12 + date_part('month', GREATEST(f.entry_date, $1::date)))
      + 1
    ))::int * CASE WHEN f.entry_date <= $2::date AND COALESCE(f.ended_at, $2::date) >= $1::date THEN 1 ELSE 0 END
  ELSE CASE WHEN f.entry_date >= $1::date AND f.entry_date <= $2::date THEN 1 ELSE 0 END END`;

/**
 * Natural-language quick-add: "add a $500 Replicate bill" / "$3k/mo Acme
 * retainer starting Oct 1" → one tool-forced Haiku call extracts the entry,
 * then the SAME addFinanceEntry path files it (grant-checked upstream).
 */
async function parseAndFile(text: string, defaultBrand: string, createdBy: string) {
  const today = new Date().toISOString().slice(0, 10);
  const resp: any = await (anthropic as any).messages.create({
    model: BEDROCK_MODELS.FAST,
    max_tokens: 400,
    system: `Extract ONE finance entry from the user's sentence. Today is ${today}. Default brand is "${defaultBrand}" unless another brand is named (${FINANCE_BRANDS.join(", ")}). "per month"/"monthly"/"/mo" or the word retainer → recurring monthly. Retainers and money we RECEIVE are kind retainer/revenue; bills/costs are expense. Pick the closest category. Resolve relative dates ("yesterday", "last Tuesday") to YYYY-MM-DD. If no dollar amount is present, call the tool with amount_usd 0.`,
    tools: [{
      name: "file_entry",
      description: "File the extracted entry",
      input_schema: {
        type: "object",
        properties: {
          brand: { type: "string", enum: [...FINANCE_BRANDS] },
          kind: { type: "string", enum: [...FINANCE_KINDS] },
          amount_usd: { type: "number" },
          category: { type: "string", enum: [...FINANCE_CATEGORIES] },
          vendor: { type: "string" },
          description: { type: "string" },
          date: { type: "string", description: "YYYY-MM-DD" },
          recurring: { type: "string", enum: ["none", "monthly"] },
        },
        required: ["brand", "kind", "amount_usd"],
      },
    }],
    tool_choice: { type: "tool", name: "file_entry" },
    messages: [{ role: "user", content: text.slice(0, 500) }],
  });
  logAiCost({ surface: "ops_finance_quickadd", model: BEDROCK_MODELS.FAST, inputTokens: resp.usage?.input_tokens ?? 0, outputTokens: resp.usage?.output_tokens ?? 0 }).catch(() => {});
  const call = resp.content?.find((c: any) => c.type === "tool_use");
  const a = call?.input ?? {};
  if (!a.amount_usd) return { error: "I couldn't find a dollar amount in that — include one like “$500 Replicate credits”." };
  const filed = await addFinanceEntry({
    brand: a.brand || defaultBrand, kind: a.kind || "expense", category: a.category,
    vendor: a.vendor, description: a.description || text.slice(0, 200), amountUsd: a.amount_usd,
    entryDate: a.date, recurring: a.recurring, source: "dirt", createdBy,
  });
  if ("error" in filed) return filed;
  return { ok: true, id: filed.id, parsed: { brand: a.brand || defaultBrand, kind: a.kind || "expense", amount_usd: a.amount_usd, category: a.category ?? "other", vendor: a.vendor ?? null, date: a.date ?? today, recurring: a.recurring ?? "none" } };
}

export function registerFinanceRoutes(app: Express) {
  app.post("/api/ops/finance/quick-add", needAccess("entry"), async (req: FinReq, res) => {
    try {
      if (!isAIConfigured()) return res.status(503).json({ error: "AI isn't configured on this server — use the manual form." });
      const text = String(req.body?.text ?? "").trim();
      if (!text) return res.status(400).json({ error: "Say or type the expense first." });
      const out = await parseAndFile(text, String(req.body?.brand || "shared").toLowerCase(), req.adminEmail!);
      if ("error" in out) return res.status(400).json(out);
      await logAdminAction({ adminEmail: req.adminEmail!, actionType: "finance.entry.add", targetKind: "finance_entry", targetId: String(out.id), targetLabel: `quick-add: ${text.slice(0, 80)}`, status: "ok" });
      res.json(out);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  /** What the signed-in user may see — drives nav visibility client-side. */
  app.get("/api/ops/finance/access", async (req: FinReq, res) => {
    res.json({ level: financeLevel(req.adminEmail) });
  });

  app.get("/api/ops/finance/entries", needAccess("entry"), async (req: FinReq, res) => {
    try {
      await ensureFinanceTables();
      const brand = String(req.query.brand || "").toLowerCase();
      if ((!brand || brand === "all") && financeLevel(req.adminEmail) !== "master") {
        return res.status(403).json({ error: "Cross-brand listings are master-only." });
      }
      const from = String(req.query.from || "").slice(0, 10) || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      const to = String(req.query.to || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
      const params: any[] = [from, to];
      let where = `deleted_at IS NULL AND (entry_date <= $2::date) AND (recurring = 'monthly' AND COALESCE(ended_at, $2::date) >= $1::date OR recurring = 'none' AND entry_date >= $1::date)`;
      if (brand && brand !== "all") { params.push(brand); where += ` AND brand = $${params.length}`; }
      const rows = await pool.query(
        `SELECT id, brand, kind, category, vendor, description, amount_cents, entry_date::text, recurring, ended_at::text, source, created_by, created_at
           FROM ops_finance_entries WHERE ${where} ORDER BY entry_date DESC, id DESC LIMIT 500`, params);
      res.json({ entries: rows.rows, from, to });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/ops/finance/entries", needAccess("entry"), async (req: FinReq, res) => {
    try {
      const b = req.body ?? {};
      const out = await addFinanceEntry({
        brand: b.brand, kind: b.kind || "expense", category: b.category, vendor: b.vendor,
        description: b.description, amountUsd: b.amount, entryDate: b.date, recurring: b.recurring,
        source: financeLevel(req.adminEmail) === "master" ? "manual" : "cfo", createdBy: req.adminEmail!,
      });
      if ("error" in out) return res.status(400).json(out);
      await logAdminAction({ adminEmail: req.adminEmail!, actionType: "finance.entry.add", targetKind: "finance_entry", targetId: String((out as any).id), targetLabel: `${b.kind || "expense"} ${b.brand} $${b.amount}`, status: "ok" });
      res.json({ ok: true, ...out });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.patch("/api/ops/finance/entries/:id", needAccess("entry"), async (req: FinReq, res) => {
    try {
      await ensureFinanceTables();
      const id = parseInt(String(req.params.id), 10);
      const cur = (await pool.query(`SELECT created_by FROM ops_finance_entries WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0];
      if (!cur) return res.status(404).json({ error: "Not found" });
      // entry-level users may edit their own rows; master edits anything
      if (financeLevel(req.adminEmail) !== "master" && cur.created_by !== req.adminEmail) {
        return res.status(403).json({ error: "You can only edit entries you created." });
      }
      const b = req.body ?? {};
      const sets: string[] = ["updated_at = NOW()"]; const params: any[] = [id];
      const set = (c: string, v: any) => { params.push(v); sets.push(`${c} = $${params.length}`); };
      if (b.amount !== undefined) { const c = toCents(b.amount); if (c == null) return res.status(400).json({ error: "bad amount" }); set("amount_cents", c); }
      if (b.category !== undefined && (FINANCE_CATEGORIES as readonly string[]).includes(b.category)) set("category", b.category);
      if (b.vendor !== undefined) set("vendor", String(b.vendor).slice(0, 120) || null);
      if (b.description !== undefined) set("description", String(b.description).slice(0, 500) || null);
      if (b.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(b.date)) set("entry_date", b.date);
      if (b.ended_at !== undefined) set("ended_at", b.ended_at && /^\d{4}-\d{2}-\d{2}$/.test(b.ended_at) ? b.ended_at : null);
      if (b.recurring !== undefined) set("recurring", b.recurring === "monthly" ? "monthly" : "none");
      await pool.query(`UPDATE ops_finance_entries SET ${sets.join(", ")} WHERE id = $1`, params);
      await logAdminAction({ adminEmail: req.adminEmail!, actionType: "finance.entry.edit", targetKind: "finance_entry", targetId: String(id), targetLabel: "edit", status: "ok" });
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.delete("/api/ops/finance/entries/:id", needAccess("master"), async (req: FinReq, res) => {
    try {
      await ensureFinanceTables();
      await pool.query(`UPDATE ops_finance_entries SET deleted_at = NOW() WHERE id = $1`, [parseInt(String(req.params.id), 10)]);
      await logAdminAction({ adminEmail: req.adminEmail!, actionType: "finance.entry.delete", targetKind: "finance_entry", targetId: String(req.params.id), targetLabel: "soft delete", status: "ok" });
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  /** Per-brand (or all-brand, master-only) roll-up for a window. */
  app.get("/api/ops/finance/summary", needAccess("entry"), async (req: FinReq, res) => {
    try {
      await ensureFinanceTables();
      const brand = String(req.query.brand || "").toLowerCase();
      if ((!brand || brand === "all") && financeLevel(req.adminEmail) !== "master") {
        return res.status(403).json({ error: "Cross-brand totals are master-only." });
      }
      const from = String(req.query.from || "").slice(0, 10) || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      const to = String(req.query.to || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
      const params: any[] = [from, to];
      let where = `f.deleted_at IS NULL`;
      if (brand && brand !== "all") { params.push(brand); where += ` AND f.brand = $${params.length}`; }
      const rows = await pool.query(
        `SELECT f.brand, f.kind, f.category,
                SUM(f.amount_cents * (${MONTHLY_SQL}))::bigint AS cents
           FROM ops_finance_entries f WHERE ${where}
           GROUP BY f.brand, f.kind, f.category
           HAVING SUM(f.amount_cents * (${MONTHLY_SQL})) <> 0`, params);
      const brands: Record<string, { expenses: number; revenue: number; retainers: number; byCategory: Record<string, number> }> = {};
      for (const r of rows.rows) {
        const b = (brands[r.brand] ||= { expenses: 0, revenue: 0, retainers: 0, byCategory: {} });
        const usd = Number(r.cents) / 100;
        if (r.kind === "expense") { b.expenses += usd; b.byCategory[r.category] = (b.byCategory[r.category] || 0) + usd; }
        else if (r.kind === "retainer") b.retainers += usd;
        else b.revenue += usd;
      }
      res.json({ from, to, brands, note: "Revenue/retainers here are tracked entries only — each brand's live sales feed stays on its own tabs; auto-joins are the next pass." });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
}
