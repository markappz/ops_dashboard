/**
 * Database connection — shares the same RDS as the main FitScript app.
 * Raw SQL only via pool.query. Drizzle is intentionally not used here
 * (see DECISIONS.md — "Raw SQL only, no Drizzle in this repo").
 */
import pg from "pg";

const { Pool, types } = pg;

// All TIMESTAMP WITHOUT TIME ZONE columns in this database store UTC
// values (Postgres session is UTC, all inserts use NOW() or UTC ISO).
// Without this override, pg-types parses naive timestamps in the Node
// process's LOCAL TZ — on a PDT dev box that shifts every read by +7h.
// OID 1114 is the timestamp-without-tz type.
//
// TIMESTAMPTZ (OID 1184) already round-trips correctly because the
// wire format carries the offset.
types.setTypeParser(1114, (str) => (str ? new Date(str + "Z") : null));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL must be set. This connects to the same RDS as the main FitScript app.");
}

// Both Neon and RDS terminate TLS with chains Node may not trust by default.
// Skip cert validation unless the URL explicitly opts out of SSL.
const wantsSsl = !/sslmode=disable/i.test(connectionString);
const pool = new Pool({
  connectionString,
  ssl: wantsSsl ? { rejectUnauthorized: false } : false,
});

export { pool };

/**
 * PeptideU database — a SEPARATE Supabase Postgres, read-only for this dashboard.
 * Optional: the dashboard runs fine without it (the PeptideU section returns 503).
 * Supabase always terminates TLS with a chain Node may not trust → skip validation.
 */
const peptideuUrl = process.env.PEPTIDEU_DATABASE_URL;
export const peptidePool = peptideuUrl
  ? new Pool({ connectionString: peptideuUrl, ssl: { rejectUnauthorized: false }, max: 4 })
  : null;

if (peptidePool) {
  peptidePool.on("error", (err) => {
    console.warn("[OPS DB] PeptideU pool error:", err.message);
  });
}

export async function verifyConnection(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    console.log("[OPS DB] Connected to FitScript database");
    return true;
  } catch (error: any) {
    console.error("[OPS DB] Connection failed:", error.message);
    return false;
  }
}

export async function verifyPeptideuConnection(): Promise<boolean> {
  if (!peptidePool) {
    console.warn("[OPS DB] PEPTIDEU_DATABASE_URL not set — PeptideU section disabled");
    return false;
  }
  try {
    await peptidePool.query("SELECT 1");
    console.log("[OPS DB] Connected to PeptideU (Supabase) database");
    return true;
  } catch (error: any) {
    console.error("[OPS DB] PeptideU connection failed:", error.message);
    return false;
  }
}
