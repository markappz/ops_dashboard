// One-shot prod sync from Justin's master sheet (2026-08-26):
//   1. adds the 8 products missing from the tracker
//   2. seeds current_stock (via the audited stock route) + ideal_stock for every matched SKU
// Run from ~/Projects/ops-dashboard:  node <path-to>/sync-master-sheet.mjs
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { readFileSync } from "fs";

const SHEET = [{"name": "5 Amino 1mq", "sku": "RP-5amino50C", "current": 0, "ideal": 28}, {"name": "5 Amino 1mq - 10mg (Injectable)", "sku": "RP-5amino10V", "current": 225, "ideal": 80}, {"name": "5 Amino 1mq - 50mg (Injectable)", "sku": "RP-5amino50V", "current": 222, "ideal": 256}, {"name": "Adamax Peptide 10mg", "sku": "RP-Ada10V", "current": 49, "ideal": 31}, {"name": "AHK-CU - 1g", "sku": "RP-AHK1V", "current": 80, "ideal": 42}, {"name": "AOD-9604 - 10mg", "sku": "RP-AOD10V", "current": 270, "ideal": 437}, {"name": "ARA-290 - 10mg", "sku": "RP-ARA10V", "current": 0, "ideal": 0}, {"name": "Bacteriostatic Reconstitution Water (BAC) - 10ml", "sku": "RP-BAC10V", "current": 1287, "ideal": 2496}, {"name": "BPC-157 10mg", "sku": "RP-BPC10V", "current": 766, "ideal": 943}, {"name": "BPC-157 Capsules", "sku": "RP-BPC500C", "current": 100, "ideal": 13}, {"name": "Cagrilintide - 10mg", "sku": "RP-CAGR10V", "current": 8, "ideal": 19}, {"name": "Cartalax - 20mg", "sku": "RP-Cart20V", "current": 138, "ideal": 150}, {"name": "Cerebrolysin - 60mg", "sku": "RP-CERE60V", "current": 59, "ideal": 12}, {"name": "CJC 1295 (no dac) - 10mg", "sku": "RP-CJC10V", "current": 99, "ideal": 173}, {"name": "CJC 1295 (no dac) - 5mg", "sku": "RP-CJC5V", "current": 167, "ideal": 41}, {"name": "CJC-1295 + Ipamorelin (5mg/5mg)", "sku": "RP-CJCIPA55V", "current": 397, "ideal": 795}, {"name": "Copper Peptide Rejuvenation Serum", "sku": "RP-CPRS1S", "current": 0, "ideal": 206}, {"name": "Dihexa Capsules - 10mg (100 capsules)", "sku": "RP-DIHE10C", "current": 0, "ideal": 0}, {"name": "DSIP - 5mg", "sku": "RP-DSIP5V", "current": 241, "ideal": 211}, {"name": "Epithalon (Epitalon) - 10mg", "sku": "RP-EPIT10V", "current": 406, "ideal": 641}, {"name": "FOXO4-DRI - 10mg", "sku": "RP-FOXO10V", "current": 58, "ideal": 19}, {"name": "GHK-Cu  Cosmetic - 1g", "sku": "RP-GHK1V", "current": 90, "ideal": 176}, {"name": "GHK-Cu Copper Peptide - 100mg", "sku": "RP-GHK100V", "current": 427, "ideal": 365}, {"name": "GHK-Cu Copper Peptide - 50mg", "sku": "RP-GHK50V", "current": 356, "ideal": 713}, {"name": "GHRP-2 - 10mg", "sku": "RP-GHRP210V", "current": 85, "ideal": 15}, {"name": "GHRP-6 - 10mg", "sku": "RP-GHRP610V", "current": 161, "ideal": 10}, {"name": "GLOW Stack", "sku": "RP-GLOW50V", "current": 464, "ideal": 312}, {"name": "Glutathione - 600mg", "sku": "RP-GLUT600V", "current": 0, "ideal": 208}, {"name": "Glutathione - 1500mg", "sku": "RP-GLUT1500V", "current": null, "ideal": null}, {"name": "GLYCON-X\u2122 - 15mg", "sku": "RP-TRIZ15V", "current": 313, "ideal": 127}, {"name": "GLYCON-X\u2122 - 30mg", "sku": "RP-TRIZ30V", "current": 164, "ideal": 55}, {"name": "GLYCON-X\u2122 - 60mg", "sku": "RP-TRIZ60V", "current": 44, "ideal": 17}, {"name": "Hexarelin - 5mg", "sku": "RP-HEXA5V", "current": 42, "ideal": 22}, {"name": "HHB (Radiance)", "sku": "RP-HHBV", "current": 58, "ideal": 46}, {"name": "IGF-1 LR3 - 0.1mg", "sku": "RP-IGF01V", "current": 1, "ideal": 7}, {"name": "IGF-1 LR3 - 1mg", "sku": "RP-IGF1V", "current": 126, "ideal": 170}, {"name": "Ipamorelin - 10mg", "sku": "RP-IPAM10V", "current": 524, "ideal": 278}, {"name": "Kisspeptin-10 - 10mg", "sku": "RP-KISS10V", "current": 406, "ideal": 126}, {"name": "KLOW", "sku": "RP-KLOW80V", "current": 220, "ideal": 785}, {"name": "KPV - 10mg", "sku": "RP-KPV10V", "current": 70, "ideal": 413}, {"name": "LC 526 (Lipo-MIC)", "sku": "RP-LC526-V", "current": 116, "ideal": 94}, {"name": "LIPO-C - 10ml", "sku": "RP-LIPO10V", "current": 25, "ideal": 53}, {"name": "LL-37 - 5mg", "sku": "RP-LL375V", "current": 35, "ideal": 56}, {"name": "Mazdutide Peptide", "sku": "RP-MAZD12V", "current": 35, "ideal": 20}, {"name": "Melanotan 2 (MT2) - 10mg", "sku": "RP-MELA210V", "current": 190, "ideal": 202}, {"name": "Melanotan-1 - 10mg", "sku": "RP-MELA110V", "current": 204, "ideal": 91}, {"name": "MK-677", "sku": "RP-MK6710C", "current": 50, "ideal": 0}, {"name": "MOTS-c - 10mg", "sku": "RP-MOTS10V", "current": 1637, "ideal": 1865}, {"name": "MOTS-c - 40mg", "sku": "RP-MOTS40V", "current": 231, "ideal": 229}, {"name": "MOTS-c Liquid Spray - 25mg", "sku": "RP-MOT25-NS", "current": 70, "ideal": 57}, {"name": "NAD+ - 1000mg", "sku": "RP-NAD1000V", "current": 162, "ideal": 273}, {"name": "NAD+ - 500mg", "sku": "RP-NAD500V", "current": 577, "ideal": 502}, {"name": "Orforglipron Capsules", "sku": null, "current": 153, "ideal": 7}, {"name": "Oxytocin - 10mg", "sku": "RP-OXYT10V", "current": 52, "ideal": 76}, {"name": "Oxytocin - 5mg", "sku": "RP-OXYT5V", "current": 87, "ideal": 71}, {"name": "P21 - 5mg", "sku": "RP-P215V", "current": 74, "ideal": 4}, {"name": "PE-22-28 (8mg) - 8mg", "sku": "RP-PE228V", "current": 49, "ideal": 53}, {"name": "Pinealon - 10mg", "sku": "RP-PINE10V", "current": 67, "ideal": 398}, {"name": "PT-141  (Bremelanotide) - 10mg", "sku": "RP-PT1410V", "current": 306, "ideal": 209}, {"name": "Retatrutide (Trinity-X) - 10mg", "sku": "RP-RETA10V", "current": 1791, "ideal": 3388}, {"name": "Retatrutide (Trinity-X) - 20mg", "sku": "RP-RETA20V", "current": 250, "ideal": 1346}, {"name": "Selank Amidate - 10mg", "sku": "RP-SELA10V", "current": 193, "ideal": 275}, {"name": "Selank Liquid Spray \u2014 45mg", "sku": "RP-SEL-NS", "current": 3, "ideal": 194}, {"name": "Semax Amidate - 10mg", "sku": "RP-SEMA10V", "current": 364, "ideal": 259}, {"name": "Semax Liquid Spray \u2014 45mg", "sku": "RP-SEM-NS", "current": -1, "ideal": 268}, {"name": "Sermorelin - 10mg", "sku": "RP-SERM10V", "current": 278, "ideal": 19}, {"name": "SHB (Endure)", "sku": "RP-SHBV", "current": 61, "ideal": 47}, {"name": "SLU-PP-332 Capsules (SLOOP) - 250mcg (100 Capsules)", "sku": "RP-SSLU250C", "current": 98, "ideal": 0}, {"name": "Snap-8 - 10mg", "sku": "RP-SNAP10V", "current": 84, "ideal": 55}, {"name": "SS-31 (Elamipretide) - 10mg", "sku": "RP-SS3110V", "current": 241, "ideal": 642}, {"name": "SS-31 (Elamipretide) - 50mg", "sku": "RP-SS3150V", "current": 122, "ideal": 268}, {"name": "Survodutide - 12mg", "sku": "RP-SURV12V", "current": 50, "ideal": 6}, {"name": "TB-500 (Thymosin Beta-4) - 10mg", "sku": "RP-TB5010V", "current": 515, "ideal": 449}, {"name": "Tesamorelin + Ipamorelin Blend - 10mg/3mg", "sku": "RP-TESAIPA103V", "current": 591, "ideal": 921}, {"name": "Tesamorelin + Ipamorelin Blend - 10mg/5mg", "sku": "RP-TESAIPA105V", "current": -3, "ideal": 3}, {"name": "Tesamorelin + Ipamorelin Blend - 12mg/3mg", "sku": "RP-TESAIPA123V", "current": 0, "ideal": 1774}, {"name": "Tesamorelin 10mg - 10mg", "sku": "RP-TESA10V", "current": 761, "ideal": 1263}, {"name": "Tesofensine Tablets", "sku": "RP-TESO10V", "current": 108, "ideal": 24}, {"name": "Thymalin - 10mg", "sku": "RP-THYM10V", "current": 144, "ideal": 71}, {"name": "Thymosin Alpha 1 - 10mg", "sku": "RP-THYAL10V", "current": 152, "ideal": 230}, {"name": "VIP - 5mg", "sku": "RP-VIP5V", "current": 64, "ideal": 82}, {"name": "Wolverine Peptide Stack - BPC-157 10mg / TB-500 10mg", "sku": "RP-WOLV10V", "current": 662, "ideal": 1148}, {"name": "Wolverine Peptide Stack - BPC-157 5mg / TB-500 5mg", "sku": "RP-WOLV5V", "current": 348, "ideal": 254}];
const env = Object.fromEntries(readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const c = new SecretsManagerClient({ region: env.AWS_REGION || "us-east-1", credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } });
const tok = JSON.parse((await c.send(new GetSecretValueCommand({ SecretId: "prod/ops-secrets" }))).SecretString).COA_OPS_TOKEN;
const BASE = "https://coa.realpeptides.co/api";
const H = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
const call = (path, method = "GET", body) =>
  fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

