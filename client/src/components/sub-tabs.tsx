import { Link, useLocation } from "wouter";
import { useEffect, useRef } from "react";

/**
 * Sub-tab bar for consolidated nav entries (Email ▸ Broadcasts ▸ Flows ▸ …). Every sub-tab
 * keeps its own URL, so deep links and per-page localStorage keys survive the merge.
 * Phones get a single swipeable row (six wrapped pills read as a broken layout — Paul,
 * 2026-10-02); the active pill scrolls itself into view. ≥sm keeps the compact wrapped box.
 */
export function SubTabs({ tabs }: { tabs: readonly { path: string; label: string }[] }) {
  const [loc] = useLocation();
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = barRef.current?.querySelector<HTMLElement>("[data-active='true']");
    active?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [loc]);

  return (
    <div className="mb-4 -mx-4 px-4 sm:mx-0 sm:px-0">
      <div
        ref={barRef}
        className="no-scrollbar flex gap-1 overflow-x-auto rounded-xl border border-ops-border bg-ops-surface p-1 shadow-card sm:w-fit sm:flex-wrap sm:overflow-visible"
      >
        {tabs.map((t) => {
          const active = loc === t.path;
          return (
            <Link
              key={t.path}
              href={t.path}
              data-active={active}
              className={`min-h-[36px] shrink-0 whitespace-nowrap rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
                active ? "border border-ops-border bg-ops-bg text-ops-text" : "text-ops-text-muted hover:text-ops-text"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
