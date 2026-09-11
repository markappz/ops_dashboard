/**
 * Add SKU: one form → the storefront AND the inventory tracker.
 *
 * Until 2026-09-11 "Add product" only created the tracker row; the site's
 * stock sync then skipped the SKU (no site variant carried it) and the dose
 * never reached the store. Now the site is written FIRST, via
 * POST /api/ops-catalog/sku — a new dose becomes a Variant under its parent
 * product (picked from the site's own list), or a brand-new product goes in
 * as a DRAFT with its first variant. Only when the site says 201 does the
 * tracker SKU get created, so the two catalogues can't drift from this path.
 */
import type { Express, Request, Response } from "express";
import multer from "multer";
import { runRpImageSync } from "./realpeptides-images";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const PRODUCTS_TTL_MS = 60_000;

export interface SiteProduct { id: string; name: string; slug: string; status: string; image: string | null; variantCount: number }

let productsCache: { at: number; products: SiteProduct[] } | null = null;

function siteCfg() {
  const base = process.env.RP_SITE_API_URL;
  const token = process.env.RP_SITE_OPS_TOKEN;
  if (!base || !token) throw new Error("RP_SITE_API_URL / RP_SITE_OPS_TOKEN are not set on ops");
  return { base: base.replace(/\/$/, ""), token };
}
function trackerCfg() {
  const token = process.env.COA_OPS_TOKEN;
  if (!token) throw new Error("COA_OPS_TOKEN is not set on ops");
  return { base: (process.env.COA_API_URL || "https://coa.realpeptides.co").replace(/\/$/, ""), token };
}

async function callJson(url: string, token: string, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  const r = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text.slice(0, 200) }; }
  return { status: r.status, json };
}

export async function siteProducts(force = false): Promise<SiteProduct[]> {
  if (!force && productsCache && Date.now() - productsCache.at < PRODUCTS_TTL_MS) return productsCache.products;
  const cfg = siteCfg();
  const { status, json } = await callJson(`${cfg.base}/api/ops-catalog`, cfg.token);
  if (status !== 200) throw new Error(`site catalog → ${status}: ${json.error ?? "unknown"}`);
  if (!Array.isArray(json.products)) throw new Error("site catalog has no product list — the site build with POST /api/ops-catalog/sku isn't deployed yet");
  productsCache = { at: Date.now(), products: json.products };
  return productsCache.products;
}

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());
const num = (v: unknown) => (str(v) === "" ? null : Number(str(v)));
const bool = (v: unknown, dflt: boolean) => (str(v) === "" ? dflt : ["1", "true", "on", "yes"].includes(str(v).toLowerCase()));

interface AddSkuInput {
  sku: string; label: string; price: number; compareAt: number | null; weightGrams: number | null; packEligible: boolean;
  parentProductId: string; newProductName: string; productName: string;
  supplier: string | null; idealStock: number | null; coverWeeks: number | null; alias: string | null; initialStock: number | null; requiresCoa: boolean;
}

function parseInput(b: Record<string, unknown>): AddSkuInput | string {
  const i: AddSkuInput = {
    sku: str(b.sku_code), label: str(b.variant_label), price: str(b.price) === "" ? NaN : Number(str(b.price)), compareAt: num(b.compare_at),
    weightGrams: num(b.weight_grams), packEligible: bool(b.pack_eligible, false),
    parentProductId: str(b.site_product_id), newProductName: str(b.new_product_name), productName: str(b.product_name),
    supplier: str(b.supplier) || null, idealStock: num(b.ideal_stock), coverWeeks: num(b.cover_weeks), alias: str(b.coa_name) || null,
    initialStock: num(b.initial_stock), requiresCoa: bool(b.requires_coa, true),
  };
  if (!i.sku) return "SKU code is required.";
  if (!i.label) return "Variant label (the dose or form, e.g. 20mg) is required.";
  if (!Number.isFinite(i.price) || i.price <= 0) return "Price is required and must be above $0.";
  if (!i.parentProductId && !i.newProductName) return "Pick the parent product on the site, or name the new product.";
  if (i.parentProductId && i.newProductName) return "Pick a parent product OR name a new one, not both.";
  for (const [k, v] of [["Compare-at", i.compareAt], ["Weight", i.weightGrams], ["Target", i.idealStock], ["Cover weeks", i.coverWeeks], ["Starting stock", i.initialStock]] as const) {
    if (v !== null && (!Number.isFinite(v) || v < 0)) return `${k} must be a non-negative number.`;
  }
  if (i.weightGrams !== null && !Number.isInteger(i.weightGrams)) return "Weight must be whole grams.";
  if (i.initialStock !== null && !Number.isInteger(i.initialStock)) return "Starting stock must be a whole number.";
  return i;
}

