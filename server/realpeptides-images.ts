/**
 * Product images for the COA tracker, filled from the site's own catalog.
 *
 * The storefront already has a photo for every variant; the tracker only had
 * one when someone uploaded it by hand, so the Inventory tab showed blanks.
 * Every 6h (and on demand) this matches tracker SKUs to site variants by SKU
 * code, downloads the storefront image and files it as a `product_image`
 * document — the same path a manual upload takes. Each upload is tagged with
 * the image URL it came from, so when the site's photo changes (a re-shoot)
 * the next run replaces it; `force` re-pulls everything regardless.
 */
import type { Express } from "express";

const EVERY_MS = 6 * 60 * 60_000;
const MAX_PER_RUN = 60;

export interface ImageSyncResult {
  at: string;
  checked: number;
  uploaded: number;
  replaced: number;
  forced: boolean;
  missing: string[];   // tracker products with no image and no site match
  failed: string[];
  error?: string;
}

let lastRun: ImageSyncResult | null = null;
let running = false;

function siteCfg() {
  const base = process.env.RP_SITE_API_URL;
  const token = process.env.RP_SITE_OPS_TOKEN;
  return base && token ? { base: base.replace(/\/$/, ""), token } : null;
}
function trackerCfg() {
  const token = process.env.COA_OPS_TOKEN;
  return token ? { base: (process.env.COA_API_URL || "https://coa.realpeptides.co").replace(/\/$/, ""), token } : null;
}

async function getJson(url: string, token: string): Promise<any> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${url} → ${r.status}: ${text.slice(0, 120)}`);
  return JSON.parse(text);
}

const norm = (s: string) => s.trim().toUpperCase();

/** Site image keyed by SKU code; variants with no image are skipped. */
async function siteImages(): Promise<Map<string, { image: string; name: string }>> {
  const cfg = siteCfg();
  if (!cfg) throw new Error("site not configured");
  const j = await getJson(`${cfg.base}/api/ops-catalog`, cfg.token);
  const map = new Map<string, { image: string; name: string }>();
  for (const v of j.variants ?? []) if (v.sku && v.image) map.set(norm(v.sku), { image: v.image, name: v.name });
  return map;
}

async function uploadImage(skuId: number, name: string, imageUrl: string): Promise<void> {
  const tracker = trackerCfg()!;
  const img = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });
  if (!img.ok) throw new Error(`image ${img.status}`);
  const type = img.headers.get("content-type") || "image/jpeg";
  const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
  const fd = new FormData();
  fd.append("file", new Blob([await img.arrayBuffer()], { type }), `${name.replace(/[^\w.-]+/g, "_")}.${ext}`);
  fd.append("sku_id", String(skuId));
  fd.append("category", "product_image");
  fd.append("source", "site-sync");
  fd.append("source_ref", imageUrl);
  const r = await fetch(`${tracker.base}/api/documents`, {
    method: "POST", headers: { Authorization: `Bearer ${tracker.token}` }, body: fd, signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`tracker ${r.status}: ${(await r.text()).slice(0, 120)}`);
}

/** A SKU needs a pull when it has no image, the site's photo URL changed since we filed one, or the caller forces it. */
function needsPull(s: any, siteImage: string | undefined, force: boolean): boolean {
  if (!s.image_doc_id) return true;
  if (!siteImage) return false;
  if (force) return true;
  return !!s.image_source_ref && s.image_source_ref !== siteImage;
}

export async function runRpImageSync(force = false): Promise<ImageSyncResult> {
  if (running && lastRun) return lastRun;
  running = true;
  const result: ImageSyncResult = { at: new Date().toISOString(), checked: 0, uploaded: 0, replaced: 0, forced: force, missing: [], failed: [] };
  try {
    const tracker = trackerCfg();
    if (!tracker) throw new Error("tracker not configured");
    const [images, skus] = await Promise.all([siteImages(), getJson(`${tracker.base}/api/skus`, tracker.token)]);
    const all: any[] = skus.skus ?? [];
    const todo = all.filter((s) => needsPull(s, (images.get(norm(s.sku_code)) ?? (s.coa_name ? images.get(norm(s.coa_name)) : undefined))?.image, force));
    result.checked = todo.length;
    for (const s of todo.slice(0, force ? 500 : MAX_PER_RUN)) {
      const hit = images.get(norm(s.sku_code)) ?? (s.coa_name ? images.get(norm(s.coa_name)) : undefined);
      if (!hit) { result.missing.push(s.product_name); continue; }
      try {
        await uploadImage(s.id, s.product_name, hit.image);
        if (s.image_doc_id) result.replaced++; else result.uploaded++;
      } catch (e: any) { result.failed.push(`${s.product_name}: ${e.message}`); }
    }
    console.log(`[OPS][RP] image sync${force ? " (forced)" : ""}: ${result.uploaded} new, ${result.replaced} replaced, ${result.missing.length} without a site image, ${result.failed.length} failed`);
  } catch (e: any) {
    result.error = e.message;
    console.error("[OPS][RP] image sync:", e.message);
  } finally {
    running = false;
  }
  lastRun = result;
  return result;
}

export function startRpImageSyncLoop() {
  if (!siteCfg() || !trackerCfg()) return;
  setTimeout(runRpImageSync, 30_000);
  setInterval(runRpImageSync, EVERY_MS);
}

export function registerRpImageSync(app: Express) {
  app.get("/api/ops/realpeptides/inventory/images", (_req, res) => res.json({ last: lastRun }));
  app.post("/api/ops/realpeptides/inventory/images/sync", async (req, res) => {
    try { res.json(await runRpImageSync(String(req.query.force || "") === "1")); }
    catch (e: any) { res.status(502).json({ error: e.message }); }
  });
}
