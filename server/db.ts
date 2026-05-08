/**
 * Database connection — shares the same RDS as the main FitScript app.
 * Raw SQL only via pool.query. Drizzle is intentionally not used here
 * (see DECISIONS.md — "Raw SQL only, no Drizzle in this repo").
 */
import pg from "pg";

const { Pool } = pg;

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
