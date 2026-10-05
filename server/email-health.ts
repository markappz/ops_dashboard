/**
 * Deliverability health score — one pure function over a brand's email summary.
 * Grades on industry bulk-sender thresholds (Gmail/Yahoo 2024 rules): complaints
 * <0.1% healthy / >=0.3% critical, bounces <2% / >=5%, delivered >=98%, tracked
 * opens >=30% excellent / <10% poor, unsubs <0.5%. Complaints and bounces weigh
 * heaviest — they ARE sending-domain health; opens next.
 *
 * Normalization notes (the upstream shapes force these):
 * - No per-send "delivered" event exists upstream, so deliveredRate is derived
 *   as (sends - bounces) / sends.
 * - Open/click rates are tracked-send weighted across rows, never averaged
 *   (house rule). Campaigns carry uniqueOpens/uniqueClicks; flows only carry
 *   rates + an `instrumented` tracked count, so flow opens are reconstructed
 *   as rate * tracked.
 * - Campaigns carry no unsub counts; unsubs come from flow rows only.
 */

export interface EmailHealth {
  grade: "A" | "B" | "C" | "D" | "F";
  score: number;
  lowVolume: boolean;
  components: {
    deliveredRate: number | null;
    openRate: number | null;
    clickRate: number | null;
    bounceRate: number | null;
    complaintRate: number | null;
    unsubRate: number | null;
    trackedSends: number;
    totalSends: number;
  };
  flags: string[];
}

interface Row { sends: number; tracked: number; opens: number | null; clicks: number | null; bounces: number; complaints: number; unsubs: number }

const n = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : 0);
const LOW_VOLUME_TRACKED = 100;

function campaignRow(c: any): Row {
  const tracked = n(c.trackedSends ?? c.sends);
  const derive = (unique: unknown, rate: unknown): number | null =>
    typeof unique === "number" ? unique : typeof rate === "number" ? rate * tracked : null;
  return {
    sends: n(c.sends), tracked,
    opens: derive(c.uniqueOpens, c.openRate), clicks: derive(c.uniqueClicks, c.clickRate),
    bounces: n(c.bounces), complaints: n(c.complaints), unsubs: n(c.unsubscribed ?? c.unsubscribes),
  };
}

function flowRow(f: any): Row {
  const tracked = n(f.instrumented ?? f.trackedSends ?? f.sends);
  const derive = (rate: unknown): number | null => (typeof rate === "number" ? rate * tracked : null);
  return {
    sends: n(f.sends), tracked,
    opens: derive(f.openRate), clicks: derive(f.clickRate),
    bounces: n(f.bounces), complaints: n(f.complaints), unsubs: n(f.unsubscribes ?? f.unsubscribed),
  };
}

/** Tracked-send-weighted rate: only rows that actually report the metric count. */
function weightedRate(rows: Row[], pick: (r: Row) => number | null): number | null {
  let num = 0, den = 0;
  for (const r of rows) {
    const v = pick(r);
    if (v === null || !r.tracked) continue;
    num += v; den += r.tracked;
  }
  return den ? num / den : null;
}

/** Piecewise-linear score over sorted [value, score] anchors. */
function lerpScore(value: number, anchors: Array<[number, number]>): number {
  if (value <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    const [x0, y0] = anchors[i - 1], [x1, y1] = anchors[i];
    if (value <= x1) return y0 + ((value - x0) / (x1 - x0)) * (y1 - y0);
  }
  return anchors[anchors.length - 1][1];
}

const pctf = (v: number) => `${(v * 100).toFixed(v * 100 < 1 ? 2 : 1)}%`;

