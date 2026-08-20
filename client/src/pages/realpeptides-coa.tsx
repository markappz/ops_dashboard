import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";

/**
 * Real Peptides COA manager — the one place certificates are handled.
 *
 * The COA tracker service (coa.realpeptides.co) still owns the data: its
 * database, the S3 vault and the Slack/Kovera schedulers keep running headless.
 * Its own UI is retired; everything here goes through ops' token-gated proxy.
 */

type Status = "expired" | "expiring" | "untested" | "fresh";

interface Sku {
  id: number;
  sku_code: string;
  product_name: string;
  status: Status;
  daysLeft: number | null;
  test_date: string | null;
  expiry_date: string | null;
  lab_name: string | null;
  doc_id: number | null;
  doc_file_name: string | null;
  doc_count: number;
}

interface Coa {
  configured?: boolean;
  hint?: string;
  generatedAt?: string;
  validityDays?: number;
  totals?: { tracked: number; expired: number; expiring: number; untested: number; fresh: number };
  skus?: Sku[];
  error?: string;
}

const API = "/api/ops/realpeptides/coa/api";
const num = (n: number | undefined) => (n ?? 0).toLocaleString();
const today = () => new Date().toISOString().slice(0, 10);

const BADGE: Record<Status, string> = {
  expired: "bg-red-500/15 text-red-400",
  expiring: "bg-yellow-500/15 text-yellow-500",
  untested: "bg-ops-border text-ops-text-muted",
  fresh: "bg-fitscript-green/15 text-fitscript-green",
};

const input = "w-full rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text placeholder:text-ops-text-muted focus:border-fitscript-green focus:outline-none";
const label = "mb-1 block text-[11px] uppercase tracking-wider text-ops-text-muted";
const primary = "rounded-lg bg-fitscript-green px-4 py-2 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-40 hover:bg-fitscript-green/90";
const ghost = "rounded-lg border border-ops-border px-3 py-2 text-sm text-ops-text-muted hover:text-ops-text";

async function call(path: string, init?: RequestInit) {
  const r = await fetch(path, { credentials: "include", ...init });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "bad" | "warn" | "good" }) {
  const c = tone === "bad" ? "text-red-400" : tone === "warn" ? "text-yellow-500" : tone === "good" ? "text-fitscript-green" : "text-ops-text";
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-4 shadow-card">
      <div className="text-[11px] uppercase tracking-wider text-ops-text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${c}`}>{value}</div>
    </div>
  );
}

/** Test date + lab + purity + file. Used at the top (with a product picker) and inline per row. */
function CoaForm({ skus, fixedSku, compact, onDone }: { skus: Sku[]; fixedSku?: Sku; compact?: boolean; onDone: (msg: string) => void }) {
  const [skuCode, setSkuCode] = useState(fixedSku?.sku_code ?? "");
  const [testDate, setTestDate] = useState(today());
  const [lab, setLab] = useState("Kovera");
  const [purity, setPurity] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const selected = fixedSku ?? skus.find((s) => s.sku_code === skuCode);
  const ready = Boolean(file && skuCode && /^\d{4}-\d{2}-\d{2}$/.test(testDate)) && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || !file) return;
    setBusy(true); setErr(null);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("sku_code", skuCode);
    fd.append("test_date", testDate);
    if (lab.trim()) fd.append("lab_name", lab.trim());
    if (purity.trim()) fd.append("purity", purity.trim());
    try {
      const body = await call("/api/ops/realpeptides/coa/upload", { method: "POST", body: fd });
      const exp = body.coa?.expiry_date ? String(body.coa.expiry_date).slice(0, 10) : "—";
      onDone(`Filed for ${body.sku?.product_name ?? skuCode} — tested ${testDate}, valid until ${exp}.`);
      setFile(null); setPurity("");
      if (fileRef.current) fileRef.current.value = "";
      if (!fixedSku) setSkuCode("");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className={compact ? "grid gap-3 md:grid-cols-12" : "grid gap-4 md:grid-cols-12"}>
      {!fixedSku && (
        <div className="md:col-span-5">
          <label className={label} htmlFor="coa-sku">Product</label>
          <select id="coa-sku" value={skuCode} onChange={(e) => setSkuCode(e.target.value)} className={input} required>
            <option value="">Choose a product…</option>
            {skus.map((s) => <option key={s.sku_code} value={s.sku_code}>{s.product_name} · {s.sku_code} ({s.status})</option>)}
          </select>
        </div>
      )}
      <div className={fixedSku ? "md:col-span-2" : "md:col-span-2"}>
        <label className={label}>Test date</label>
        <input type="date" value={testDate} max={today()} onChange={(e) => setTestDate(e.target.value)} className={input} required />
      </div>
      <div className={fixedSku ? "md:col-span-2" : "md:col-span-3"}>
        <label className={label}>Lab</label>
        <input value={lab} onChange={(e) => setLab(e.target.value)} className={input} placeholder="Kovera" />
      </div>
      <div className="md:col-span-2">
        <label className={label}>Purity</label>
        <input value={purity} onChange={(e) => setPurity(e.target.value)} className={input} placeholder="99.4%" />
      </div>
      <div className={fixedSku ? "md:col-span-4" : "md:col-span-9"}>
        <label className={label}>Certificate (PDF or image)</label>
        <input
          ref={fileRef} type="file" accept="application/pdf,.pdf,image/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-ops-text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-ops-border file:px-3 file:py-2 file:text-sm file:font-medium file:text-ops-text hover:file:bg-ops-border/70"
        />
      </div>
      <div className={`flex items-end ${fixedSku ? "md:col-span-2" : "md:col-span-3"}`}>
        <button type="submit" disabled={!ready} className={`w-full ${primary}`}>{busy ? "Uploading…" : "File COA"}</button>
      </div>
      {selected && !fixedSku && (
        <div className="md:col-span-12 -mt-2 text-xs text-ops-text-muted">
          Currently <span className={`rounded px-1.5 py-0.5 ${BADGE[selected.status]}`}>{selected.status}</span>
          {selected.expiry_date ? ` · expires ${selected.expiry_date}` : ""}
        </div>
      )}
      {err && <div className="md:col-span-12 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{err}</div>}
    </form>
  );
}

