import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import fs from "fs";
import { verifyConnection, pool } from "./db";
import { registerRoutes } from "./routes";
import { registerTrackingRoutes } from "./tracking";
import { registerGoogleAuthRoutes } from "./google-auth";
import { registerAdminAuthRoutes, opsGate } from "./admin-auth";
import { registerKlaviyoRoutes } from "./klaviyo";
import { registerEconomicsRoutes } from "./economics";
import { registerEmailComposeRoutes } from "./email-compose";
import { registerSettingsRoutes } from "./settings";
import { registerMetaAdsRoutes } from "./meta-ads";
import { registerAdminActionsRoutes } from "./admin-actions";
import { registerLeadsRoutes } from "./leads";
import { registerClomarkRoutes } from "./clomark";
import { registerDirtRoutes, startDirtScanLoop, startDirtDailyReportLoop } from "./dirt";
import { registerIntegrationsRoutes } from "./integrations";
import { registerProjectRoutes } from "./projects";
import { registerChatRoutes } from "./chat";
import { registerContentRoutes } from "./content";
import { registerTicketRoutes } from "./tickets";
import { registerReportsRoutes, startEmailReportWarmer } from "./reports";
import { registerDmarcRoutes } from "./dmarc";
import { registerLabsRoutes } from "./labs";
import { registerSupplementsRoutes } from "./supplements";
import { registerPeptideURoutes } from "./peptideu";
import { verifyPeptideuConnection } from "./db";
import { registerPawgenRoutes } from "./pawgen";
import { registerRealPeptidesRoutes } from "./realpeptides";
import { registerRealPeptidesOrders } from "./realpeptides-orders";
import { registerRpInventoryRoutes, startRpInventorySyncLoop } from "./realpeptides-inventory";
import { registerRealPeptidesEmail } from "./realpeptides-email";
import { registerRealPeptidesContacts } from "./realpeptides-contacts";
import { registerRpImageSync, startRpImageSyncLoop } from "./realpeptides-images";
import { registerTasksRoutes } from "./tasks";
import { registerEmailPlannerRoutes } from "./email-planner";
import { registerRealPeptidesWholesale } from "./realpeptides-wholesale";
import { registerPagesRoutes } from "./pages";
import { verifyPawgenConnection } from "./db";

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

// Health check (public)
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "fitscript-ops", timestamp: new Date().toISOString() });
});

// Admin auth routes register BEFORE the gate so they stay reachable.
registerAdminAuthRoutes(app);

// Gate every /api/ops/* (except /api/ops/auth/*) behind admin session.
// /api/t/* (tracking pixel ingest) stays public.
app.use(opsGate);

// Register protected API routes
registerRoutes(app);
registerTrackingRoutes(app);
registerGoogleAuthRoutes(app);
registerKlaviyoRoutes(app);
registerEconomicsRoutes(app);
registerEmailComposeRoutes(app);
registerSettingsRoutes(app);
registerMetaAdsRoutes(app);
registerAdminActionsRoutes(app);
registerLeadsRoutes(app);
registerClomarkRoutes(app);
registerDirtRoutes(app);
registerIntegrationsRoutes(app);
registerProjectRoutes(app);
registerChatRoutes(app);
registerContentRoutes(app);
registerTicketRoutes(app);
registerReportsRoutes(app);
registerDmarcRoutes(app);
registerLabsRoutes(app);
registerSupplementsRoutes(app);
registerPeptideURoutes(app);
registerPawgenRoutes(app);
registerRealPeptidesRoutes(app);
registerRealPeptidesOrders(app);
registerRpInventoryRoutes(app);
registerRealPeptidesEmail(app);
registerRealPeptidesContacts(app);
registerRpImageSync(app);
  registerTasksRoutes(app);
  registerEmailPlannerRoutes(app);
registerRealPeptidesWholesale(app);
registerPagesRoutes(app);

// Catch idle-TCP errors on the pg pool so they don't crash the process.
pool.on("error", (err) => {
  console.warn("[OPS DB] pool error:", err.message);
});

async function setupClient() {
  if (process.env.NODE_ENV === "production") {
    const publicDir = path.resolve(import.meta.dirname, "public");
    if (fs.existsSync(publicDir)) {
      app.use(express.static(publicDir));
      app.get("*", (_req, res) => {
        res.sendFile(path.join(publicDir, "index.html"));
      });
    }
    return;
  }

  // Dev: mount Vite as middleware so the React app + HMR ride on the
  // same port as the API. No separate vite dev server, no proxy.
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
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
  await verifyPeptideuConnection(); // non-fatal — PeptideU section degrades gracefully
  await verifyPawgenConnection(); // non-fatal — pawgen section degrades gracefully
  await setupClient();

  app.listen(PORT, () => {
    console.log(`[OPS] FitScript Ops Dashboard running on http://localhost:${PORT}`);
    startDirtScanLoop();
    startDirtDailyReportLoop();
    startEmailReportWarmer();
    startRpInventorySyncLoop();
    startRpImageSyncLoop();
  });
}

start();
