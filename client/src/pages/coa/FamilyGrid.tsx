import { FileText, Paperclip } from "lucide-react";
import { DOT, STATUS_TEXT, type Family } from "./api";

export function FamilyGrid({ families, onOpen }: { families: Family[]; onOpen: (f: Family) => void }) {
  if (!families.length) return <div className="py-16 text-center text-sm text-ops-text-muted">No products match.</div>;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {families.map((f) => <Card key={f.key} f={f} onOpen={onOpen} />)}
    </div>
  );
}

function Card({ f, onOpen }: { f: Family; onOpen: (f: Family) => void }) {
  return (
    <button type="button" onClick={() => onOpen(f)}
      className="flex flex-col overflow-hidden rounded-xl border border-ops-border bg-ops-surface text-left shadow-card transition hover:border-fitscript-green/50 focus:outline-none focus:ring-2 focus:ring-fitscript-green/30">
      <div className="flex gap-3 p-4">
        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-ops-border bg-ops-bg">
          {f.thumbnail && <img src={f.thumbnail} alt="" className="h-full w-full object-cover" loading="lazy" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-sm font-semibold leading-tight text-ops-text">{f.label}</div>
          <span className="mt-1.5 inline-block rounded-full bg-fitscript-green/10 px-2 py-0.5 text-[11px] font-semibold text-fitscript-green">
            {f.variants.length} {f.variants.length === 1 ? "variant" : "variants"}
          </span>
        </div>
        {f.docCount > 0 ? (
          <span title={`${f.docCount} COA file(s)`} className="inline-flex shrink-0 items-center gap-0.5 text-fitscript-green">
            <FileText size={16} /><span className="text-[11px] font-semibold">{f.docCount}</span>
          </span>
        ) : (
          <span title="No COA file attached" className="shrink-0 text-ops-border"><Paperclip size={16} /></span>
        )}
      </div>
      <div className="mt-auto flex items-center gap-2 border-t border-ops-border px-4 py-3 text-xs">
        <span className={`h-2.5 w-2.5 rounded-full ${DOT[f.status]}`} />
        <span className="text-ops-text">{STATUS_TEXT[f.status]}</span>
      </div>
    </button>
  );
}
