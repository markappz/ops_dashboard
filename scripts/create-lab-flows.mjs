/**
 * Creates FitScript lab-lifecycle email flows in Klaviyo via API.
 * Each: branded CODE template (camelCase event vars matching our code) + a
 * metric-triggered flow, created in manual/draft so NOTHING sends until review.
 *
 *   node scripts/create-lab-flows.mjs           # create all
 *   node scripts/create-lab-flows.mjs --verify  # list lab flows + triggers
 *
 * Uses ops dashboard KLAVIYO_API_KEY (has flow-write scope).
 */
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=")).map((l) => {
      const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
const KEY = env.KLAVIYO_API_KEY;
const REV_W = "2025-07-15"; // flow create
const REV = "2024-10-15";   // everything else
const FROM_EMAIL = "paulc@fitscript.me";
const FROM_LABEL = "FitScript";
const APP = "https://fitscript.me";

async function k(path, { method = "GET", body, rev = REV } = {}) {
  const res = await fetch(`https://a.klaviyo.com/api${path}`, {
    method,
    headers: {
      Authorization: `Klaviyo-API-Key ${KEY}`,
      revision: rev, accept: "application/json", "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

// Branded FitScript HTML email — DM Sans, green gradient CTA, white surface.
function html({ heroTitle, bodyHtml, ctaText, ctaUrl }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<style>body{margin:0;padding:0;background:#f4f6f8;font-family:'DM Sans',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:600px;margin:0 auto;padding:32px 16px}
.card{background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e6eaee}
.px{padding:0 40px}
.brand{font-size:20px;font-weight:700;color:#0EA57A;letter-spacing:.04em;padding:28px 40px 8px}
.h1{font-size:26px;line-height:32px;font-weight:700;color:#111827;margin:16px 0 12px}
.body{font-size:16px;line-height:26px;color:#374151;margin:0 0 24px}
.btn{display:inline-block;background:linear-gradient(135deg,#0EA57A,#34D399 55%,#60A5FA);color:#ffffff !important;text-decoration:none;font-weight:600;font-size:16px;padding:14px 28px;border-radius:10px}
.foot{font-size:12px;line-height:18px;color:#9aa4b2;padding:24px 40px 32px;text-align:center}
a{color:#0EA57A}</style></head>
<body><div style="display:none;max-height:0;overflow:hidden;color:transparent;">{{ event.panelName }}</div>
<div class="wrap"><div class="card">
<div class="brand">FITSCRIPT</div>
<div class="px"><h1 class="h1">${heroTitle}</h1><p class="body">${bodyHtml}</p>
<p style="margin:0 0 32px"><a class="btn" href="${ctaUrl}">${ctaText}</a></p></div>
<div class="foot">FitScript · Your body. Decoded.<br/>
You're receiving this because you placed a lab order with FitScript.<br/>
{% unsubscribe %}</div>
</div></div></body></html>`;
}

// metricId 'CREATE' → register by firing a placeholder event first.
const EVENTS = [
  { key: "order_placed", metric: "Lab Order Placed", metricId: "Uu9XH5",
    subject: "Your FitScript order: {{ event.panelName }}",
    preheader: "Your lab order is confirmed.",
    heroTitle: "Your order is confirmed",
    bodyHtml: "Thanks for your order. Your {{ event.panelName }} is confirmed and we're getting it ready. We'll keep you posted at every step — kit shipping, results, and your Atlas analysis.",
    ctaText: "View my order", ctaUrl: "{{ event.orderDetailUrl|default:'" + APP + "/dashboard/orders' }}" },

  { key: "results_ready", metric: "Lab Results Ready", metricId: "Vfksk3",
    subject: "Your {{ event.panelName }} results are ready",
    preheader: "Your lab results are in.",
    heroTitle: "Your results are in",
    bodyHtml: "Your {{ event.panelName }} results are ready. Atlas has analyzed your biomarkers against optimal ranges — see what they mean and your personalized next steps.",
    ctaText: "View my results", ctaUrl: `${APP}/dashboard/my-labs` },

  { key: "requisition_ready", metric: "Lab Requisition Ready", metricId: "CREATE",
    subject: "Your lab requisition is ready",
    preheader: "Download it for your blood draw.",
    heroTitle: "Your requisition is ready",
    bodyHtml: "Your {{ event.panelName }} requisition is ready. Download it and bring it to your blood draw appointment.",
    ctaText: "Download requisition", ctaUrl: "{{ event.requisitionUrl|default:'" + APP + "/dashboard/orders' }}" },

  { key: "kit_shipped", metric: "Lab Kit Shipped", metricId: "XUPsip",
    subject: "Your lab kit is on the way",
    preheader: "Track your shipment.",
    heroTitle: "Your kit has shipped",
    bodyHtml: "Your {{ event.panelName }} test kit is on its way.{% if event.trackingNumber %} Track it with {{ event.carrier }}: {{ event.trackingNumber }}.{% endif %} Follow the included instructions when it arrives.",
    ctaText: "Track my kit", ctaUrl: "{{ event.trackingUrl|default:event.orderDetailUrl|default:'" + APP + "/dashboard/orders' }}" },

  { key: "sample_collected", metric: "Lab Sample Collected", metricId: "UfkqW3",
    subject: "We've received your sample",
    preheader: "On its way to the lab.",
    heroTitle: "Sample received",
    bodyHtml: "Your {{ event.panelName }} sample has been collected and is on its way to the lab. Results typically follow within a few days — we'll email you the moment they're ready.",
    ctaText: "View order", ctaUrl: "{{ event.orderDetailUrl|default:'" + APP + "/dashboard/orders' }}" },

  { key: "appointment_scheduled", metric: "Lab Appointment Scheduled", metricId: "RhvGxG",
    subject: "Your lab appointment is booked",
    preheader: "Bring a photo ID.",
    heroTitle: "Appointment scheduled",
    bodyHtml: "Your {{ event.panelName }} draw appointment is booked{% if event.appointmentStartsAt %} for {{ event.appointmentStartsAt }}{% endif %}{% if event.appointmentAddress %} at {{ event.appointmentAddress }}{% endif %}. Bring a photo ID; your requisition is in your dashboard.",
    ctaText: "View appointment", ctaUrl: "{{ event.orderDetailUrl|default:'" + APP + "/dashboard/orders' }}" },

  { key: "analysis_ready", metric: "Lab Analysis Ready", metricId: "Wskrmc",
    subject: "Atlas analyzed your results",
    preheader: "See what your biomarkers mean.",
    heroTitle: "Your Atlas analysis is ready",
    bodyHtml: "Atlas has finished analyzing your {{ event.panelName }} results. See what your biomarkers mean and your personalized, updated protocol.",
    ctaText: "See my analysis", ctaUrl: `${APP}/dashboard/my-labs` },

  { key: "refunded", metric: "Lab Order Refunded", metricId: "CREATE",
    subject: "Your lab order has been refunded",
    preheader: "Refund confirmation.",
    heroTitle: "Order refunded",
    bodyHtml: "Your {{ event.panelName }} order has been refunded. If you have any questions, just reply to this email — we're happy to help.",
    ctaText: "View orders", ctaUrl: `${APP}/dashboard/orders` },
];

async function ensureMetric(name, metricId) {
  if (metricId !== "CREATE") return metricId;
  // fire a placeholder event to register the metric
  await k("/events/", { method: "POST", body: { data: { type: "event", attributes: {
    properties: { panelName: "Registration", _init: true },
    metric: { data: { type: "metric", attributes: { name } } },
    profile: { data: { type: "profile", attributes: { email: "klaviyo-metric-init@fitscript.me" } } },
  } } } });
  // poll for the metric id
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const { json } = await k("/metrics/");
    const m = (json.data || []).find((x) => x.attributes?.name === name);
    if (m) return m.id;
  }
  throw new Error(`metric '${name}' did not register`);
}

async function flowExists(name) {
  const { json } = await k("/flows/");
  return (json.data || []).some((f) => f.attributes?.name === name);
}

async function createTemplate(name, h) {
  const { status, json } = await k("/templates/", { method: "POST", body: { data: { type: "template", attributes: { name, editor_type: "CODE", html: h } } } });
  if (status >= 300) throw new Error(`template create failed: ${JSON.stringify(json.errors || json)}`);
  return json.data.id;
}

async function createFlow(name, metricId, templateId, subject, preheader) {
  const body = { data: { type: "flow", attributes: { name, definition: {
    triggers: [{ type: "metric", id: metricId, trigger_filter: null }],
    profile_filter: null,
    actions: [{ temporary_id: "send-1", type: "send-email", data: {
      status: "manual",
      message: { from_email: FROM_EMAIL, from_label: FROM_LABEL, subject_line: subject, preview_text: preheader, template_id: templateId, transactional: true, smart_sending_enabled: false, name },
    } }],
    entry_action_id: "send-1",
  } } } };
  const { status, json } = await k("/flows/", { method: "POST", body, rev: REV_W });
  if (status >= 300) throw new Error(`flow create failed: ${JSON.stringify(json.errors || json)}`);
  return json.data.id;
}

async function verify() {
  const { json } = await k("/flows/");
  console.log("Lab flows:");
  for (const f of (json.data || [])) {
    const n = f.attributes?.name || "";
    if (/lab/i.test(n)) console.log(`  [${f.attributes.status}] ${n}  (${f.id})`);
  }
}

async function main() {
  if (process.argv.includes("--verify")) { await verify(); return; }
  if (!KEY) throw new Error("KLAVIYO_API_KEY missing");
  for (const e of EVENTS) {
    const flowName = `Lab — ${e.metric.replace(/^Lab /, "")}`;
    if (await flowExists(flowName)) { console.log(`⏭  ${flowName} already exists — skipping`); continue; }
    const metricId = await ensureMetric(e.metric, e.metricId);
    const tplId = await createTemplate(`${flowName} (email)`, html(e));
    const flowId = await createFlow(flowName, metricId, tplId, e.subject, e.preheader);
    console.log(`✅ ${flowName}: flow=${flowId} template=${tplId} metric=${metricId}`);
  }
  console.log("\n--- verify ---"); await verify();
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
