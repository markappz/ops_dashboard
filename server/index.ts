import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import fs from "fs";
import { verifyConnection, pool } from "./db";
import { registerRoutes } from "./routes";
import { registerTrackingRoutes } from "./tracking";
import { registerGoogleAuthRoutes } from "./google-auth";

const app = express();
const PORT = parseInt(process.env.OPS_PORT || "5001");

app.use(express.json());
app.use(cookieParser());

// Security headers
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  next();
});

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "fitscript-ops", timestamp: new Date().toISOString() });
});

// Register API routes
registerRoutes(app);
registerTrackingRoutes(app);
registerGoogleAuthRoutes(app);

// Serve static files in production
if (process.env.NODE_ENV === "production") {
  const publicDir = path.resolve(import.meta.dirname, "public");
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(publicDir, "index.html"));
    });
  }
}

async function ensureTrackingTables() {
  try {
    const schemaPath = path.resolve(import.meta.dirname, "tracking-schema.sql");
    if (fs.existsSync(schemaPath)) {
      const sql = fs.readFileSync(schemaPath, "utf-8");
      await pool.query(sql);
      console.log("[OPS] Tracking tables verified");
    }
  } catch (error: any) {
    console.warn("[OPS] Tracking tables setup warning:", error.message);
  }
}

async function start() {
  const dbOk = await verifyConnection();
  if (!dbOk) {
    console.error("[OPS] Cannot start without database connection");
    process.exit(1);
  }

  await ensureTrackingTables();

  app.listen(PORT, () => {
    console.log(`[OPS] FitScript Ops Dashboard running on http://localhost:${PORT}`);
  });
}

start();
