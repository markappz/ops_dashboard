/**
 * pawgen data access over Supabase's REST API (PostgREST), used when
 * PAWGEN_SUPABASE_URL + PAWGEN_SUPABASE_SERVICE_ROLE_KEY are set.
 *
 * Why this exists alongside `pawgenPool`: the Postgres route needs the project's
 * DB password AND the session-pooler's project-scoped user (`postgres.<ref>`),
 * which is exactly what kept failing with `password authentication failed for
 * user "postgres"`. The service-role key is the same credential pawgen's own app
 * already uses in production, so there's no second secret to keep in sync.
 *
 * Repo rule is "raw SQL, no ORM" — that's about not putting Drizzle in front of
 * OUR Postgres. This is a foreign database we reach over HTTP; there's no pool to
 * use. `server/pawgen.ts` prefers this over `pawgenPool` when both are configured,
 * because a Pool object exists whenever PAWGEN_DATABASE_URL is set even if its
 * credentials are invalid — see the note on `source()` there.
 *
 * Scale note: PostgREST can't SUM/aggregate without an RPC, so the stats below
 * fetch the amount/status columns and reduce in JS. Fine for a brand in its first
 * hundreds of orders; if pawgen passes ~10k, move stats to a Postgres view or an
 * RPC rather than paging more rows through here.
 */

const REST_PAGE_MAX = 10_000; // hard cap so a bad filter can't pull the table forever

export function pawgenRestConfigured(): boolean {
  return Boolean(process.env.PAWGEN_SUPABASE_URL && process.env.PAWGEN_SUPABASE_SERVICE_ROLE_KEY);
}

function base(): { url: string; key: string } {
  const url = (process.env.PAWGEN_SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.PAWGEN_SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) throw new Error("pawgen Supabase REST not configured");
  return { url, key };
}

type RestOpts = {
  method?: string;
  body?: unknown;
  /** Ask PostgREST for an exact row count in the Content-Range header. */
  count?: boolean;
  range?: { from: number; to: number };
  /** Extra Prefer directives (e.g. "resolution=ignore-duplicates"). */
  prefer?: string[];
};

async function rest<T>(path: string, opts: RestOpts = {}): Promise<{ rows: T[]; total: number | null }> {
  const { url, key } = base();
  const prefer = [...(opts.prefer ?? [])];
  if (opts.count) prefer.push("count=exact");
  if (opts.method && opts.method !== "GET") prefer.push("return=representation");

  const headers: Record<string, string> = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (prefer.length) headers.Prefer = prefer.join(",");
  if (opts.range) headers.Range = `${opts.range.from}-${opts.range.to}`;

  const res = await fetch(`${url}/rest/v1/${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });

  // 416 = the Range asked for rows past the end of the table. PostgREST treats that
  // as an error; SQL's OFFSET just returns nothing. Match the SQL behaviour so a
  // stale ?page=N is an empty page, not a 500. The count still rides on Content-Range.
  if (res.status === 416) {
    const cr = res.headers.get("content-range");
    const n = cr?.split("/")?.[1];
    return { rows: [], total: n && n !== "*" ? Number(n) : 0 };
  }

  const text = await res.text();
  if (!res.ok) {
    // Surface PostgREST's own message — it names the column/constraint, which is
    // far more useful in the UI banner than "request failed".
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j.message || j.hint || text;
    } catch {
      /* keep raw text */
    }
    throw new Error(`pawgen Supabase: ${msg || res.statusText}`);
  }

  // "0-24/137" → 137
  const total = (() => {
    const cr = res.headers.get("content-range");
    const n = cr?.split("/")?.[1];
    return n && n !== "*" ? Number(n) : null;
  })();

  return { rows: text ? (JSON.parse(text) as T[]) : [], total };
}

// ── Reads ───────────────────────────────────────────────────────────────────
const ORDER_COLS =
  "id,created_at,source,method,payment_status,amount_usd,pack_id,quantity," +
  "bac_addon_qty,customer_name,customer_email,fulfillment_status,tracking_number,carrier";

export async function listOrders(status: string, limit: number, offset: number) {
  const filter = status !== "all" ? `&fulfillment_status=eq.${encodeURIComponent(status)}` : "";
  const { rows, total } = await rest<Record<string, any>>(
    `orders?select=${ORDER_COLS}${filter}&order=created_at.desc`,
    { count: true, range: { from: offset, to: offset + limit - 1 } }
  );
  return { rows, total: total ?? rows.length };
}

/** Headline stats + per-status counts, reduced in JS (see scale note above). */
export async function ordersSummary() {
  const { rows } = await rest<{ payment_status: string; fulfillment_status: string; amount_usd: string }>(
    `orders?select=payment_status,fulfillment_status,amount_usd`,
    { range: { from: 0, to: REST_PAGE_MAX - 1 } }
  );

  const stats = { paidOrders: 0, revenue: 0, refunded: 0, toFulfill: 0 };
  const statuses: Record<string, number> = {};

  for (const o of rows) {
    if (o.payment_status === "paid") {
      stats.paidOrders += 1;
      stats.revenue += Number(o.amount_usd) || 0;
    }
    if (o.payment_status === "refunded") stats.refunded += 1;
    // Paid only — an unpaid order isn't something to ship, and counting it made
    // this disagree with the Overview tab's backlog figure.
    if (
      o.payment_status === "paid" &&
      (o.fulfillment_status === "unfulfilled" || o.fulfillment_status === "processing")
    ) {
      stats.toFulfill += 1;
    }
    statuses[o.fulfillment_status] = (statuses[o.fulfillment_status] ?? 0) + 1;
  }

  stats.revenue = Math.round(stats.revenue * 100) / 100;
  return { stats, statuses };
}

/** Every field the overview tab aggregates over. Same capped fetch as ordersSummary. */
export async function ordersForAnalytics() {
  const { rows } = await rest<{
    created_at: string;
    amount_usd: string;
    shipping_cost: string | null;
    pack_id: string;
    method: string;
    source: string;
    payment_status: string;
    fulfillment_status: string;
    customer_email: string | null;
  }>(
    `orders?select=created_at,amount_usd,shipping_cost,pack_id,method,source,payment_status,fulfillment_status,customer_email&order=created_at.desc`,
    { range: { from: 0, to: REST_PAGE_MAX - 1 } }
  );
  return rows;
}

export async function getOrder(id: string) {
  const { rows } = await rest<Record<string, any>>(
    `orders?select=id,source,method,external_id,payment_status,amount_usd,customer_email&id=eq.${encodeURIComponent(id)}&limit=1`
  );
  return rows[0] ?? null;
}

// ── Writes (refund reconciliation) ──────────────────────────────────────────
export async function markRefunded(id: string) {
  await rest(`orders?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { payment_status: "refunded", fulfillment_status: "cancelled" },
  });
}

