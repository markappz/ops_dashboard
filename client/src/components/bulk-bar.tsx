/**
 * Floating action bar that appears when rows are selected on any table.
 * Fixed at the bottom of the viewport, brand-gradient pill.
 * Used by /members, /orders (and future surfaces).
 */
export function BulkBar({
  count,
  onClear,
  onAskDirt,
  label = "selected",
}: {
  count: number;
  onClear: () => void;
  onAskDirt: () => void;
  label?: string;
}) {
  return (
    <div
      className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 z-30 animate-dirt-fade-in"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="relative">
        <div className="absolute -inset-1 bg-gradient-to-r from-brand-blue-600 to-brand-blue-400 rounded-full opacity-40 blur-md" />
        <div className="relative flex items-center gap-2.5 sm:gap-3 h-11 sm:h-12 px-3 sm:px-4 rounded-full bg-ops-surface border border-brand-blue-400/40 shadow-card-lg backdrop-blur-md whitespace-nowrap">
          <span className="text-xs sm:text-sm font-semibold text-ops-text">
            {count} {label}
          </span>
          <div className="w-px h-5 bg-ops-border" />
          <button
            onClick={onAskDirt}
            className="flex items-center gap-1.5 px-2.5 sm:px-3 h-8 rounded-full bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white text-[11px] sm:text-xs font-semibold hover:opacity-95 transition-all shadow-[0_4px_14px_-4px_rgba(46,91,255,0.5)]"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2l1.91 6.09L20 10l-6.09 1.91L12 18l-1.91-6.09L4 10l6.09-1.91L12 2z" />
            </svg>
            Ask DIRT
          </button>
          <button
            onClick={onClear}
            className="text-[11px] sm:text-xs text-ops-text-muted hover:text-ops-text px-1"
            title="Clear selection"
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}