function AddProduct({ onDone }: { onDone: (msg: string) => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await call(`${API}/skus`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product_name: name.trim(), sku_code: code.trim() }) });
      onDone(`Added ${name.trim()} (${code.trim()}). It shows as never tested until a COA is filed.`);
      setName(""); setCode("");
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="mb-6 rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
      <div className="mb-3 text-base font-semibold text-ops-text">Add a product</div>
      <div className="grid gap-4 md:grid-cols-12">
        <div className="md:col-span-6">
          <label className={label}>Product name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className={input} placeholder="BPC-157 - 10mg (Injectable)" required />
        </div>
        <div className="md:col-span-3">
          <label className={label}>SKU code</label>
          <input value={code} onChange={(e) => setCode(e.target.value)} className={input} placeholder="RP-BPC10V" required />
        </div>
        <div className="flex items-end md:col-span-3">
          <button type="submit" disabled={busy || !name.trim() || !code.trim()} className={`w-full ${primary}`}>{busy ? "Adding…" : "Add product"}</button>
        </div>
      </div>
      {err && <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{err}</div>}
    </form>
  );
}

function Row({ s, skus, canEdit, onChanged }: { s: Sku; skus: Sku[]; canEdit: boolean; onChanged: (msg: string) => void }) {
  const [mode, setMode] = useState<"idle" | "upload" | "rename">("idle");
  const [name, setName] = useState(s.product_name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setName(s.product_name); }, [s.product_name]);

  async function rename(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || name.trim() === s.product_name) { setMode("idle"); return; }
    setBusy(true); setErr(null);
    try {
      await call(`${API}/skus/${s.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ product_name: name.trim() }) });
      setMode("idle");
      onChanged(`Renamed to ${name.trim()}.`);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  async function remove() {
    if (!confirm(`Delete ${s.product_name} (${s.sku_code})?\n\nIt leaves the list; its certificates stay in the vault.`)) return;
    setBusy(true); setErr(null);
    try {
      await call(`${API}/skus/${s.id}`, { method: "DELETE" });
      onChanged(`Deleted ${s.product_name}.`);
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }

  const cols = canEdit ? 8 : 7;
  return (
    <>
      <tr className={`border-b border-ops-border/50 last:border-0 ${mode !== "idle" ? "bg-ops-bg/40" : ""}`}>
        <td className="px-4 py-2.5 text-ops-text">
          {mode === "rename" ? (
            <form onSubmit={rename} className="flex items-center gap-2">
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={input} onKeyDown={(e) => e.key === "Escape" && setMode("idle")} />
              <button type="submit" disabled={busy} className={primary}>Save</button>
              <button type="button" onClick={() => { setMode("idle"); setName(s.product_name); }} className={ghost}>Cancel</button>
            </form>
          ) : s.product_name}
        </td>
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
        <td className="px-4 py-2.5 text-ops-text-muted">
          {s.doc_id ? (
            <a href={`${API}/documents/${s.doc_id}/download?inline=1`} target="_blank" rel="noreferrer" className="text-fitscript-green hover:underline" title={s.doc_file_name ?? ""}>
              View{s.doc_count > 1 ? ` (${s.doc_count})` : ""}
            </a>
          ) : "—"}
        </td>
        {canEdit && (
          <td className="whitespace-nowrap px-4 py-2.5 text-right text-xs">
            <button type="button" onClick={() => { setMode(mode === "upload" ? "idle" : "upload"); setErr(null); }} className="font-medium text-fitscript-green hover:underline">
              {mode === "upload" ? "Close" : "Upload COA"}
            </button>
            <span className="mx-2 text-ops-border">·</span>
            <button type="button" onClick={() => setMode("rename")} className="text-ops-text-muted hover:text-ops-text">Rename</button>
            <span className="mx-2 text-ops-border">·</span>
            <button type="button" onClick={remove} disabled={busy} className="text-ops-text-muted hover:text-red-400 disabled:opacity-40">Delete</button>
          </td>
        )}
      </tr>
      {(mode === "upload" || err) && (
        <tr className="border-b border-ops-border/50 bg-ops-bg/40">
          <td colSpan={cols} className="px-4 pb-4 pt-1">
            {mode === "upload" && (
              <div className="rounded-lg border border-ops-border bg-ops-surface p-4">
                <div className="mb-3 text-xs text-ops-text-muted">New certificate for <span className="text-ops-text">{s.product_name}</span> · {s.sku_code}</div>
                <CoaForm skus={skus} fixedSku={s} compact onDone={(m) => { setMode("idle"); onChanged(m); }} />
              </div>
            )}
            {err && <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{err}</div>}
          </td>
        </tr>
      )}
    </>
  );
}

export default function RealPeptidesCoa() {
  const qc = useQueryClient();
  const [flash, setFlash] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");

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
  const canEdit = me?.role === "admin" || (me?.permissions ?? []).includes("realpeptides:coa-upload");

  function changed(msg: string) {
    setFlash(msg);
    qc.invalidateQueries({ queryKey: ["realpeptides-coa"] });
  }
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(t);
  }, [flash]);

  const t = data?.totals;
  const all = data?.skus ?? [];
  const needle = q.trim().toLowerCase();
  const skus = needle ? all.filter((s) => s.product_name.toLowerCase().includes(needle) || s.sku_code.toLowerCase().includes(needle)) : all;

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides"
        title="COA Tracker"
        subtitle={`Certificates per product${data?.validityDays ? ` — valid ${data.validityDays} days from test date` : ""}. Upload, add, rename and remove products here; Slack alerts and the weekly Kovera list run on their own.`}
        actions={canEdit && t ? (
          <button type="button" onClick={() => setAdding((a) => !a)} className={adding ? ghost : primary}>{adding ? "Close" : "+ Add product"}</button>
        ) : undefined}
      />

      {isLoading && <div className="text-sm text-ops-text-muted">Loading…</div>}
      {data?.error && <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{data.error}</div>}
      {flash && <div className="mb-6 rounded-xl border border-fitscript-green/30 bg-fitscript-green/10 p-3 text-sm text-fitscript-green">{flash}</div>}

      {!isLoading && data?.configured === false && (
        <div className="rounded-xl border border-ops-border bg-ops-surface p-6 shadow-card">
          <div className="text-lg font-medium text-ops-text">Not connected to the COA tracker</div>
          <p className="mt-2 max-w-2xl text-sm text-ops-text-muted">{data.hint}</p>
        </div>
      )}

      {t && (
        <>
          {canEdit && adding && <AddProduct onDone={(m) => { setAdding(false); changed(m); }} />}

          {canEdit && (
            <div className="mb-6 rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
              <div className="mb-4">
                <div className="text-base font-semibold text-ops-text">Upload a new COA</div>
                <p className="mt-0.5 text-xs text-ops-text-muted">Records the test and files the certificate in the vault. The product goes fresh immediately.</p>
              </div>
              <CoaForm skus={all} onDone={changed} />
            </div>
          )}

          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat label="Tracked SKUs" value={num(t.tracked)} />
            <Stat label="Expired" value={num(t.expired)} tone={t.expired > 0 ? "bad" : undefined} />
            <Stat label="Expiring" value={num(t.expiring)} tone={t.expiring > 0 ? "warn" : undefined} />
            <Stat label="Never tested" value={num(t.untested)} tone={t.untested > 0 ? "warn" : undefined} />
            <Stat label="Fresh" value={num(t.fresh)} tone="good" />
          </div>

          <div className="mb-3 flex items-center justify-between gap-3">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products or SKUs…" className={`${input} max-w-sm`} />
            <span className="text-xs text-ops-text-muted">{skus.length} of {all.length}</span>
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
                  <th className="px-4 py-3 font-medium">Certificate</th>
                  {canEdit && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {skus.length === 0 && (
                  <tr><td colSpan={canEdit ? 8 : 7} className="px-4 py-8 text-center text-ops-text-muted">{needle ? "No products match." : "No products yet."}</td></tr>
                )}
                {skus.map((s) => <Row key={s.id} s={s} skus={all} canEdit={canEdit} onChanged={changed} />)}
              </tbody>
            </table>
          </div>

          {data?.generatedAt && <p className="mt-3 text-xs text-ops-text-muted">Data as of {new Date(data.generatedAt).toLocaleString()}.</p>}
        </>
      )}
    </div>
  );
}
