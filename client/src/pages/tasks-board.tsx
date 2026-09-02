import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X, Trash2, Loader2, CalendarDays, Tag } from "lucide-react";
import { PageHero } from "../components/page-hero";

/**
 * Team task board — Monday-style kanban. Lives in the Real Peptides section
 * (Josh's home base) but every task carries a company tag, so it's the one
 * board for all brands. Drag a card between columns, or tap it to edit —
 * on phones the tap path is the whole interface.
 */

interface Task {
  id: number;
  title: string;
  description: string | null;
  status: string;
  priority: "low" | "medium" | "high";
  company: string | null;
  assignee: string | null;
  due_date: string | null;
  labels: string[];
  position: number;
  created_by: string | null;
  completed_at: string | null;
}

const COLUMNS = [
  { key: "inbox", label: "Inbox" },
  { key: "ready", label: "Ready" },
  { key: "in_progress", label: "In progress" },
  { key: "complete", label: "Complete" },
  { key: "on_hold", label: "On hold" },
] as const;

const PRIORITY_CHIP: Record<string, string> = {
  low: "bg-amber-500/15 text-amber-500",
  medium: "bg-orange-500/20 text-orange-400",
  high: "bg-red-500/15 text-red-400",
};

const COMPANY_META: Record<string, { label: string; chip: string }> = {
  realpeptides: { label: "Real Peptides", chip: "bg-yellow-500/15 text-yellow-500" },
  fitscript: { label: "FitScript", chip: "bg-emerald-500/15 text-emerald-400" },
  peptideu: { label: "PeptideU", chip: "bg-brand-blue-500/15 text-brand-blue-400" },
  pawgen: { label: "pawgen", chip: "bg-purple-500/15 text-purple-400" },
  other: { label: "Other", chip: "bg-ops-border text-ops-text-muted" },
};

const input = "w-full rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text focus:border-brand-blue-500 focus:outline-none";

const initials = (email: string) => email.split("@")[0].split(/[._-]/).map((p) => p[0]?.toUpperCase() ?? "").join("").slice(0, 2);
const dueTone = (d: string | null, status: string) => {
  if (!d || status === "complete") return "text-ops-text-muted";
  const days = Math.floor((new Date(String(d).slice(0, 10) + "T23:59:59").getTime() - Date.now()) / 86400_000);
  return days < 0 ? "text-red-400 font-semibold" : days <= 1 ? "text-amber-500" : "text-ops-text-muted";
};
const fmtDue = (d: string) => new Date(String(d).slice(0, 10) + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });

