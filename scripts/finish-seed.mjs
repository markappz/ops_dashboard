// Final three seed rows: two oversold-on-sheet SKUs floored to 0, and Orforglipron
// (sheet row had no SKU until the RP-ORFO12C rename). Run from ~/Projects/ops-dashboard.
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { readFileSync } from "fs";
const env = Object.fromEntries(readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const c = new SecretsManagerClient({ region: env.AWS_REGION || "us-east-1", credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } });
const tok = JSON.parse((await c.send(new GetSecretValueCommand({ SecretId: "prod/ops-secrets" }))).SecretString).COA_OPS_TOKEN;
const BASE = "https://coa.realpeptides.co/api";
const H = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
const call = (p, m, b) => fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const { body: list } = await call("/skus", "GET");
const byCode = new Map(list.skus.map((s) => [s.sku_code.toUpperCase(), s]));
const ROWS = [
  ["RP-SEM-NS", 0, null, "sheet shows -1 (oversold); floored to 0"],
  ["RP-TESAIPA105V", 0, null, "sheet shows -3 (oversold); floored to 0"],
  ["RP-ORFO12C", 153, 7, "master sheet 2026-08-26"],
];
for (const [code, stock, ideal, note] of ROWS) {
  const sku = byCode.get(code);
  if (!sku) { console.log("skip (not found):", code); continue; }
  const r1 = await call(`/skus/${sku.id}/stock`, "POST", { set: stock, note, by: "sheet-sync" });
  console.log("stock", r1.status, code, "→", stock, r1.body.error ?? "");
  if (ideal !== null) {
    const r2 = await call(`/skus/${sku.id}`, "PATCH", { ideal_stock: ideal });
    console.log("target", r2.status, code, "→", ideal, r2.body.error ?? "");
  }
}
