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

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes("neon.tech") ? { rejectUnauthorized: false } : undefined,
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
