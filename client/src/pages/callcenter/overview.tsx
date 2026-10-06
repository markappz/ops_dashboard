import { useState } from "react";
import { Phone, MessageSquare, AlertTriangle, Clock, Building2, CheckCircle2, Activity } from "lucide-react";
import { PageHero } from "../../components/page-hero";
import { StatCard } from "../../components/stat";
import { useCc, QUEUE_LABEL } from "./api";
import { Link } from "wouter";

interface Overview {
  rangeDays: number;
  timezone: string;
  channels: Array<{ channel: string; total: number; answered: number; failed: number }>;
  byDay: Array<{ day: string; calls: number }>;
  byIntent: Array<{ intent: string; n: number }>;
  requests: Array<{ state: string; queue: string; n: number }>;
  overdue: number;
  attempts: Array<{ outcome: string; n: number }>;
  avgDailyCalls: { value: number; numerator: number; denominatorDays: number; note: string };
}

interface Health {
  retell: { configured: boolean };
  webhook: { lastReceived: string | null; inbox: Record<string, number> };
  phone: { connected: boolean; note?: string };
  sms: { connected: boolean };
  dialer: { connected: boolean };
  commerce: { site: string; catalog: { lastOk: string | null; lastError: string | null } };
}

export default function CallCenterOverview() {
  const [days, setDays] = useState(30);
  const q = useCc<Overview>(["overview", days], `/overview?days=${days}`, { refetchInterval: 60_000 });
  const health = useCc<Health>(["health"], "/health", { refetchInterval: 120_000 });

  const d = q.data;
  const voice = d?.channels.find((c) => c.channel === "voice");
  const chat = d?.channels.find((c) => c.channel === "chat");
  const open = d?.requests.filter((r) => !["resolved", "closed_no_action"].includes(r.state)).reduce((a, r) => a + r.n, 0) ?? 0;
  const resolved = d?.requests.filter((r) => r.state === "resolved").reduce((a, r) => a + r.n, 0) ?? 0;
  const wholesaleOpen = d?.requests.filter((r) => r.queue === "wholesale" && !["resolved", "closed_no_action"].includes(r.state)).reduce((a, r) => a + r.n, 0) ?? 0;
  const spark = d?.byDay.map((x) => x.calls) ?? [];
  const h = health.data;
  const inboxDead = h?.webhook.inbox?.dead ?? 0;

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides"
        title="Call Center"
        subtitle={`Calls, chats and follow-ups across the Retell agents. Counts exclude flagged test sessions; days bucket in ${d?.timezone ?? "America/New_York"}.`}
        actions={
          <div className="flex items-center gap-1 rounded-xl border border-ops-border bg-ops-surface p-1">
            {[7, 30, 90].map((n) => (
              <button key={n} type="button" onClick={() => setDays(n)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${days === n ? "bg-fitscript-green text-white" : "text-ops-text-muted hover:text-ops-text"}`}>{n}d</button>
            ))}
          </div>
        }
      />

      {q.error && <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{(q.error as Error).message}</div>}

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard i={0} label="Inbound calls" icon={<Phone />} number={voice?.total ?? 0} spark={spark}
          sub={d ? `${d.avgDailyCalls.value}/day over ${d.avgDailyCalls.denominatorDays}d` : undefined} accent />
        <StatCard i={1} label="Answered / failed" icon={<Activity />}
          value={<span>{voice?.answered ?? 0} <span className="text-ops-text-muted">/</span> <span className={voice?.failed ? "text-red-400" : ""}>{voice?.failed ?? 0}</span></span>}
          tone={voice?.failed ? "warn" : undefined} />
        <StatCard i={2} label="Chats" icon={<MessageSquare />} number={chat?.total ?? 0} />
        <StatCard i={3} label="Open follow-ups" icon={<Clock />} number={open} tone={open ? "warn" : "good"} to="/realpeptides/call-center/follow-ups" />
        <StatCard i={4} label="Overdue callbacks" icon={<AlertTriangle />} number={d?.overdue ?? 0} tone={d?.overdue ? "bad" : "good"} to="/realpeptides/call-center/follow-ups" />
        <StatCard i={5} label="Wholesale requests" icon={<Building2 />} number={wholesaleOpen} to="/realpeptides/call-center/wholesale" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
          <div className="mb-3 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">Intents · {days}d</div>
          {!d?.byIntent.length && <div className="py-6 text-center text-sm text-ops-text-muted">{q.isLoading ? "Loading…" : "No analyzed conversations yet."}</div>}
          <div className="space-y-2">
            {d?.byIntent.map((row) => {
              const max = d.byIntent[0]?.n || 1;
              return (
                <div key={row.intent} className="flex items-center gap-3">
                  <div className="w-36 truncate text-sm text-ops-text" title={row.intent}>{row.intent}</div>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-ops-border">
                    <div className="h-full rounded-full bg-brand-blue-500/70" style={{ width: `${(row.n / max) * 100}%` }} />
                  </div>
                  <div className="w-8 text-right text-sm tabular-nums text-ops-text-muted">{row.n}</div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
          <div className="mb-3 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">Confirmed outcomes · {days}d</div>
          <div className="space-y-2.5 text-sm">
            <Row label="Requests resolved" value={resolved} icon={<CheckCircle2 className="h-4 w-4 text-emerald-400" />} />
            {(d?.attempts ?? []).map((a) => (
              <Row key={a.outcome} label={`Callback ${a.outcome.replace("_", " ")}`} value={a.n} />
            ))}
            {!d?.attempts.length && <div className="text-ops-text-muted">No callback attempts recorded yet.</div>}
          </div>
          {d && <div className="mt-4 border-t border-ops-border pt-3 text-xs text-ops-text-muted">{d.avgDailyCalls.note}</div>}
        </div>

        <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
          <div className="mb-3 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">Integration health</div>
          <div className="space-y-2.5 text-sm">
            <Dot ok={!!h?.retell.configured} label="Retell API" detail={h?.retell.configured ? "connected" : "not configured"} />
            <Dot ok={!!h?.webhook.lastReceived} label="Webhook" detail={h?.webhook.lastReceived ? `last event ${new Date(h.webhook.lastReceived).toLocaleString()}` : "no events received yet"} />
            <Dot ok={inboxDead === 0} label="Event queue" detail={inboxDead ? `${inboxDead} dead-lettered — see Settings` : "healthy"} />
            <Dot ok={!!h?.phone.connected} label="Phone line" detail={h?.phone.connected ? "number attached in Retell" : "not ported — rings Google Voice"} />
            <Dot ok={!!h?.sms.connected} label="SMS" detail={h?.sms.connected ? "connected" : "not connected"} />
            <Dot ok={!!h?.dialer.connected} label="Staff dialer" detail={h?.dialer.connected ? "connected" : "tel: fallback only"} />
            <Dot ok={h?.commerce.site === "configured" && !h?.commerce.catalog.lastError} label="Catalog"
              detail={h?.commerce.catalog.lastError ? h.commerce.catalog.lastError : h?.commerce.catalog.lastOk ? `fresh as of ${new Date(h.commerce.catalog.lastOk).toLocaleTimeString()}` : "no lookups yet"} />
          </div>
          <Link href="/realpeptides/call-center/settings" className="mt-4 inline-block text-xs font-medium text-brand-blue-500 hover:underline">Full health & settings →</Link>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, icon }: { label: string; value: number; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-ops-text">{icon}{label}</div>
      <div className="tabular-nums text-ops-text-muted">{value}</div>
    </div>
  );
}

function Dot({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${ok ? "bg-emerald-400" : "bg-amber-500"}`} />
      <div className="min-w-0">
        <span className="text-ops-text">{label}</span>
        {detail && <span className="ml-2 break-words text-xs text-ops-text-muted">{detail}</span>}
      </div>
    </div>
  );
}