export default function TasksBoard() {
  const qc = useQueryClient();
  const [open, setOpen] = useState<Task | null>(null);
  const [companyFilter, setCompanyFilter] = useState<string>("all");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["ops-tasks"],
    queryFn: async () => (await fetch("/api/ops/tasks", { credentials: "include" })).json() as Promise<{ tasks: Task[]; team: string[]; error?: string }>,
    refetchInterval: 60_000,
  });
  const tasks = q.data?.tasks ?? [];
  const team = q.data?.team ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ["ops-tasks"] });

  const shown = useMemo(
    () => tasks
      .filter((t) => companyFilter === "all" || t.company === companyFilter)
      .filter((t) => assigneeFilter === "all" || t.assignee === assigneeFilter),
    [tasks, companyFilter, assigneeFilter],
  );

  async function patch(id: number, body: Record<string, unknown>) {
    await fetch(`/api/ops/tasks/${id}`, {
      method: "PATCH", credentials: "include",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    refresh();
  }

  function onDrop(col: string) {
    setDropCol(null);
    if (dragId === null) return;
    const t = tasks.find((x) => x.id === dragId);
    setDragId(null);
    if (t && t.status !== col) {
      const maxPos = Math.max(0, ...tasks.filter((x) => x.status === col).map((x) => x.position));
      patch(t.id, { status: col, position: maxPos + 1 });
    }
  }

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides"
        title="Tasks"
        subtitle="The team board across every brand — assign it, tag it, drag it done."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)} className={`${input} w-auto py-1.5`}>
              <option value="all">All brands</option>
              {Object.entries(COMPANY_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
            </select>
            <select value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)} className={`${input} w-auto py-1.5`}>
              <option value="all">Everyone</option>
              {team.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>
        }
      />

      {q.isLoading ? (
        <div className="py-16 text-center text-sm text-ops-text-muted">Loading the board…</div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-4 sm:gap-4">
          {COLUMNS.map((col) => {
            const cards = shown.filter((t) => t.status === col.key).sort((a, b) => a.position - b.position || a.id - b.id);
            return (
              <div key={col.key}
                onDragOver={(e) => { e.preventDefault(); setDropCol(col.key); }}
                onDragLeave={() => setDropCol((c) => (c === col.key ? null : c))}
                onDrop={() => onDrop(col.key)}
                className={`flex w-[280px] shrink-0 flex-col rounded-2xl border p-2.5 transition-colors sm:w-[300px] ${
                  dropCol === col.key ? "border-brand-blue-500 bg-brand-blue-500/5" : "border-ops-border bg-ops-bg/40"
                }`}>
                <div className="flex items-center justify-between px-1.5 pb-2 pt-1">
                  <span className="text-sm font-semibold text-ops-text">{col.label}</span>
                  <span className="text-[11px] tabular-nums text-ops-text-muted">{cards.length}</span>
                </div>
                <div className="flex min-h-[60px] flex-col gap-2">
                  {cards.map((t) => <Card key={t.id} task={t} onOpen={() => setOpen(t)} onDragStart={() => setDragId(t.id)} />)}
                </div>
                <QuickAdd column={col.key} onAdded={refresh} />
              </div>
            );
          })}
        </div>
      )}

      {open && <TaskEditor task={tasks.find((t) => t.id === open.id) ?? open} team={team}
        onClose={() => setOpen(null)} onSaved={refresh} />}
    </div>
  );
}

function Card({ task, onOpen, onDragStart }: { task: Task; onOpen: () => void; onDragStart: () => void }) {
  const company = task.company ? COMPANY_META[task.company] : null;
  return (
    <button type="button" draggable onDragStart={onDragStart} onClick={onOpen}
      className="cursor-grab rounded-xl border border-ops-border bg-ops-surface p-3 text-left shadow-card transition hover:border-brand-blue-500/50 active:cursor-grabbing">
      <div className="text-sm font-medium leading-snug text-ops-text">{task.title}</div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold capitalize ${PRIORITY_CHIP[task.priority]}`}>{task.priority}</span>
        {company && <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${company.chip}`}>{company.label}</span>}
        {task.labels.map((l) => <span key={l} className="rounded-full bg-ops-border px-2 py-0.5 text-[10px] text-ops-text-muted">{l}</span>)}
      </div>
      {(task.assignee || task.due_date) && (
        <div className="mt-2.5 flex items-center gap-2">
          {task.assignee && (
            <span title={task.assignee} className="grid h-6 w-6 place-items-center rounded-full bg-brand-blue-500/15 text-[10px] font-bold text-brand-blue-400">
              {initials(task.assignee)}
            </span>
          )}
          {task.due_date && <span className={`text-[11px] ${dueTone(task.due_date, task.status)}`}>{fmtDue(task.due_date)}</span>}
        </div>
      )}
    </button>
  );
}

function QuickAdd({ column, onAdded }: { column: string; onAdded: () => void }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const t = title.trim();
    if (!t) return setAdding(false);
    setBusy(true);
    await fetch("/api/ops/tasks", {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: t, status: column }),
    });
    setBusy(false); setTitle(""); setAdding(false); onAdded();
  }

  if (!adding) {
    return (
      <button type="button" onClick={() => setAdding(true)}
        className="mt-2 flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs text-ops-text-muted transition hover:bg-ops-surface hover:text-ops-text">
        <Plus size={13} /> Add task
      </button>
    );
  }
  return (
    <div className="mt-2 rounded-xl border border-brand-blue-500/40 bg-ops-surface p-2">
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setAdding(false); }}
        onBlur={submit} placeholder="What needs doing?" disabled={busy}
        className="w-full bg-transparent text-sm text-ops-text placeholder:text-ops-text-muted focus:outline-none" />
    </div>
  );
}

