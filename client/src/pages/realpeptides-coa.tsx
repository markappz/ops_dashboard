import { useQuery } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";

/**
 * COA freshness for Real Peptides, read from coa.realpeptides.co.
 *
 * That tracker stays the system of record — this is a read-only window onto it
 * so retest pressure is visible next to everything else RP. Anything that needs
 * changing still happens over there.
 */

type Status = "expired" | "expiring" | "untested" | "fresh";

interface Coa {
  configured?: boolean;
  hint?: string;
  generatedAt?: string;
  validityDays?: number;
  totals?: { tracked: number; expired: number; expiring: number; untested: number; fresh: number };
  skus?: {
    sku_code: string;
    product_name: string;
    status: Status;
    daysLeft: number | null;
    test_date: string | null;
    expiry_date: string | null;
    lab_name: string | null;
  }[];
  error?: string;
}

const num = (n: number | undefined) => (n ?? 0).toLocaleString();

const BADGE: Record<Status, string> = {
  expired: "bg-red-500/15 text-red-400",
  expiring: "bg-yellow-500/15 text-yellow-500",
  untested: "bg-ops-border text-ops-text-muted",
  fresh: "bg-fitscript-green/15 text-fitscript-green",
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: "bad" | "warn" | "good" }) {
  const c = tone === "bad" ? "text-red-400" : tone === "warn" ? "text-yellow-500" : tone === "good" ? "text-fitscript-green" : "text-ops-text";
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-4 shadow-card">
      <div className="text-[11px] uppercase tracking-wider text-ops-text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${c}`}>{value}</div>
    </div>
  );
}

export default function RealPeptidesCoa() {
  const { data, isLoading } = useQuery<Coa>({
    queryKey: ["realpeptides-coa"],
    queryFn: async () => {
      const r = await fetch("/api/ops/realpeptides/coa", { credentials: "include" });
      try { return await r.json(); } catch { return { error: `Request failed (HTTP ${r.status})` }; }
    },
  });

  const t = data?.totals;

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides"
        title="COA Tracker"
        subtitle={`Certificate freshness per SKU${data?.validityDays ? ` — valid ${data.validityDays} days from test date` : ""}.`}
      />

      {isLoading && <div className="text-sm text-ops-text-muted">Loading…</div>}
      {data?.error && (
        <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{data.error}</div>
      )}

      {!isLoading && data?.configured === false && (
        <div className="rounded-xl border border-ops-border bg-ops-surface p-6 shadow-card">
          <div className="text-lg font-medium text-ops-text">Not connected to the COA tracker</div>
          <p className="mt-2 max-w-2xl text-sm text-ops-text-muted">{data.hint}</p>
          <p className="mt-3 text-xs text-ops-text-muted">
            The tracker runs in its own AWS account with a private RDS, so this reads its token-gated
            summary endpoint rather than its database. Generate one random value, set it as
            <code> COA_OPS_TOKEN</code> on both task definitions, and redeploy each.
          </p>
        </div>
      )}

      {t && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat label="Tracked SKUs" value={num(t.tracked)} />
            <Stat label="Expired" value={num(t.expired)} tone={t.expired > 0 ? "bad" : undefined} />
            <Stat label="Expiring" value={num(t.expiring)} tone={t.expiring > 0 ? "warn" : undefined} />
            <Stat label="Never tested" value={num(t.untested)} tone={t.untested > 0 ? "warn" : undefined} />
            <Stat label="Fresh" value={num(t.fresh)} tone="good" />
          </div>

          <div className="overflow-x-auto rounded-xl border border-ops-border bg-ops-surface shadow-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ops-border text-left text-[11px] uppercase tracking-wider text-ops-text-muted">
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium">SKU</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Tested</th>
                  <th className="px-4 py-3 font-medium">Expires</th>
                  <th className="px-4 py-3 font-medium">Lab</th>
                </tr>
              </thead>
              <tbody>
                {(data?.skus ?? []).length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-ops-text-muted">No SKUs require a COA.</td></tr>
                )}
                {(data?.skus ?? []).map((s) => (
                  <tr key={s.sku_code} className="border-b border-ops-border/50 last:border-0">
                    <td className="px-4 py-2.5 text-ops-text">{s.product_name}</td>
                    <td className="px-4 py-2.5 text-ops-text-muted">{s.sku_code}</td>
                    <td className="px-4 py-2.5">
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${BADGE[s.status]}`}>
                        {s.status}
                        {s.status === "expiring" && s.daysLeft !== null ? ` · ${s.daysLeft}d` : ""}
                        {s.status === "expired" && s.daysLeft !== null ? ` · ${Math.abs(s.daysLeft)}d ago` : ""}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-ops-text-muted">{s.test_date ?? "—"}</td>
                    <td className="px-4 py-2.5 text-ops-text-muted">{s.expiry_date ?? "—"}</td>
                    <td className="px-4 py-2.5 text-ops-text-muted">{s.lab_name ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-ops-text-muted">
            Read-only. Upload COAs and mark tests at{" "}
            <a href="https://coa.realpeptides.co" target="_blank" rel="noreferrer" className="text-fitscript-green hover:underline">
              coa.realpeptides.co
            </a>
            {data?.generatedAt ? ` · data as of ${new Date(data.generatedAt).toLocaleString()}` : ""}.
          </p>
        </>
      )}
    </div>
  );
}
