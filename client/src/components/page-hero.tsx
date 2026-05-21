import { ReactNode } from "react";

/**
 * Branded page hero — soft gradient wash + eyebrow + display title.
 * Used as the top of every primary ops page so the brand reads consistently.
 */
export function PageHero({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="relative mb-8 -mt-2 px-6 py-7 rounded-2xl border border-ops-border bg-ops-surface shadow-card overflow-hidden">
      {/* Subtle brand cloud wash */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none opacity-90"
        style={{
          backgroundImage:
            "radial-gradient(900px 320px at 0% 0%, rgb(var(--ops-accent) / 0.10), transparent 60%), radial-gradient(700px 280px at 100% 0%, rgb(var(--ops-accent) / 0.06), transparent 60%)",
        }}
      />
      <div className="relative flex items-end justify-between gap-6">
        <div className="min-w-0">
          {eyebrow && (
            <div className="text-[11px] font-semibold tracking-[0.18em] uppercase text-brand-blue-500 mb-1.5">
              {eyebrow}
            </div>
          )}
          <h1 className="text-[28px] leading-none font-bold tracking-tight text-ops-text">{title}</h1>
          {subtitle && (
            <p className="text-sm text-ops-text-muted mt-2 max-w-2xl">{subtitle}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
