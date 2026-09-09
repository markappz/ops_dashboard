import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import {
  addDays, addMonths, endOfDay, endOfMonth, endOfQuarter, format, isAfter, isBefore, isSameDay, isSameMonth,
  startOfDay, startOfMonth, startOfQuarter, startOfWeek, startOfYear, subDays, subMonths, subQuarters,
} from "date-fns";

/**
 * Shopify-style reporting range: presets on the left, a two-month calendar
 * on the right, Cancel / Apply. The value is a closed interval of instants,
 * so the server can compare like with like. Persisted per page in
 * localStorage so a chosen range survives a refresh.
 */
export interface DateRange { from: Date; to: Date; label: string; key: string }

const PRESETS: { key: string; label: string; make: (now: Date) => [Date, Date] }[] = [
  { key: "today", label: "Today", make: (n) => [startOfDay(n), n] },
  { key: "yesterday", label: "Yesterday", make: (n) => [startOfDay(subDays(n, 1)), endOfDay(subDays(n, 1))] },
  { key: "24h", label: "Last 24 hours", make: (n) => [subDays(n, 1), n] },
  { key: "7d", label: "Last 7 days", make: (n) => [startOfDay(subDays(n, 6)), n] },
  { key: "30d", label: "Last 30 days", make: (n) => [startOfDay(subDays(n, 29)), n] },
  { key: "90d", label: "Last 90 days", make: (n) => [startOfDay(subDays(n, 89)), n] },
  { key: "wtd", label: "Week to date", make: (n) => [startOfWeek(n, { weekStartsOn: 1 }), n] },
  { key: "mtd", label: "Month to date", make: (n) => [startOfMonth(n), n] },
  { key: "lastm", label: "Last month", make: (n) => [startOfMonth(subMonths(n, 1)), endOfMonth(subMonths(n, 1))] },
  { key: "qtd", label: "Quarter to date", make: (n) => [startOfQuarter(n), n] },
  { key: "lastq", label: "Last quarter", make: (n) => [startOfQuarter(subQuarters(n, 1)), endOfQuarter(subQuarters(n, 1))] },
  { key: "ytd", label: "Year to date", make: (n) => [startOfYear(n), n] },
];

export function presetRange(key: string, now = new Date()): DateRange {
  const p = PRESETS.find((x) => x.key === key) ?? PRESETS[4];
  const [from, to] = p.make(now);
  return { from, to, label: p.label, key: p.key };
}

export function rangeQuery(r: DateRange): string {
  return `from=${encodeURIComponent(r.from.toISOString())}&to=${encodeURIComponent(r.to.toISOString())}`;
}

/** Whole days in the range, ≥ 1 — for "per day" math and per-day labels. */
export function rangeDays(r: DateRange): number {
  return Math.max(1, Math.round((r.to.getTime() - r.from.getTime()) / 86_400_000));
}

function fmtRange(r: DateRange): string {
  if (r.key !== "custom") return r.label;
  const sameYear = r.from.getFullYear() === r.to.getFullYear();
  return `${format(r.from, sameYear ? "MMM d" : "MMM d, yyyy")}–${format(r.to, "MMM d, yyyy")}`;
}

