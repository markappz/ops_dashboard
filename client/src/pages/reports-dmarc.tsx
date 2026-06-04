import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useRef, type DragEvent, type ChangeEvent } from "react";
import { PageHero } from "../components/page-hero";
import { InlineError, hasApiError } from "../components/query-error";

type Days = 7 | 30 | 90 | 365;
const WINDOWS: Array<{ days: Days; label: string }> = [
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
  { days: 365, label: "12m" },
];

interface DmarcAggregate {
  window_days: Days;
  generated_at: string;
  summary: {
    reports_count: number;
    total_messages: number;
    aligned_messages: number;
    aligned_pct: number | null;
    dkim_pass_pct: number | null;
    spf_pass_pct: number | null;
    quarantine: number;
    reject: number;
  };
  senders: Array<{
    source_ip: string;
    header_from: string | null;
    messages: number;
    pct_aligned: number | null;
    dkim_pass_pct: number | null;
    spf_pass_pct: number | null;
  }>;
  reporting_orgs: Array<{ org_name: string; reports: number; messages: number }>;
  recent_reports: Array<{
    id: string;
    org_name: string;
    domain: string;
    date_range_start: string;
    date_range_end: string;
    total_messages: number;
    policy_p: string | null;
  }>;
}

function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString();
}
function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${v.toFixed(1)}%`;
}
function toneForAlignment(v: number | null): "good" | "warn" | "bad" | null {
  if (v === null) return null;
  if (v >= 95) return "good";
  if (v >= 80) return "warn";
  return "bad";
}

function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "warn" | "bad" | null;
}) {
  const toneCls =
    tone === "good"
      ? "text-emerald-500"
      : tone === "warn"
        ? "text-amber-500"
        : tone === "bad"
          ? "text-red-400"
          : "text-ops-text";
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-4 sm:p-5 hover:border-brand-blue-400/40 transition-colors">
      <div className="text-[10px] tracking-[0.14em] uppercase font-semibold text-ops-text-subtle">
        {label}
      </div>
      <div className={`mt-2 text-2xl sm:text-[28px] font-bold tracking-tight ${toneCls}`}>{value}</div>
      {hint && <div className="mt-1 text-[11px] text-ops-text-muted">{hint}</div>}
    </div>
  );
}

function SectionTitle({ children, subtitle }: { children: React.ReactNode; subtitle?: string }) {
  return (
    <div className="mt-8 mb-3">
      <div className="text-[11px] tracking-[0.14em] uppercase font-semibold text-brand-blue-500">{children}</div>
      {subtitle && <div className="mt-0.5 text-[11px] text-ops-text-subtle">{subtitle}</div>}
    </div>
  );
}

function UploadCard({ onUploaded }: { onUploaded: () => void }) {
  const [dragOver, setDragOver] = useState(false);
  const [log, setLog] = useState<Array<{ name: string; status: "ok" | "dup" | "fail"; detail: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadMut = useMutation({
    mutationFn: async (file: File) => {
      const r = await fetch(`/api/ops/dmarc/upload?filename=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      return body;
    },
  });

  const handleFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    for (const file of arr) {
      try {
        const res = await uploadMut.mutateAsync(file);
        setLog((prev) => [
          {
            name: file.name,
            status: res.duplicate ? "dup" : "ok",
            detail: res.duplicate
              ? `Already ingested (${res.org_name} → ${res.domain})`
              : `${res.org_name} · ${res.records_count} records · ${res.total_messages} messages`,
          },
          ...prev,
        ]);
      } catch (e) {
        setLog((prev) => [
          { name: file.name, status: "fail", detail: (e as Error).message },
          ...prev,
        ]);
      }
    }
    onUploaded();
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
  };
  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) handleFiles(e.target.files);
    e.target.value = ""; // reset so same file can re-trigger
  };

  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-5">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`rounded-lg border-2 border-dashed p-8 cursor-pointer transition-colors text-center ${
          dragOver
            ? "border-brand-blue-500 bg-brand-blue-500/5"
            : "border-ops-border hover:border-brand-blue-400/40 hover:bg-ops-bg/40"
        }`}
      >
        <div className="text-sm font-semibold text-ops-text">Drop DMARC reports here</div>
        <div className="mt-1 text-[12px] text-ops-text-muted">
          Accepts .xml, .xml.gz, .zip from any DMARC report sender (Google, Yahoo, Outlook, etc.)
        </div>
        <div className="mt-3 text-[11px] text-ops-text-subtle">
          Click to browse · multiple files OK · duplicates auto-detected
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".xml,.gz,.zip"
          onChange={onPick}
          className="hidden"
        />
      </div>

      {log.length > 0 && (
        <div className="mt-4 space-y-1.5 max-h-48 overflow-y-auto">
          {log.map((entry, i) => (
            <div
              key={i}
              className={`text-[12px] flex items-start gap-2 px-2.5 py-1.5 rounded-md ${
                entry.status === "ok"
                  ? "bg-emerald-500/5 border border-emerald-500/20 text-emerald-500"
                  : entry.status === "dup"
                    ? "bg-amber-500/5 border border-amber-500/20 text-amber-500"
                    : "bg-red-500/5 border border-red-500/20 text-red-400"
              }`}
            >
              <span className="font-bold text-[10px] tracking-wider uppercase mt-0.5">
                {entry.status === "ok" ? "Ingested" : entry.status === "dup" ? "Duplicate" : "Failed"}
              </span>
              <span className="flex-1">
                <span className="font-mono text-ops-text-muted">{entry.name}</span> — {entry.detail}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ReportsDmarc() {
  const [days, setDays] = useState<Days>(30);
  const qc = useQueryClient();

  const query = useQuery<DmarcAggregate>({
    queryKey: ["dmarc-aggregate", days],
    queryFn: async () => {
      const r = await fetch(`/api/ops/dmarc/aggregate?days=${days}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const r = query.data;
  const s = r?.summary;
  const maxSenderMessages = r?.senders?.length
    ? Math.max(...r.senders.map((sn) => sn.messages), 1)
    : 1;

  return (
    <div>
      <PageHero
        eyebrow="Reports"
        title="DMARC"
        subtitle="Email-authentication alignment reports from receiving mailbox providers."
        actions={
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5 p-1 rounded-full bg-ops-bg border border-ops-border">
              {WINDOWS.map((w) => (
                <button
                  key={w.days}
                  onClick={() => setDays(w.days)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    days === w.days
                      ? "bg-brand-blue-500 text-white shadow-[0_2px_8px_-2px_rgba(46,91,255,0.45)]"
                      : "text-ops-text-muted hover:text-ops-text"
                  }`}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </div>
        }
      />

      {(query.isError || hasApiError(query.data)) && (
        <InlineError context="DMARC report" data={query.data} error={query.error} />
      )}

      <UploadCard onUploaded={() => qc.invalidateQueries({ queryKey: ["dmarc-aggregate"] })} />

      {query.isLoading && (
        <div className="text-ops-text-muted text-sm py-12 text-center">Loading DMARC data…</div>
      )}

      {r && (
        <>
          <SectionTitle subtitle={`From ${s?.reports_count ?? 0} reports across the last ${days}d`}>
            Summary
          </SectionTitle>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <StatCard
              label="Total messages"
              value={fmtInt(s?.total_messages)}
              hint={`Across ${fmtInt(r.reporting_orgs.length)} reporting orgs`}
            />
            <StatCard
              label="Aligned (DKIM + SPF)"
              value={fmtPct(s?.aligned_pct ?? null)}
              hint={`${fmtInt(s?.aligned_messages)} of ${fmtInt(s?.total_messages)}`}
              tone={toneForAlignment(s?.aligned_pct ?? null)}
            />
            <StatCard
              label="DKIM pass"
              value={fmtPct(s?.dkim_pass_pct ?? null)}
              tone={toneForAlignment(s?.dkim_pass_pct ?? null)}
            />
            <StatCard
              label="SPF pass"
              value={fmtPct(s?.spf_pass_pct ?? null)}
              tone={toneForAlignment(s?.spf_pass_pct ?? null)}
            />
          </div>

          {((s?.quarantine ?? 0) > 0 || (s?.reject ?? 0) > 0) && (
            <div className="mt-3 grid grid-cols-2 gap-3 sm:gap-4">
              <StatCard
                label="Quarantined"
                value={fmtInt(s?.quarantine)}
                hint="Sent to spam by receivers"
                tone="warn"
              />
              <StatCard
                label="Rejected"
                value={fmtInt(s?.reject)}
                hint="Dropped at the door"
                tone="bad"
              />
            </div>
          )}

          <SectionTitle subtitle="Where your mail is coming FROM (by source IP) and how aligned it is">
            Top senders
          </SectionTitle>
          {!r.senders.length ? (
            <div className="rounded-xl border border-ops-border bg-ops-surface p-6 text-center text-[12px] text-ops-text-muted italic">
              No sender data yet — upload some DMARC reports above to start populating.
            </div>
          ) : (
            <div className="rounded-xl border border-ops-border bg-ops-surface overflow-hidden">
              <table className="w-full text-[12px]">
                <thead className="text-[10px] tracking-wider uppercase text-ops-text-subtle border-b border-ops-border">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">Source IP</th>
                    <th className="text-left font-medium px-3 py-2">Header From</th>
                    <th className="text-right font-medium px-3 py-2">Messages</th>
                    <th className="text-right font-medium px-3 py-2">Aligned %</th>
                    <th className="text-right font-medium px-3 py-2">DKIM %</th>
                    <th className="text-right font-medium px-3 py-2">SPF %</th>
                  </tr>
                </thead>
                <tbody className="text-ops-text">
                  {r.senders.map((sn) => (
                    <tr key={sn.source_ip + sn.header_from} className="border-t border-ops-border">
                      <td className="px-3 py-2 font-mono text-[11.5px]">{sn.source_ip}</td>
                      <td className="px-3 py-2 text-ops-text-muted">{sn.header_from || "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-1.5 w-20 rounded-full bg-ops-bg overflow-hidden">
                            <div
                              className="h-full bg-brand-blue-500"
                              style={{ width: `${(sn.messages / maxSenderMessages) * 100}%` }}
                            />
                          </div>
                          <span>{fmtInt(sn.messages)}</span>
                        </div>
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums font-medium ${
                        sn.pct_aligned !== null && sn.pct_aligned < 80 ? "text-red-400" :
                        sn.pct_aligned !== null && sn.pct_aligned < 95 ? "text-amber-500" :
                        "text-emerald-500"
                      }`}>
                        {fmtPct(sn.pct_aligned)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-ops-text-muted">{fmtPct(sn.dkim_pass_pct)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-ops-text-muted">{fmtPct(sn.spf_pass_pct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {r.reporting_orgs.length > 0 && (
            <>
              <SectionTitle subtitle="Receiving mailbox providers sending you reports">
                Reporting orgs
              </SectionTitle>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {r.reporting_orgs.map((org) => (
                  <div
                    key={org.org_name}
                    className="rounded-xl border border-ops-border bg-ops-surface p-3"
                  >
                    <div className="text-[10px] tracking-wider uppercase text-ops-text-subtle font-semibold">
                      {org.org_name}
                    </div>
                    <div className="mt-1 text-base font-bold text-ops-text tabular-nums">
                      {fmtInt(org.messages)}
                    </div>
                    <div className="text-[10.5px] text-ops-text-muted">
                      {fmtInt(org.reports)} reports
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {r.recent_reports.length > 0 && (
            <>
              <SectionTitle subtitle="Last 25 ingested reports — most recent first">
                Recent reports
              </SectionTitle>
              <div className="rounded-xl border border-ops-border bg-ops-surface overflow-hidden">
                <table className="w-full text-[12px]">
                  <thead className="text-[10px] tracking-wider uppercase text-ops-text-subtle border-b border-ops-border">
                    <tr>
                      <th className="text-left font-medium px-3 py-2">Reporter</th>
                      <th className="text-left font-medium px-3 py-2">Domain</th>
                      <th className="text-left font-medium px-3 py-2">Window</th>
                      <th className="text-right font-medium px-3 py-2">Messages</th>
                      <th className="text-left font-medium px-3 py-2">Policy</th>
                    </tr>
                  </thead>
                  <tbody className="text-ops-text">
                    {r.recent_reports.map((rep) => (
                      <tr key={rep.id} className="border-t border-ops-border">
                        <td className="px-3 py-2">{rep.org_name}</td>
                        <td className="px-3 py-2 text-ops-text-muted">{rep.domain}</td>
                        <td className="px-3 py-2 text-ops-text-muted">
                          {rep.date_range_start} → {rep.date_range_end}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtInt(rep.total_messages)}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-ops-text-muted">
                          p={rep.policy_p ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div className="mt-6 text-[10.5px] text-ops-text-subtle">
            Generated {new Date(r.generated_at).toLocaleString()} · Reports stored in RDS
            <br />
            Phase 2 (deferred): Mailgun inbound route auto-ingests from a dmarc@ address you'd add to your DMARC rua=.
          </div>
        </>
      )}
    </div>
  );
}
