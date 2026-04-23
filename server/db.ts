/**
 * Database connection — shares the same RDS as the main FitScript app.
 * Same DATABASE_URL, same tables, read/write access.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL must be set. This connects to the same RDS as the main FitScript app.");
}

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes("neon.tech") ? { rejectUnauthorized: false } : undefined,
});

export const db = drizzle(pool, { schema });
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
