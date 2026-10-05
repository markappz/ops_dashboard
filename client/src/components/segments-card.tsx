import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

interface SegmentRow { slug: string; name: string; description: string; count: number }

/**
 * An engine brand's segments with live counts — the same audiences the broadcast composer's
 * picker offers. Definitions live in code (each brand's site repo) and membership is recomputed
 * engine-side; for RP these replaced the Resend segments 1:1 after the 2026-10-01 suspension.
 */
export function SegmentsCard({ company }: { company: string }) {
  const q = useQuery({
    queryKey: ["marketing-segments", company],
    queryFn: async () => (await fetch(`/api/ops/${company}/marketing/segments`, { credentials: "include" })).json() as
      Promise<{ all: number; segments: SegmentRow[] }>,
    staleTime: 5 * 60_000,
  });
  const [openSeg, setOpenSeg] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  async function exportSegment(slug: string) {
    setExporting(slug);
    try {
      const r = await fetch(`/api/ops/${company}/marketing/export?segment=${encodeURIComponent(slug)}`, { credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      const csv = ["email,first_name,unsubscribed", ...j.rows.map((row: any) => [row.email, row.firstName, row.unsubscribed].map((v) => esc(String(v))).join(","))].join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = `${company}-segment-${slug}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
    setExporting(null);
  }

  if (!q.data?.segments) return null;
  return (
    <div className="mb-6 rounded-2xl border border-ops-border bg-ops-surface shadow-card">
      <button type="button" onClick={() => setOpenSeg(!openSeg)} className="flex w-full items-center justify-between px-4 py-3 text-left">
        <span className="text-sm font-semibold text-ops-text">Segments <span className="font-normal text-ops-text-muted">· {q.data.segments.length} live · everyone mailable: {q.data.all.toLocaleString()}</span></span>
        <span className="text-xs text-ops-text-muted">{openSeg ? "Hide" : "Show"}</span>
      </button>
      {openSeg && (
        <div className="overflow-x-auto border-t border-ops-border">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-ops-text-muted">
                <th className="px-4 py-2 font-medium">Segment</th>
                <th className="px-4 py-2 font-medium">Contacts</th>
                <th className="px-4 py-2 font-medium">Definition</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {q.data.segments.map((sg) => (
                <tr key={sg.slug} className="border-t border-ops-border/60">
                  <td className="px-4 py-2 font-medium text-ops-text">{sg.name} <code className="ml-1 text-[10px] text-ops-text-muted">{sg.slug}</code></td>
                  <td className="px-4 py-2 text-ops-text">{sg.count.toLocaleString()}</td>
                  <td className="px-4 py-2 text-ops-text-muted">{sg.description}</td>
                  <td className="px-4 py-2 text-right">
                    <button type="button" onClick={() => exportSegment(sg.slug)} disabled={exporting !== null}
                      className="rounded-lg border border-ops-border px-2.5 py-1 text-[11px] font-semibold text-ops-text hover:bg-ops-bg disabled:opacity-40">
                      {exporting === sg.slug ? "…" : "Export CSV"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-ops-border px-4 py-2 text-[11px] text-ops-text-muted">
            Segment definitions live in code and recompute automatically. Need a new one? Ask — it ships as a definition, so it stays correct forever instead of drifting like a hand-built list.
          </div>
        </div>
      )}
    </div>
  );
}