export async function findRedemption(orderId: string) {
  const { rows } = await rest<{ email: string; delta: number }>(
    `points_ledger?select=email,delta&order_id=eq.${encodeURIComponent(orderId)}&reason=eq.redeem&limit=1`
  );
  return rows[0] ?? null;
}

/** Idempotent: the unique (email, reason, order_id) index makes a repeat a no-op. */
export async function restorePoints(email: string, delta: number, orderId: string) {
  try {
    await rest(`points_ledger`, {
      method: "POST",
      body: [{ email, delta, reason: "adjust", order_id: orderId, note: "refund: restored redeemed points" }],
      prefer: ["resolution=ignore-duplicates"],
    });
  } catch (e: any) {
    if (!/duplicate|unique/i.test(e?.message ?? "")) throw e;
  }
}

/** Connection check for boot logging. */
export async function verifyPawgenRest(): Promise<boolean> {
  if (!pawgenRestConfigured()) return false;
  try {
    await rest(`orders?select=id&limit=1`);
    console.log("[OPS DB] Connected to pawgen via Supabase REST");
    return true;
  } catch (e: any) {
    console.error("[OPS DB] pawgen Supabase REST failed:", e.message);
    return false;
  }
}

/**
 * Referral breakdown: orders + revenue by first-touch source, plus short-link
 * clicks where we have them.
 *
 * PostgREST has no GROUP BY, so we pull the (small) order set and aggregate in
 * Node. Fine at this volume; revisit if orders ever run to five figures.
 */
export async function referrals() {
  const { rows } = await rest<{
    ref_source: string | null;
    amount_usd: string | null;
    payment_status: string | null;
    created_at: string;
  }>(
    `orders?select=ref_source,amount_usd,payment_status,created_at&order=created_at.desc`,
    { range: { from: 0, to: REST_PAGE_MAX - 1 } }
  );

  type Agg = { source: string; orders: number; paidOrders: number; revenue: number; lastOrderAt: string | null };
  const bySource = new Map<string, Agg>();

  for (const r of rows) {
    // NULL ref_source is real and meaningful: direct traffic + everything that
    // predates attribution. Bucket it rather than dropping it.
    const key = r.ref_source ?? "(direct)";
    const a =
      bySource.get(key) ?? { source: key, orders: 0, paidOrders: 0, revenue: 0, lastOrderAt: null };
    a.orders += 1;
    if (r.payment_status === "paid" || r.payment_status === "refunded") {
      a.paidOrders += 1;
      a.revenue += Number(r.amount_usd ?? 0);
    }
    if (!a.lastOrderAt || r.created_at > a.lastOrderAt) a.lastOrderAt = r.created_at;
    bySource.set(key, a);
  }

  // Clicks are optional — the table only exists once db/partner_links.sql has
  // been run on the pawgen database. Missing table must not break the panel.
  const clicks = new Map<string, number>();
  try {
    const { rows: clickRows } = await rest<{ ref_source: string }>(
      `link_clicks?select=ref_source`,
      { range: { from: 0, to: REST_PAGE_MAX - 1 } }
    );
    for (const c of clickRows) clicks.set(c.ref_source, (clicks.get(c.ref_source) ?? 0) + 1);
  } catch {
    /* table not created yet — report clicks as null below */
  }

  const list = [...bySource.values()]
    .map((a) => ({
      ...a,
      revenue: Math.round(a.revenue * 100) / 100,
      clicks: clicks.size ? clicks.get(a.source) ?? 0 : null,
      // Only meaningful once we have both numbers for that source.
      conversion:
        clicks.size && (clicks.get(a.source) ?? 0) > 0
          ? Math.round((a.paidOrders / (clicks.get(a.source) as number)) * 1000) / 10
          : null,
    }))
    .sort((x, y) => y.revenue - x.revenue || y.orders - x.orders);

  return { sources: list, clicksTracked: clicks.size > 0 };
}