function imagePayload(file: Express.Multer.File | undefined): { data: string; filename: string; mimeType: string } | null | string {
  if (!file) return null;
  if (!IMAGE_TYPES.has(file.mimetype)) return "Product photo must be a JPG, PNG, WebP or GIF.";
  return { data: file.buffer.toString("base64"), filename: file.originalname || "product.jpg", mimeType: file.mimetype };
}

async function createOnSite(i: AddSkuInput, image: ReturnType<typeof imagePayload>, by: string) {
  const cfg = siteCfg();
  const body = {
    sku: i.sku, label: i.label, price: i.price, compareAt: i.compareAt, weightGrams: i.weightGrams, packEligible: i.packEligible,
    stock: i.initialStock ?? 0, image: typeof image === "string" ? null : image, by,
    ...(i.parentProductId ? { parentProductId: i.parentProductId } : { newProduct: { name: i.newProductName } }),
  };
  const { status, json } = await callJson(`${cfg.base}/api/ops-catalog/sku`, cfg.token, { method: "POST", body: JSON.stringify(body) });
  if (status === 201) return json as { created: "variant" | "product"; product: { id: string; name: string; slug: string; status: string; url: string }; variant: { id: string; sku: string; label: string } };
  const msg = json.error ?? `site returned ${status}`;
  throw Object.assign(new Error(status === 409 ? msg : `Site refused the SKU: ${msg}`), { status: status >= 400 && status < 500 ? status : 502 });
}

async function createOnTracker(i: AddSkuInput, site: Awaited<ReturnType<typeof createOnSite>>, by: string) {
  const cfg = trackerCfg();
  const { status, json } = await callJson(`${cfg.base}/api/skus`, cfg.token, { method: "POST", body: JSON.stringify({
    product_name: i.productName || `${site.product.name} - ${i.label}`, sku_code: i.sku, product_url: site.product.url, requires_coa: i.requiresCoa,
    supplier: i.supplier, ideal_stock: i.idealStock, cover_weeks: i.coverWeeks, coa_name: i.alias, initial_stock: i.initialStock, by,
  }) });
  if (status !== 200) throw Object.assign(new Error(`Site variant created, but the inventory row failed: ${json.error ?? status}. Add the SKU again — the site side will be reused.`), { status: 502, siteDone: true });
  return json;
}

export function registerRpCatalogRoutes(app: Express) {
  app.get("/api/ops/realpeptides/catalog/products", async (req: Request, res: Response) => {
    try { res.json({ products: await siteProducts(String(req.query.refresh || "") === "1") }); }
    catch (e: any) { res.status(502).json({ error: e.message }); }
  });

  app.post("/api/ops/realpeptides/catalog/sku", upload.single("image"), async (req: any, res: Response) => {
    const input = parseInput(req.body ?? {});
    if (typeof input === "string") return res.status(400).json({ error: input });
    const image = imagePayload(req.file);
    if (typeof image === "string") return res.status(400).json({ error: image });
    const by = req.adminEmail || "ops";
    try {
      const site = await createOnSite(input, image, by);
      const sku = await createOnTracker(input, site, by);
      productsCache = null;
      runRpImageSync(false).catch(() => {});
      console.log(`[OPS][RP] Add SKU: ${input.sku} → site ${site.created} ${site.product.slug} + tracker #${sku.id} by ${by}`);
      res.json({ site, sku });
    } catch (e: any) {
      console.error(`[OPS][RP] Add SKU ${input.sku}:`, e?.message ?? e);
      res.status(e?.status ?? 500).json({ error: e?.message ?? "Add SKU failed" });
    }
  });
}