function TaskEditor({ task, team, onClose, onSaved }: { task: Task; team: string[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    title: task.title,
    description: task.description ?? "",
    status: task.status,
    priority: task.priority,
    company: task.company ?? "",
    assignee: task.assignee ?? "",
    due_date: task.due_date ? String(task.due_date).slice(0, 10) : "",
    labels: task.labels.join(", "),
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF({ ...f, [k]: v });

  async function save() {
    setBusy(true);
    await fetch(`/api/ops/tasks/${task.id}`, {
      method: "PATCH", credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: f.title,
        description: f.description || null,
        status: f.status,
        priority: f.priority,
        company: f.company || null,
        assignee: f.assignee || null,
        due_date: f.due_date || null,
        labels: f.labels.split(",").map((l) => l.trim()).filter(Boolean),
      }),
    });
    setBusy(false); onSaved(); onClose();
  }
  async function remove() {
    if (!confirm(`Delete "${task.title}"?`)) return;
    await fetch(`/api/ops/tasks/${task.id}`, { method: "DELETE", credentials: "include" });
    onSaved(); onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-2 backdrop-blur-sm sm:p-4" onClick={onClose}>
      <div className="my-4 w-full max-w-lg rounded-2xl border border-ops-border bg-ops-surface shadow-card sm:my-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-ops-border p-4">
          <input value={f.title} onChange={(e) => set("title", e.target.value)}
            className="w-full bg-transparent text-base font-semibold text-ops-text focus:outline-none" />
          <button type="button" onClick={onClose} className="p-1 text-ops-text-muted hover:text-ops-text"><X size={20} /></button>
        </div>
        <div className="space-y-4 p-4">
          <textarea value={f.description} onChange={(e) => set("description", e.target.value)} rows={3}
            placeholder="Details, links, context…" className={input} />
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-ops-text-muted">Column
              <select value={f.status} onChange={(e) => set("status", e.target.value)} className={`${input} mt-1`}>
                {COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </label>
            <label className="text-xs text-ops-text-muted">Priority
              <select value={f.priority} onChange={(e) => set("priority", e.target.value)} className={`${input} mt-1`}>
                <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
              </select>
            </label>
            <label className="text-xs text-ops-text-muted">Brand
              <select value={f.company} onChange={(e) => set("company", e.target.value)} className={`${input} mt-1`}>
                <option value="">—</option>
                {Object.entries(COMPANY_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
              </select>
            </label>
            <label className="text-xs text-ops-text-muted">Owner
              <select value={f.assignee} onChange={(e) => set("assignee", e.target.value)} className={`${input} mt-1`}>
                <option value="">Unassigned</option>
                {team.map((e) => <option key={e} value={e}>{e}</option>)}
              </select>
            </label>
            <label className="text-xs text-ops-text-muted"><span className="flex items-center gap-1"><CalendarDays size={11} /> Due</span>
              <input type="date" value={f.due_date} onChange={(e) => set("due_date", e.target.value)} className={`${input} mt-1`} />
            </label>
            <label className="text-xs text-ops-text-muted"><span className="flex items-center gap-1"><Tag size={11} /> Labels</span>
              <input value={f.labels} onChange={(e) => set("labels", e.target.value)} placeholder="design, urgent" className={`${input} mt-1`} />
            </label>
          </div>
          <div className="flex items-center justify-between border-t border-ops-border pt-3">
            <button type="button" onClick={remove} className="flex items-center gap-1.5 text-xs text-ops-text-muted hover:text-red-400">
              <Trash2 size={13} /> Delete
            </button>
            <button type="button" disabled={busy || !f.title.trim()} onClick={save}
              className="rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 px-5 py-2 text-sm font-semibold text-white disabled:opacity-40">
              {busy ? <Loader2 size={15} className="animate-spin" /> : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
