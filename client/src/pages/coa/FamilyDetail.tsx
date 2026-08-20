import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { X, Download, Upload, FileText, Image as ImageIcon, BadgeCheck, Eye, FlaskConical, Pencil, Trash2, Link as LinkIcon, History } from "lucide-react";
import { API, PILL, api, ui, type Family, type SkuDetail, type Doc, type Sku } from "./api";
import { variantLabel, sortCoasByDate } from "./families";

const today = () => new Date().toISOString().slice(0, 10);

export function FamilyDetail({ family, onClose, onChanged }: { family: Family; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const ids = family.variants.map((v) => v.id);
  const { data, refetch } = useQuery({
    queryKey: ["coa-family", family.key, ids],
    queryFn: () => Promise.all(ids.map((id) => api<SkuDetail>(`/skus/${id}`))),
    // Keep the cards mounted while a refetch is in flight so open panels survive.
    placeholderData: keepPreviousData,
  });

  const bump = async () => { await refetch(); qc.invalidateQueries({ queryKey: ["coa-skus"] }); onChanged(); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={ui.modal} onClick={onClose}>
      <div className={`${ui.sheet} max-w-2xl`} onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center gap-4 rounded-t-2xl border-b border-ops-border bg-ops-surface p-5">
          <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-ops-border bg-ops-bg">
            {family.thumbnail && <img src={family.thumbnail} alt="" className="h-full w-full object-cover" />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-ops-text">{family.label}</h2>
            <div className="mt-0.5 text-xs text-ops-text-muted">{family.variants.length} variant{family.variants.length > 1 ? "s" : ""}</div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-ops-text-muted hover:text-ops-text" aria-label="Close"><X size={20} /></button>
        </div>
        <div className="space-y-3 p-4">
          {!data ? <div className="py-10 text-center text-sm text-ops-text-muted">Loading…</div>
            : data.map((d) => {
              const status = family.variants.find((v) => v.id === d.sku.id)?.status ?? "untested";
              return <Variant key={d.sku.id} detail={d} familyName={family.label} status={status} onChanged={bump} onDeleted={() => { bump(); if (data.length === 1) onClose(); }} />;
            })}
        </div>
      </div>
    </div>
  );
}

function Variant({ detail, status, familyName, onChanged, onDeleted }: {
  detail: SkuDetail; status: string; familyName: string; onChanged: () => Promise<void>; onDeleted: () => void;
}) {
  const sku = detail.sku;
  const [panel, setPanel] = useState<"none" | "upload" | "edit" | "history" | "preview">("none");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const imgRef = useRef<HTMLInputElement>(null);
  const orynRef = useRef<HTMLInputElement>(null);

  const newest = detail.coas[0];
  const coaDocs = sortCoasByDate(detail.documents.filter((d) => d.category !== "product_image" && d.brand !== "oryn"));
  const orynDocs = detail.documents.filter((d) => d.category !== "product_image" && d.brand === "oryn");
  const productImg = detail.documents.find((d) => d.category === "product_image");
  const atLab = detail.tests.some((t) => t.status === "in_testing" || t.status === "sent");
  const needsTesting = status === "expired" || status === "untested";

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); await onChanged(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function uploadDoc(file: File, extra: Record<string, string>) {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("sku_id", String(sku.id));
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    await api("/documents", { method: "POST", body: fd });
  }
  function onImage(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    run(() => uploadDoc(f, { category: "product_image" })).finally(() => { if (imgRef.current) imgRef.current.value = ""; });
  }
  function onOryn(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    run(() => uploadDoc(f, { brand: "oryn" })).finally(() => { if (orynRef.current) orynRef.current.value = ""; });
  }
  const setSent = (sent: boolean) => run(() => api(`/skus/${sku.id}/${sent ? "mark-sent" : "mark-unsent"}`, { method: "POST" }));
  const remove = () => {
    if (!confirm(`Delete ${sku.product_name} (${sku.sku_code})?\n\nIt leaves the list; its certificates stay in the vault.`)) return;
    setBusy(true); setErr(null);
    api(`/skus/${sku.id}`, { method: "DELETE" }).then(onDeleted).catch((e) => { setErr(e.message); setBusy(false); });
  };
  const toggle = (p: typeof panel) => setPanel(panel === p ? "none" : p);

  return (
    <div data-variant={sku.sku_code} data-panel={panel} className="overflow-hidden rounded-2xl border border-ops-border bg-ops-surface">
      <div className="flex items-center justify-between gap-3 border-b border-ops-border bg-ops-bg/40 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="h-9 w-1.5 shrink-0 rounded-full bg-fitscript-green" />
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold leading-tight text-ops-text">{variantLabel(sku, familyName)}</div>
            <div className="text-[11px] text-ops-text-muted">
              {sku.sku_code}{newest ? ` · tested ${newest.test_date} · expires ${newest.expiry_date}` : " · no test on record"}
              {sku.product_url && <> · <a href={sku.product_url} target="_blank" rel="noreferrer" className="text-fitscript-green hover:underline">product page</a></>}
            </div>
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${PILL[status] ?? PILL.untested}`}>{status === "untested" ? "No COA" : status}</span>
      </div>

      <div className="grid grid-cols-3 gap-2 p-3">
        <Tile onClick={coaDocs.length ? () => toggle("preview") : undefined} icon={<BadgeCheck size={16} />} label="COA" action="Preview" count={coaDocs.length} />
        <Tile href={productImg ? `${API}/skus/${sku.id}/product-image-download` : undefined} icon={<ImageIcon size={16} />} label="Product image" />
        <Tile onClick={() => toggle("history")} icon={<History size={16} />} label="History" action="View" count={detail.coas.length} />
      </div>

      <div className="-mt-1 flex flex-wrap items-center justify-between gap-2 px-3 pb-3">
        <input ref={imgRef} type="file" hidden accept="image/*" onChange={onImage} />
        <input ref={orynRef} type="file" hidden accept=".pdf" onChange={onOryn} />
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          <Act onClick={() => toggle("upload")} icon={<Upload size={11} />} label="Upload COA" active={panel === "upload"} />
          <Act onClick={() => imgRef.current?.click()} icon={<ImageIcon size={11} />} label={productImg ? "Replace image" : "Product image"} disabled={busy} />
          <Act onClick={() => orynRef.current?.click()} icon={<Upload size={11} />} label={orynDocs.length ? `Oryn cert ✓ (${orynDocs.length})` : "Oryn cert"} disabled={busy} title="Oryn-branded copy of this cert — syncs to the Oryn Biologix portal" />
          <Act onClick={() => toggle("edit")} icon={<Pencil size={11} />} label="Edit" active={panel === "edit"} />
          <Act onClick={remove} icon={<Trash2 size={11} />} label="Delete" disabled={busy} danger />
        </span>
        {atLab ? (
          <span className="inline-flex items-center gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1 font-medium text-yellow-500"><FlaskConical size={11} /> At lab — awaiting results</span>
            <button type="button" onClick={() => setSent(false)} className="text-ops-text-muted underline hover:text-ops-text">Undo</button>
          </span>
        ) : needsTesting ? (
          <button type="button" onClick={() => setSent(true)} disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-fitscript-green/40 px-2 py-1 text-[11px] font-semibold text-fitscript-green hover:bg-fitscript-green/10">
            <FlaskConical size={11} /> Mark sent to Kovera
          </button>
        ) : null}
      </div>

      {panel === "upload" && (
        <div className="border-t border-ops-border p-4">
          <CoaUpload sku={sku} onDone={() => { setPanel("none"); return onChanged(); }} />
        </div>
      )}
      {panel === "edit" && (
        <div className="border-t border-ops-border p-4">
          <EditSku sku={sku} onDone={() => { setPanel("none"); return onChanged(); }} />
        </div>
      )}
      {panel === "history" && (
        <div className="border-t border-ops-border p-4">
          <HistoryList detail={detail} />
        </div>
      )}
      {panel === "preview" && <CoaPreview docs={coaDocs} skuId={sku.id} title={`${familyName} · ${variantLabel(sku, familyName)}`} onClose={() => setPanel("none")} />}
      {err && <div className="mx-3 mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{err}</div>}
    </div>
  );
}

function Act({ onClick, icon, label, active, disabled, danger, title }: { onClick: () => void; icon: React.ReactNode; label: string; active?: boolean; disabled?: boolean; danger?: boolean; title?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      className={`inline-flex items-center gap-1 disabled:opacity-50 ${active ? "text-fitscript-green" : danger ? "text-ops-text-muted hover:text-red-400" : "text-ops-text-muted hover:text-ops-text"}`}>
      {icon} {label}
    </button>
  );
}

function Tile({ href, onClick, icon, label, action = "Download", count }: { href?: string; onClick?: () => void; icon: React.ReactNode; label: string; action?: string; count?: number }) {
  const cls = "flex flex-col items-center justify-center gap-1.5 rounded-xl border py-3 text-xs font-semibold transition";
  if (!href && !onClick) {
    return <span className={`${cls} cursor-not-allowed border-ops-border bg-ops-bg/40 text-ops-text-muted/50`}>{icon}<span>{label}</span><span className="-mt-1 text-[9px] font-normal">none</span></span>;
  }
  const inner = (
    <>
      <span className="text-fitscript-green">{icon}</span>
      <span className="text-ops-text">{label}{count ? ` (${count})` : ""}</span>
      <span className="-mt-1 inline-flex items-center gap-0.5 text-[9px] font-normal text-ops-text-muted">{action === "Download" ? <Download size={9} /> : <Eye size={9} />} {action}</span>
    </>
  );
  const style = `${cls} border-ops-border bg-ops-surface hover:border-fitscript-green/50`;
  return onClick ? <button type="button" onClick={onClick} className={style}>{inner}</button> : <a href={href} className={style}>{inner}</a>;
}

/** Records the test and vaults the file in one call (the tracker's ops-coa-upload). */
export function CoaUpload({ sku, onDone }: { sku: Pick<Sku, "sku_code" | "product_name">; onDone: () => Promise<void> }) {
  const [testDate, setTestDate] = useState(today());
  const [lab, setLab] = useState("Kovera");
  const [purity, setPurity] = useState("");
  const [lot, setLot] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true); setErr(null);
    const fd = new FormData();
    fd.append("file", file); fd.append("sku_code", sku.sku_code); fd.append("test_date", testDate);
    if (lab.trim()) fd.append("lab_name", lab.trim());
    if (purity.trim()) fd.append("purity", purity.trim());
    if (lot.trim()) fd.append("lot_number", lot.trim());
    try {
      const r = await fetch("/api/ops/realpeptides/coa/upload", { method: "POST", body: fd, credentials: "include" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setBusy(false);
      void onDone();
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-12">
      <div className="md:col-span-12 text-xs text-ops-text-muted">New certificate for <span className="text-ops-text">{sku.product_name}</span> — this records the test, so the status updates immediately.</div>
      <div className="md:col-span-3"><label className={ui.label}>Test date</label><input type="date" value={testDate} max={today()} onChange={(e) => setTestDate(e.target.value)} className={ui.input} required /></div>
      <div className="md:col-span-3"><label className={ui.label}>Lot / batch #</label><input value={lot} onChange={(e) => setLot(e.target.value)} className={ui.input} placeholder="What's printed on the vial" /></div>
      <div className="md:col-span-3"><label className={ui.label}>Lab</label><input value={lab} onChange={(e) => setLab(e.target.value)} className={ui.input} /></div>
      <div className="md:col-span-3"><label className={ui.label}>Purity</label><input value={purity} onChange={(e) => setPurity(e.target.value)} className={ui.input} placeholder="99.4%" /></div>
      <div className="md:col-span-12"><label className={ui.label}>File (PDF or image)</label>
        <input type="file" accept="application/pdf,.pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-ops-text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-ops-border file:px-3 file:py-2 file:text-sm file:font-medium file:text-ops-text" />
      </div>
      <div className="md:col-span-12 flex justify-end"><button type="submit" disabled={!file || busy} className={ui.primary}>{busy ? "Uploading…" : "File COA"}</button></div>
      {err && <div className="md:col-span-12 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{err}</div>}
    </form>
  );
}

function EditSku({ sku, onDone }: { sku: Sku; onDone: () => Promise<void> }) {
  const [name, setName] = useState(sku.product_name);
  const [code, setCode] = useState(sku.sku_code);
  const [url, setUrl] = useState(sku.product_url ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api(`/skus/${sku.id}`, { method: "PATCH", body: JSON.stringify({ product_name: name.trim(), sku_code: code.trim(), product_url: url.trim() }) });
      setBusy(false);
      void onDone();
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-12">
      <div className="md:col-span-6"><label className={ui.label}>Product name</label><input value={name} onChange={(e) => setName(e.target.value)} className={ui.input} required /></div>
      <div className="md:col-span-3"><label className={ui.label}>SKU code</label><input value={code} onChange={(e) => setCode(e.target.value)} className={ui.input} required /></div>
      <div className="md:col-span-3 flex items-end"><button type="submit" disabled={busy} className={`w-full ${ui.primary}`}>{busy ? "Saving…" : "Save"}</button></div>
      <div className="md:col-span-12">
        <label className={ui.label}><span className="inline-flex items-center gap-1"><LinkIcon size={10} /> Product page URL</span></label>
        <input value={url} onChange={(e) => setUrl(e.target.value)} className={ui.input} placeholder="https://realpeptides.co/product/bpc-157-10mg" type="url" />
        <p className="mt-1 text-[11px] text-ops-text-muted">Links this certificate to its page on the site. The public feed exposes it so product pages and the COA page can show the live certificate.</p>
      </div>
      {err && <div className="md:col-span-12 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{err}</div>}
    </form>
  );
}

function HistoryList({ detail }: { detail: SkuDetail }) {
  const docs = detail.documents.filter((d) => d.category !== "product_image");
  return (
    <div className="space-y-4 text-sm">
      <div>
        <div className="mb-1.5 text-[11px] uppercase tracking-wider text-ops-text-muted">Tests on record</div>
        {detail.coas.length === 0 && <div className="text-xs text-ops-text-muted">None yet.</div>}
        <ul className="divide-y divide-ops-border/50 rounded-lg border border-ops-border">
          {detail.coas.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="text-ops-text">Tested {c.test_date} <span className="text-ops-text-muted">→ expires {c.expiry_date}</span></span>
              <span className="text-xs text-ops-text-muted">{c.lot_number ? `lot ${c.lot_number} · ` : ""}{c.lab_name ?? "—"}{c.purity ? ` · ${c.purity}` : ""}{c.result !== "pass" ? ` · ${c.result}` : ""}{c.source_ref ? ` · by ${c.source_ref}` : ""}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <div className="mb-1.5 text-[11px] uppercase tracking-wider text-ops-text-muted">Files in the vault</div>
        {docs.length === 0 && <div className="text-xs text-ops-text-muted">No files yet.</div>}
        <ul className="divide-y divide-ops-border/50 rounded-lg border border-ops-border">
          {docs.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <a href={`${API}/documents/${d.id}/download?inline=1`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-fitscript-green hover:underline"><FileText size={13} /> {d.file_name}</a>
              <span className="text-xs text-ops-text-muted">{d.brand === "oryn" ? "Oryn · " : ""}{new Date(d.uploaded_at).toLocaleDateString()} · {d.source.replace("_", " ")}</span>
            </li>
          ))}
        </ul>
      </div>
      {detail.tests.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] uppercase tracking-wider text-ops-text-muted">Lab send-outs</div>
          <ul className="divide-y divide-ops-border/50 rounded-lg border border-ops-border">
            {detail.tests.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="text-ops-text">{t.status.replace("_", " ")}</span>
                <span className="text-xs text-ops-text-muted">{new Date(t.created_at).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CoaPreview({ docs, skuId, title, onClose }: { docs: Doc[]; skuId: number; title: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/70 p-2 backdrop-blur-sm sm:p-4" onClick={onClose}>
      <div className={`${ui.sheet} max-w-lg`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-ops-border p-4">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-ops-text">{title}</div>
            <div className="text-[11px] text-ops-text-muted">{docs.length} COA file{docs.length > 1 ? "s" : ""}</div>
          </div>
          <a href={`${API}/skus/${skuId}/coa-download`} className={ui.primary}><Download size={14} /> Download</a>
          <button type="button" onClick={onClose} className="p-1 text-ops-text-muted hover:text-ops-text"><X size={20} /></button>
        </div>
        <div className="space-y-3 p-4">
          {docs.map((d) => (
            <a key={d.id} href={`${API}/documents/${d.id}/download?inline=1`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border border-ops-border transition hover:border-fitscript-green/50">
              {d.doc_type === "image"
                ? <img src={`${API}/documents/${d.id}/download?inline=1`} alt={d.file_name} className="w-full" loading="lazy" />
                : <div className="flex items-center gap-2 p-4 text-sm text-ops-text"><FileText size={18} className="text-fitscript-green" /> {d.file_name} <span className="text-xs text-ops-text-muted">(open)</span></div>}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