// Justin 2026-08-26: rename before adding/seeding so sheet SKUs match.
//  - MOTS-c nasal spray's real SKU is RP-MOT25-NS (website may need the same fix)
//  - Orforglipron's real SKU is RP-ORFO12C (was placeholder PID-8207)
const RENAME = [
  ["RP-MOT-NS", "RP-MOT25-NS"],
  ["PID-8207", "RP-ORFO12C", "Orforglipron Capsules"],
];
// Justin: discontinued — ARA-290 16mg (10mg is the keeper), Sermorelin 5mg (10mg only).
const DISCONTINUE = ["RP-ARA16V", "RP-SERM5V"];

const ADD = [
  ["RP-ARA10V", "ARA-290 - 10mg"],
  ["RP-CPRS1S", "Copper Peptide Rejuvenation Serum"],
  ["RP-DIHE10C", "Dihexa Capsules - 10mg (100 capsules)"],
  ["RP-GLUT1500V", "Glutathione - 1500mg"],
  ["RP-OXYT10V", "Oxytocin - 10mg"],
  ["RP-SERM10V", "Sermorelin - 10mg"],
  ["RP-TESAIPA123V", "Tesamorelin + Ipamorelin Blend - 12mg/3mg"],
  ["RP-TESO10V", "Tesofensine Tablets"],
];
{
  const { body: pre } = await call("/skus");
  const preByCode = new Map(pre.skus.map((s) => [s.sku_code.toUpperCase(), s]));
  for (const [from, to, newName] of RENAME) {
    const sku = preByCode.get(from.toUpperCase());
    if (!sku) { console.log("rename skip (not found):", from); continue; }
    const r = await call(`/skus/${sku.id}`, "PATCH", newName ? { sku_code: to, product_name: newName } : { sku_code: to });
    console.log("rename", r.status, `${from} → ${to}`, r.body.error ?? "");
  }
  for (const code of DISCONTINUE) {
    const sku = preByCode.get(code.toUpperCase());
    if (!sku) { console.log("discontinue skip (not found):", code); continue; }
    const r = await call(`/skus/${sku.id}`, "DELETE");
    console.log("discontinue", r.status, code, r.body.error ?? "");
  }
}