export function useDateRange(storageKey: string, fallback = "30d"): [DateRange, (r: DateRange) => void] {
  const [range, setRangeState] = useState<DateRange>(() => {
    try {
      const raw = localStorage.getItem(`ops-range:${storageKey}`);
      if (raw) {
        const j = JSON.parse(raw);
        if (j.key && j.key !== "custom") return presetRange(j.key);
        if (j.from && j.to) return { from: new Date(j.from), to: new Date(j.to), label: "Custom", key: "custom" };
      }
    } catch { /* fall through */ }
    return presetRange(fallback);
  });
  const setRange = (r: DateRange) => {
    setRangeState(r);
    try { localStorage.setItem(`ops-range:${storageKey}`, JSON.stringify({ key: r.key, from: r.from.toISOString(), to: r.to.toISOString() })); } catch { /* ignore */ }
  };
  return [range, setRange];
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Month({ month, start, end, hover, onPick, onHover, max }: {
  month: Date; start: Date | null; end: Date | null; hover: Date | null; onPick: (d: Date) => void; onHover: (d: Date | null) => void; max: Date;
}) {
  const first = startOfMonth(month);
  const cells: (Date | null)[] = Array.from({ length: first.getDay() }, () => null);
  for (let d = first; isSameMonth(d, month); d = addDays(d, 1)) cells.push(d);
  const selEnd = end ?? hover;
  const inRange = (d: Date) => start && selEnd && !isBefore(d, startOfDay(isBefore(start, selEnd) ? start : selEnd)) && !isAfter(d, endOfDay(isAfter(selEnd, start) ? selEnd : start));
  return (
    <div className="w-[272px]">
      <div className="mb-2 text-center text-sm font-semibold text-ops-text">{format(month, "MMMM yyyy")}</div>
      <div className="grid grid-cols-7 text-center text-[11px] text-ops-text-muted">{WEEKDAYS.map((w) => <div key={w} className="py-1">{w}</div>)}</div>
      <div className="grid grid-cols-7 text-center text-sm">
        {cells.map((d, i) => {
          if (!d) return <div key={`e${i}`} />;
          const disabled = isAfter(startOfDay(d), max);
          const isStart = start && isSameDay(d, start);
          const isEnd = selEnd && isSameDay(d, selEnd);
          const mid = inRange(d) && !isStart && !isEnd;
          return (
            <button key={d.toISOString()} type="button" disabled={disabled} onClick={() => onPick(d)} onMouseEnter={() => onHover(d)} onMouseLeave={() => onHover(null)}
              className={`my-0.5 h-9 w-full text-sm transition ${disabled ? "text-ops-text-subtle" : "text-ops-text hover:bg-ops-border"} ${mid ? "bg-ops-border/70" : ""} ${isStart || isEnd ? "rounded-lg bg-fitscript-green font-semibold text-white hover:bg-fitscript-green" : ""}`}>
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function DateRangePicker({ value, onChange }: { value: DateRange; onChange: (r: DateRange) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange>(value);
  const [start, setStart] = useState<Date | null>(value.from);
  const [end, setEnd] = useState<Date | null>(value.to);
  const [hover, setHover] = useState<Date | null>(null);
  const [leftMonth, setLeftMonth] = useState<Date>(startOfMonth(subMonths(value.to, 1)));
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number; left?: number }>({ top: 0, right: 0 });
  const now = useMemo(() => new Date(), [open]);

  // The panel is portaled to <body> and fixed-positioned under the button, so
  // a hero card's overflow/rounded clipping can't cut it off.
  useEffect(() => {
    if (!open) return;
    setDraft(value); setStart(value.from); setEnd(value.to); setLeftMonth(startOfMonth(subMonths(value.to, 1)));
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      // Phones: full-width sheet under the button. Desktop: right-aligned to the button.
      if (window.innerWidth < 768) setPos({ top: r.bottom + 8, left: 16, right: 16 });
      else setPos({ top: r.bottom + 8, right: Math.max(16, window.innerWidth - r.right) });
    };
    place();
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { document.removeEventListener("mousedown", onDoc); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickPreset = (key: string) => {
    const r = presetRange(key, now);
    setDraft(r); setStart(r.from); setEnd(r.to); setLeftMonth(startOfMonth(subMonths(r.to, 1)));
  };
  const pickDay = (d: Date) => {
    if (!start || end) { setStart(d); setEnd(null); setDraft({ ...draft, key: "custom", label: "Custom" }); return; }
    const [a, b] = isBefore(d, start) ? [d, start] : [start, d];
    const to = isSameDay(b, now) ? now : endOfDay(b);
    setStart(startOfDay(a)); setEnd(to);
    setDraft({ from: startOfDay(a), to, label: "Custom", key: "custom" });
  };
  const apply = () => {
    if (!start) return;
    const to = end ?? (isSameDay(start, now) ? now : endOfDay(start));
    onChange(draft.key === "custom" ? { from: startOfDay(start), to, label: "Custom", key: "custom" } : draft);
    setOpen(false);
  };
  const canApply = !!start && (draft.key !== "custom" || !!end || !!start);

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} className={`inline-flex items-center gap-2 rounded-lg border bg-ops-bg px-3 py-2 text-sm text-ops-text transition ${open ? "border-fitscript-green ring-2 ring-fitscript-green/20" : "border-ops-border hover:border-ops-text-muted"}`}>
        <Calendar size={14} className="text-ops-text-muted" /> {fmtRange(value)} <ChevronDown size={14} className="text-ops-text-muted" />
      </button>
      {open && createPortal(
        <div ref={panelRef} style={{ top: pos.top, right: pos.right, left: pos.left }} className="fixed z-[60] flex max-h-[calc(100vh-1rem)] max-w-[calc(100vw-2rem)] flex-col overflow-auto rounded-2xl border border-ops-border bg-ops-surface shadow-2xl md:flex-row">
          <div className="flex max-h-[220px] flex-row flex-wrap gap-1 overflow-y-auto border-b border-ops-border p-2 md:max-h-none md:w-44 md:flex-col md:flex-nowrap md:border-b-0 md:border-r">
            {PRESETS.map((p) => (
              <button key={p.key} type="button" onClick={() => pickPreset(p.key)} className={`rounded-lg px-3 py-1.5 text-left text-sm ${draft.key === p.key ? "bg-fitscript-green/10 font-medium text-fitscript-green" : "text-ops-text hover:bg-ops-border/60"}`}>{p.label}</button>
            ))}
            <div className={`rounded-lg px-3 py-1.5 text-sm ${draft.key === "custom" ? "bg-fitscript-green/10 font-medium text-fitscript-green" : "text-ops-text-muted"}`}>Custom range</div>
          </div>
          <div className="p-4">
            <div className="mb-3 flex items-center gap-2 text-sm">
              <div className="flex-1 rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-ops-text">{start ? format(start, "MMMM d, yyyy") : "Start"}</div>
              <span className="text-ops-text-muted">→</span>
              <div className="flex-1 rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-ops-text">{end ? format(end, "MMMM d, yyyy") : hover && start ? format(hover, "MMMM d, yyyy") : "End"}</div>
            </div>
            <div className="relative flex flex-col gap-6 md:flex-row">
              <button type="button" onClick={() => setLeftMonth(subMonths(leftMonth, 1))} className="absolute left-0 top-0 rounded p-1 text-ops-text-muted hover:text-ops-text"><ChevronLeft size={16} /></button>
              <button type="button" onClick={() => setLeftMonth(addMonths(leftMonth, 1))} disabled={isAfter(addMonths(leftMonth, 1), startOfMonth(now))} className="absolute right-0 top-0 rounded p-1 text-ops-text-muted hover:text-ops-text disabled:opacity-30"><ChevronRight size={16} /></button>
              <Month month={leftMonth} start={start} end={end} hover={hover} onPick={pickDay} onHover={setHover} max={now} />
              <div className="hidden md:block"><Month month={addMonths(leftMonth, 1)} start={start} end={end} hover={hover} onPick={pickDay} onHover={setHover} max={now} /></div>
            </div>
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-ops-border pt-3">
              <span className="text-xs text-ops-text-muted">{start && end ? `${rangeDays({ from: start, to: end, label: "", key: "" })} days` : "Pick a start and end day"}</span>
              <div className="flex gap-2">
                <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-ops-border px-3 py-1.5 text-sm text-ops-text hover:bg-ops-border/60">Cancel</button>
                <button type="button" onClick={apply} disabled={!canApply} className="rounded-lg bg-fitscript-green px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">Apply</button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
