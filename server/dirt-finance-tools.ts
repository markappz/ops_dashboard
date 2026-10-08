/**
 * Dirt finance tools — "add $500 Replicate credits to pawgen" lands a
 * categorized entry; "what did we spend on RP this month" reads the roll-up.
 * Access mirrors the HTTP routes exactly (finance.ts): the grant is checked
 * per call against the ACTING admin — Dirt never widens finance access.
 */
import { pool } from "./db";
import {
  addFinanceEntry, ensureFinanceTables, financeLevel,
  FINANCE_BRANDS, FINANCE_CATEGORIES, FINANCE_KINDS,
} from "./finance";

type ToolHandler = (input: any, ctx: { adminEmail: string }) => Promise<unknown>;
interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: ToolHandler;
  write?: boolean;
}

const NO_ACCESS = { error: "No finance access — Paul grants finance:entry in Settings → Team." };

export const FINANCE_READ_TOOLS: ToolDef[] = [
  {
    name: "finance_summary",
    description: "Brand financials roll-up: tracked expenses by category, retainers and manual revenue for a brand (or all brands, master-grant only) over a date window. Brands: fitscript, peptideu, pawgen, realpeptides, northblu, reverra, clomark, shared.",
    input_schema: {
      type: "object",
      properties: {
        brand: { type: "string", description: "brand slug, or 'all' (master only)" },
        from: { type: "string", description: "YYYY-MM-DD, default 30 days ago" },
        to: { type: "string", description: "YYYY-MM-DD, default today" },
      },
      required: [],
    },
    handler: async (args, { adminEmail }) => {
      const level = financeLevel(adminEmail);
      if (level === "none") return NO_ACCESS;
      await ensureFinanceTables();
      const brand = String(args.brand || "all").toLowerCase();
      if (brand === "all" && level !== "master") return { error: "Cross-brand totals are master-only." };
      const from = /^\d{4}-\d{2}-\d{2}$/.test(args.from) ? args.from : new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      const to = /^\d{4}-\d{2}-\d{2}$/.test(args.to) ? args.to : new Date().toISOString().slice(0, 10);
      const params: any[] = [from, to];
      let where = `deleted_at IS NULL AND entry_date <= $2::date AND (recurring = 'monthly' AND COALESCE(ended_at, $2::date) >= $1::date OR recurring = 'none' AND entry_date >= $1::date)`;
      if (brand !== "all") { params.push(brand); where += ` AND brand = $${params.length}`; }
      const rows = await pool.query(
        `SELECT brand, kind, category, recurring, vendor, description, amount_cents / 100.0 AS usd, entry_date::text
           FROM ops_finance_entries WHERE ${where} ORDER BY entry_date DESC LIMIT 200`, params);
      return { from, to, entries: rows.rows, note: "Tracked entries only; live sales feeds stay on each brand's tabs." };
    },
  },
];

export const FINANCE_WRITE_TOOLS: ToolDef[] = [
  {
    name: "add_finance_entry",
    description: `Record a brand expense, retainer or manual revenue line. Use when someone says things like "add a $500 Replicate bill to pawgen" or "log the $3k Acme retainer on clomark". Kinds: ${FINANCE_KINDS.join("|")}. Categories: ${FINANCE_CATEGORIES.join("|")}. Retainers and anything monthly recur automatically each month until ended.`,
    write: true,
    input_schema: {
      type: "object",
      properties: {
        brand: { type: "string", description: `one of ${FINANCE_BRANDS.join("|")} ('shared' for company-wide costs)` },
        kind: { type: "string", description: "expense (default) | retainer | revenue" },
        amount_usd: { type: "number", description: "dollar amount, positive" },
        category: { type: "string", description: `best fit of ${FINANCE_CATEGORIES.join("|")}` },
        vendor: { type: "string", description: "who gets paid / who pays us" },
        description: { type: "string", description: "short note" },
        date: { type: "string", description: "YYYY-MM-DD, default today" },
        recurring: { type: "string", description: "'monthly' if it repeats every month" },
      },
      required: ["brand", "amount_usd"],
    },
    handler: async (args, { adminEmail }) => {
      if (financeLevel(adminEmail) === "none") return NO_ACCESS;
      const out = await addFinanceEntry({
        brand: args.brand, kind: (FINANCE_KINDS as readonly string[]).includes(args.kind) ? args.kind : "expense",
        category: args.category, vendor: args.vendor, description: args.description,
        amountUsd: args.amount_usd, entryDate: args.date, recurring: args.recurring,
        source: "dirt", createdBy: adminEmail,
      });
      if ("error" in out) return out;
      return { ok: true, id: out.id, saved: `${args.kind || "expense"} · ${args.brand} · $${args.amount_usd}${args.recurring === "monthly" ? "/mo" : ""}` };
    },
  },
];