for (const [sku_code, product_name] of ADD) {
  const r = await call("/skus", "POST", { sku_code, product_name });
  console.log("add", r.status, sku_code, r.body.id ?? r.body.error);
}

const { body: list } = await call("/skus");
const byCode = new Map(list.skus.map((s) => [s.sku_code.toUpperCase(), s]));
let stocked = 0, idealed = 0, missed = [];
for (const row of SHEET) {
  if (!row.sku) { missed.push(row.name); continue; }
  const sku = byCode.get(row.sku.toUpperCase());
  if (!sku) { missed.push(`${row.sku} ${row.name}`); continue; }
  if (Number.isFinite(Number(row.current))) {
    const r = await call(`/skus/${sku.id}/stock`, "POST", { set: Number(row.current), note: "master sheet 2026-08-26", by: "sheet-sync" });
    if (r.status === 200) stocked++; else console.log("stock FAIL", row.sku, r.status, r.body.error);
  }
  if (Number.isFinite(Number(row.ideal))) {
    const r = await call(`/skus/${sku.id}`, "PATCH", { ideal_stock: Number(row.ideal) });
    if (r.status === 200) idealed++; else console.log("ideal FAIL", row.sku, r.status, r.body.error);
  }
}
console.log(`\nseeded stock on ${stocked}, targets on ${idealed}; unmatched:`, missed.length ? missed : "none");
const after = await call("/skus");
console.log("prod SKUs:", after.body.skus.length);
