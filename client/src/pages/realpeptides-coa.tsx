import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";

/**
 * COA freshness for Real Peptides, read from coa.realpeptides.co.
 *
 * That tracker stays the system of record. This page reads its summary and
 * allows exactly one write — filing a new COA PDF — so the team can keep
 * certificates current without a second login. Everything else happens there.
 */

type Status = "expired" | "expiring" | "untested" | "fresh";

interface Coa {
  configured?: boolean;
  hint?: string;
  generatedAt?: string;
  validityDays?: number;
  totals?: { tracked: number; expired: number; expiring: number; untested: number; fresh: number };
  skus?: {
    id: number;
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
const today = () => new Date().toISOString().slice(0, 10);

type Sku = NonNullable<Coa["skus"]>[number];

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

function UploadCoa({ skus, preselect, onDone }: { skus: Sku[]; preselect: string | null; onDone: () => void }) {
  const [skuCode, setSkuCode] = useState(preselect ?? "");
  const [testDate, setTestDate] = useState(today());
  const [lab, setLab] = useState("Kovera");
  const [purity, setPurity] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (preselect) { setSkuCode(preselect); setMsg(null); } }, [preselect]);

  const selected = skus.find((s) => s.sku_code === skuCode);
  const ready = Boolean(file && skuCode && /^\d{4}-\d{2}-\d{2}$/.test(testDate)) && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || !file) return;
    setBusy(true); setMsg(null);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("sku_code", skuCode);
    fd.append("test_date", testDate);
    if (lab.trim()) fd.append("lab_name", lab.trim());
    if (purity.trim()) fd.append("purity", purity.trim());
    try {
      const r = await fetch("/api/ops/realpeptides/coa/upload", { method: "POST", body: fd, credentials: "include" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setMsg({ ok: true, text: `Filed for ${body.sku?.product_name ?? skuCode} — tested ${testDate}, valid until ${body.coa?.expiry_date ? String(body.coa.expiry_date).slice(0, 10) : "—"}.` });
      setFile(null); setPurity("");
      if (fileRef.current) fileRef.current.value = "";
      onDone();
    } catch (err: any) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text placeholder:text-ops-text-muted focus:border-fitscript-green focus:outline-none";
  const label = "mb-1 block text-[11px] uppercase tracking-wider text-ops-text-muted";

  return (
    <form onSubmit={submit} className="mb-6 rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <div>
          <div className="text-base font-semibold text-ops-text">Upload a new COA</div>
          <p className="mt-0.5 text-xs text-ops-text-muted">
            Records the test and files the PDF in the tracker's vault in one step. The product goes fresh immediately.
          </p>
        </div>
        {selected && (
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${BADGE[selected.status]}`}>
            currently {selected.status}{selected.expiry_date ? ` · expires ${selected.expiry_date}` : ""}
          </span>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-12">
        <div className="md:col-span-5">
          <label className={label} htmlFor="coa-sku">Product</label>
          <select id="coa-sku" value={skuCode} onChange={(e) => { setSkuCode(e.target.value); setMsg(null); }} className={input} required>
            <option value="">Choose a product…</option>
            {skus.map((s) => (
              <option key={s.sku_code} value={s.sku_code}>{s.product_name} · {s.sku_code} ({s.status})</option>
            ))}
          </select>
        </div>
        <div className="md:col-span-2">
          <label className={label} htmlFor="coa-date">Test date</label>
          <input id="coa-date" type="date" value={testDate} max={today()} onChange={(e) => setTestDate(e.target.value)} className={input} required />
        </div>
        <div className="md:col-span-3">
          <label className={label} htmlFor="coa-lab">Lab</label>
          <input id="coa-lab" value={lab} onChange={(e) => setLab(e.target.value)} className={input} placeholder="Kovera" />
        </div>
        <div className="md:col-span-2">
          <label className={label} htmlFor="coa-purity">Purity</label>
          <input id="coa-purity" value={purity} onChange={(e) => setPurity(e.target.value)} className={input} placeholder="99.4%" />
        </div>
        <div className="md:col-span-9">
          <label className={label} htmlFor="coa-file">Certificate (PDF)</label>
          <input
            id="coa-file" ref={fileRef} type="file" accept="application/pdf,.pdf"
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setMsg(null); }}
            className="block w-full text-sm text-ops-text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-ops-border file:px-3 file:py-2 file:text-sm file:font-medium file:text-ops-text hover:file:bg-ops-border/70"
          />
        </div>
        <div className="flex items-end md:col-span-3">
          <button
            type="submit" disabled={!ready}
            className="w-full rounded-lg bg-fitscript-green px-4 py-2 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-40 hover:bg-fitscript-green/90"
          >
            {busy ? "Uploading…" : "File COA"}
          </button>
        </div>
      </div>

      {msg && (
        <div className={`mt-4 rounded-lg border p-3 text-sm ${msg.ok ? "border-fitscript-green/30 bg-fitscript-green/10 text-fitscript-green" : "border-red-500/30 bg-red-500/10 text-red-400"}`}>
          {msg.text}
        </div>
      )}
    </form>
  );
}

export default function RealPeptidesCoa() {
  const qc = useQueryClient();
  const [preselect, setPreselect] = useState<string | null>(null);

  const { data, isLoading } = useQuery<Coa>({
    queryKey: ["realpeptides-coa"],
    queryFn: async () => {
      const r = await fetch("/api/ops/realpeptides/coa", { credentials: "include" });
      try { return await r.json(); } catch { return { error: `Request failed (HTTP ${r.status})` }; }
    },
  });
  const { data: me } = useQuery<{ role: string; permissions?: string[] }>({
    queryKey: ["ops-me"],
    queryFn: async () => (await fetch("/api/ops/auth/me", { credentials: "include" })).json(),
    staleTime: Infinity,
  });
  const canUpload = me?.role === "admin" || (me?.permissions ?? []).includes("realpeptides:coa-upload");

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
          {canUpload && (
            <UploadCoa
              skus={data?.skus ?? []}
              preselect={preselect}
              onDone={() => qc.invalidateQueries({ queryKey: ["realpeptides-coa"] })}
            />
          )}

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
                  {canUpload && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {(data?.skus ?? []).length === 0 && (
                  <tr><td colSpan={canUpload ? 7 : 6} className="px-4 py-8 text-center text-ops-text-muted">No SKUs require a COA.</td></tr>
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
                    {canUpload && (
                      <td className="px-4 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => { setPreselect(s.sku_code); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                          className="text-xs font-medium text-fitscript-green hover:underline"
                        >
                          Upload COA
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-ops-text-muted">
            {canUpload ? "Everything else — lab send-outs, product images, the vault — lives at" : "Read-only. Upload COAs and mark tests at"}{" "}
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
