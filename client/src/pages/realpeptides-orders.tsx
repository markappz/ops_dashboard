import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Mail, MousePointerClick, Newspaper, Share2, Bot, Link2, CircleDot, EyeOff, Globe } from "lucide-react";
import { PageHero } from "../components/page-hero";
import { ui } from "./coa/api";

/**
 * Real Peptides Orders — every order, organized by how it came in.
 * Source = our pixel's purchase beacon joined server-side; "untracked" means
 * no beacon matched (pre-beacon orders, blocked pixels) — never a guess.
 */

interface Order {
  id: string; number: string; createdAt: string; email: string | null;
  total: number; status: string | null; items: { name: string; qty: number }[];
  channel: string; landing: string | null; campaign: string | null; referrer: string | null;
}
interface Payload {
  configured: boolean; hint?: string; range: number;
  orders: Order[]; byChannel: Record<string, { orders: number; revenue: number }>;
}

const CHANNELS: Record<string, { label: string; icon: React.ReactNode; cls: string }> = {
  "organic-search": { label: "SEO / Search", icon: <Globe size={13} />, cls: "bg-fitscript-green/15 text-fitscript-green" },
  blog: { label: "Blog", icon: <Newspaper size={13} />, cls: "bg-sky-500/15 text-sky-400" },
  email: { label: "Email", icon: <Mail size={13} />, cls: "bg-violet-500/15 text-violet-400" },
  paid: { label: "Paid ads", icon: <MousePointerClick size={13} />, cls: "bg-amber-500/15 text-amber-500" },
  social: { label: "Social", icon: <Share2 size={13} />, cls: "bg-pink-500/15 text-pink-400" },
  ai: { label: "AI assistants", icon: <Bot size={13} />, cls: "bg-cyan-500/15 text-cyan-400" },
  referral: { label: "Referral", icon: <Link2 size={13} />, cls: "bg-orange-500/15 text-orange-400" },
  direct: { label: "Direct", icon: <CircleDot size={13} />, cls: "bg-ops-border text-ops-text-muted" },
  untracked: { label: "Untracked", icon: <EyeOff size={13} />, cls: "bg-ops-border text-ops-text-muted" },
};
const ORDERED = ["organic-search", "blog", "email", "paid", "social", "ai", "referral", "direct", "untracked"];

const money = (n: number) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });

