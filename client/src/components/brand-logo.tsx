/**
 * BRANDMAXXER brand lockup (2026-10-06 rebrand, Paul + partner).
 * Direction after review: pure type — no monogram glyphs inside the word.
 * The double-X is the same typeface, set a touch larger, tracked tight so the
 * pair reads as one unit, and genuinely thickened with a text stroke so XX
 * sits visibly heavier than the rest. OPS chip stays exactly as the old shell.
 */

export function BrandXX({ className }: { className?: string }) {
  return (
    <span
      className={className}
      style={{
        fontSize: "1.12em",
        letterSpacing: "-0.06em",
        WebkitTextStroke: "0.028em currentColor",
        marginInline: "0.015em",
      }}
    >
      XX
    </span>
  );
}

export function BrandWordmark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`leading-none whitespace-nowrap ${className}`}
      style={{ fontFamily: "'Archivo Black','DM Sans',sans-serif", letterSpacing: "0.03em" }}
    >
      BRANDMA<BrandXX />ER
    </span>
  );
}

/** Sidebar lockup: BRANDMAXXER · OPS chip. */
export function BrandLogo() {
  return (
    <div className="flex items-center gap-2 min-w-0" aria-label="BRANDMAXXER Ops">
      <BrandWordmark className="text-ops-text text-[15px]" />
      <span className="text-[10px] tracking-[0.14em] uppercase text-ops-text-subtle font-semibold bg-ops-accent-soft px-1.5 py-0.5 rounded shrink-0">
        Ops
      </span>
    </div>
  );
}
