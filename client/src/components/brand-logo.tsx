import { useId } from "react";

/**
 * BRANDMAXXER brand lockup (2026-10-06/07 rebrand, Paul + partner).
 * Final direction: BOTH pieces — the twin-loop infinity mark (each X is one
 * closed ribbon: straight diagonals whose side arms loop shut) stacked above
 * the pure-type wordmark, whose own XX is set larger, tracked tight and
 * stroke-thickened. OPS chip stays exactly as the old shell.
 * Spec/archive: claude.ai/artifact/3PcJjT3d292w3gMAXqrtzA
 */

const BOWX = "M -40 -40 L 40 40 C 84 40, 84 -40, 40 -40 L -40 40 C -84 40, -84 -40, -40 -40 Z";
export const BRAND_GRADIENT = ["#2641ff", "#1be3a4"] as const;

/** Twin-loop infinity XX. Height-driven; width follows (302:104 ratio). */
export function BrandMark({ height = 14, mono }: { height?: number; mono?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const stroke = mono ?? `url(#bmx-${id})`;
  return (
    <svg viewBox="0 0 302 104" style={{ height, width: (height * 302) / 104 }} aria-hidden="true">
      {!mono && (
        <defs>
          <linearGradient id={`bmx-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={BRAND_GRADIENT[0]} />
            <stop offset="1" stopColor={BRAND_GRADIENT[1]} />
          </linearGradient>
        </defs>
      )}
      <g stroke={stroke} strokeWidth="19" fill="none" strokeLinejoin="round">
        <path d={BOWX} transform="translate(81,52) scale(0.58)" />
        <path d={BOWX} transform="translate(221,52) scale(0.58)" />
      </g>
    </svg>
  );
}

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

/** Sidebar lockup: infinity mark CENTERED above the wordmark, OPS chip beside. */
export function BrandLogo({ markHeight = 18, wordClass = "text-[15px]" }: { markHeight?: number; wordClass?: string }) {
  return (
    <div className="flex items-end gap-2 min-w-0" aria-label="BRANDMAXXER Ops">
      <div className="flex flex-col items-center gap-[5px] min-w-0">
        <BrandMark height={markHeight} />
        <BrandWordmark className={`text-ops-text ${wordClass}`} />
      </div>
      <span className="text-[10px] tracking-[0.14em] uppercase text-ops-text-subtle font-semibold bg-ops-accent-soft px-1.5 py-0.5 rounded shrink-0 mb-[1px]">
        Ops
      </span>
    </div>
  );
}