function buildFlags(c: EmailHealth["components"]): string[] {
  const flags: string[] = [];
  const { complaintRate: cr, bounceRate: br, openRate: or, unsubRate: ur } = c;
  if (cr !== null && cr >= 0.003) flags.push(`Complaint rate ${pctf(cr)} — at or above Gmail's 0.3% cutoff; the sending domain is at risk.`);
  else if (cr !== null && cr >= 0.001) flags.push(`Complaint rate ${pctf(cr)} — above the 0.1% healthy line.`);
  if (br !== null && br >= 0.05) flags.push(`Bounce rate ${pctf(br)} — at or above the 5% critical line; clean the list before the next send.`);
  else if (br !== null && br >= 0.02) flags.push(`Bounce rate ${pctf(br)} — above the 2% healthy line.`);
  if (or !== null && or < 0.1) flags.push(`Tracked open rate ${pctf(or)} — poor (under 10%); inbox placement is likely suffering.`);
  else if (or !== null && or < 0.2) flags.push(`Tracked open rate ${pctf(or)} — weak (under the 20% good line).`);
  if (ur !== null && ur >= 0.02) flags.push(`Unsubscribe rate ${pctf(ur)} — very high; the list is churning.`);
  else if (ur !== null && ur >= 0.005) flags.push(`Unsubscribe rate ${pctf(ur)} — above the 0.5% healthy line.`);
  return flags;
}

/** Weighted blend; a component the data can't support drops out and its weight redistributes. */
function blendScore(c: EmailHealth["components"]): number {
  const parts: Array<[number | null, number, Array<[number, number]>]> = [
    [c.complaintRate, 30, [[0.001, 100], [0.003, 0]]],
    [c.bounceRate, 25, [[0.02, 100], [0.05, 0]]],
    [c.openRate, 20, [[0, 0], [0.1, 35], [0.2, 70], [0.3, 100]]],
    [c.deliveredRate, 10, [[0.9, 0], [0.98, 100]]],
    [c.unsubRate, 10, [[0.005, 100], [0.02, 0]]],
    [c.clickRate, 5, [[0, 0], [0.005, 40], [0.01, 70], [0.02, 100]]],
  ];
  let num = 0, den = 0;
  for (const [value, weight, anchors] of parts) {
    if (value === null) continue;
    num += lerpScore(value, anchors) * weight;
    den += weight;
  }
  return den ? Math.round(num / den) : 0;
}

const gradeOf = (score: number): EmailHealth["grade"] =>
  score >= 90 ? "A" : score >= 80 ? "B" : score >= 65 ? "C" : score >= 50 ? "D" : "F";

/**
 * Compute a brand's deliverability health from its summary payload (the exact
 * object its /api/ops-email-summary returns). Returns null when there is no
 * row or total to grade — the caller omits the field, never invents a grade.
 */
export function computeEmailHealth(summary: any): EmailHealth | null {
  if (!summary || typeof summary !== "object") return null;
  let rows: Row[] = [
    ...(Array.isArray(summary.campaigns) ? summary.campaigns.map(campaignRow) : []),
    ...(Array.isArray(summary.flows) ? summary.flows.map(flowRow) : []),
  ];
  const t = summary.totals;
  if (!rows.length && t && typeof t === "object" && n(t.sends)) {
    rows = [{ sends: n(t.sends), tracked: n(t.trackedSends ?? t.sends),
      opens: typeof t.openRate === "number" ? t.openRate * n(t.trackedSends ?? t.sends) : null,
      clicks: typeof t.clickRate === "number" ? t.clickRate * n(t.trackedSends ?? t.sends) : null,
      bounces: n(t.bounces), complaints: n(t.complaints), unsubs: n(t.unsubscribes) }];
  }
  const totalSends = rows.reduce((s, r) => s + r.sends, 0);
  if (!totalSends) return null;
  const trackedSends = rows.reduce((s, r) => s + r.tracked, 0);
  const sum = (pick: (r: Row) => number) => rows.reduce((s, r) => s + pick(r), 0);
  const components: EmailHealth["components"] = {
    deliveredRate: (totalSends - sum((r) => r.bounces)) / totalSends,
    openRate: weightedRate(rows, (r) => r.opens),
    clickRate: weightedRate(rows, (r) => r.clicks),
    bounceRate: sum((r) => r.bounces) / totalSends,
    complaintRate: sum((r) => r.complaints) / totalSends,
    unsubRate: sum((r) => r.unsubs) / totalSends,
    trackedSends, totalSends,
  };
  const lowVolume = trackedSends < LOW_VOLUME_TRACKED;
  const flags = buildFlags(components);
  if (lowVolume) flags.unshift(`Only ${trackedSends} tracked sends in this window — not enough volume to grade reliably.`);
  const score = blendScore(components);
  return { grade: gradeOf(score), score, lowVolume, components, flags };
}