export default function RealPeptidesOrders() {
  const [range, setRange] = useState(30);
  const [channel, setChannel] = useState("all");
  const [query, setQuery] = useState("");

  const q = useQuery({
    queryKey: ["rp-orders", range],
    queryFn: async () => {
      const r = await fetch(`/api/ops/realpeptides/orders?range=${range}`, { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      return r.json() as Promise<Payload>;
    },
  });

  const orders = q.data?.orders ?? [];
  const shown = useMemo(() => {
    let list = channel === "all" ? orders : orders.filter((o) => o.channel === channel);
    const s = query.trim().toLowerCase();
    if (s) list = list.filter((o) =>
      o.number.toLowerCase().includes(s) || (o.email ?? "").toLowerCase().includes(s) ||
      o.items.some((i) => i.name.toLowerCase().includes(s)) || (o.campaign ?? "").toLowerCase().includes(s));
    return list;
  }, [orders, channel, query]);

  const byChannel = q.data?.byChannel ?? {};
  const totalRevenue = orders.reduce((a, o) => a + o.total, 0);

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides"
        title="Orders"
        subtitle={`${orders.length} orders · ${money(totalRevenue)} in the last ${range} days, organized by how each one came in.`}
        actions={
          <div className="flex items-center gap-1 rounded-xl border border-ops-border bg-ops-surface p-1">
            {[7, 30, 90].map((d) => (
              <button key={d} type="button" onClick={() => setRange(d)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${range === d ? "bg-fitscript-green text-white" : "text-ops-text-muted hover:text-ops-text"}`}>
                {d}d
              </button>
            ))}
          </div>
        }
      />

      {q.isLoading && <div className="py-16 text-center text-sm text-ops-text-muted">Loading orders…</div>}
      {q.error && <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{(q.error as Error).message}</div>}
      {q.data && !q.data.configured && (
        <div className="rounded-2xl border border-ops-border bg-ops-surface p-8 text-center shadow-card">
          <div className="mx-auto max-w-md text-sm text-ops-text-muted">{q.data.hint}</div>
        </div>
      )}

      {q.data?.configured && (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <ChannelTile k="all" label="All orders" count={orders.length} revenue={totalRevenue} active={channel === "all"} onPick={setChannel} />
            {ORDERED.filter((k) => byChannel[k]).map((k) => (
              <ChannelTile key={k} k={k} label={CHANNELS[k].label} icon={CHANNELS[k].icon}
                count={byChannel[k].orders} revenue={byChannel[k].revenue} active={channel === k} onPick={setChannel} />
            ))}
          </div>

          <div className="relative mb-4 max-w-md">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ops-text-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search order #, email, product, campaign…" className={`${ui.input} pl-9`} />
          </div>

          <div className="overflow-x-auto rounded-2xl border border-ops-border bg-ops-surface shadow-card">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead>
                <tr className="border-b border-ops-border bg-ops-bg/40 text-[11px] uppercase tracking-wider text-ops-text-muted">
                  <th className="px-4 py-3 font-medium">Order</th>
                  <th className="px-4 py-3 font-medium">Items</th>
                  <th className="px-4 py-3 text-right font-medium">Total</th>
                  <th className="px-4 py-3 font-medium">Source</th>
                  <th className="px-4 py-3 font-medium">Came in via</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ops-border/50">
                {shown.map((o) => {
                  const ch = CHANNELS[o.channel] ?? CHANNELS.untracked;
                  return (
                    <tr key={o.id}>
                      <td className="px-4 py-3">
                        <div className="font-medium text-ops-text">#{o.number}</div>
                        <div className="text-[11px] text-ops-text-muted">{new Date(o.createdAt).toLocaleString()}{o.email ? ` · ${o.email}` : ""}</div>
                      </td>
                      <td className="max-w-[260px] px-4 py-3 text-xs text-ops-text-muted">
                        <span className="line-clamp-2">{o.items.map((i) => `${i.qty}× ${i.name}`).join(", ") || "—"}</span>
                      </td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums text-ops-text">${o.total.toFixed(2)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${ch.cls}`}>{ch.icon} {ch.label}</span>
                      </td>
                      <td className="max-w-[220px] px-4 py-3 text-xs text-ops-text-muted">
                        <span className="line-clamp-2">
                          {o.channel === "untracked" ? "no pixel match"
                            : [o.landing, o.campaign && `“${o.campaign}”`, o.referrer && `from ${o.referrer}`].filter(Boolean).join(" · ") || "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-ops-text-muted">{o.status ?? "—"}</td>
                    </tr>
                  );
                })}
                {!shown.length && <tr><td colSpan={6} className="px-4 py-12 text-center text-sm text-ops-text-muted">No orders match.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function ChannelTile({ k, label, icon, count, revenue, active, onPick }: {
  k: string; label: string; icon?: React.ReactNode; count: number; revenue: number; active: boolean; onPick: (k: string) => void;
}) {
  return (
    <button type="button" onClick={() => onPick(k)}
      className={`rounded-2xl border p-3.5 text-left shadow-card transition ${active ? "border-fitscript-green bg-fitscript-green/10" : "border-ops-border bg-ops-surface hover:border-ops-text-muted"}`}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-ops-text-muted">{icon} {label}</div>
      <div className="mt-1.5 text-lg font-bold leading-none tabular-nums text-ops-text">{money(revenue)}</div>
      <div className="mt-1 text-[11px] tabular-nums text-ops-text-muted">{count} order{count === 1 ? "" : "s"}</div>
    </button>
  );
}
