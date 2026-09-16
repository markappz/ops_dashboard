import { Link, useLocation } from "wouter";

/**
 * Sub-tab bar for consolidated nav entries (SEO ▸ Content ▸ Pages, Marketing ▸
 * Site Traffic, Email ▸ Leads). Every sub-tab keeps its own URL, so old deep
 * links, per-page localStorage keys and query params all survive the merge —
 * the sidebar just stops listing them separately.
 */
export function SubTabs({ tabs }: { tabs: readonly { path: string; label: string }[] }) {
  const [loc] = useLocation();
  return (
    <div className="mb-4 flex flex-wrap gap-1 rounded-xl border border-ops-border bg-ops-surface p-1 shadow-card w-fit">
      {tabs.map((t) => {
        const active = loc === t.path;
        return (
          <Link
            key={t.path}
            href={t.path}
            className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
              active ? "bg-ops-bg text-ops-text border border-ops-border" : "text-ops-text-muted hover:text-ops-text"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
