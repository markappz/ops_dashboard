import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";
import { ModalPortal } from "../components/modal-portal";

type ProjectStatus = "active" | "on_hold" | "done" | "archived";

interface Project {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  owner_email: string | null;
  due_date: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_META: Record<ProjectStatus, { label: string; tone: "ok" | "warn" | "muted" | "neutral"; order: number }> = {
  active: { label: "Active", tone: "ok", order: 0 },
  on_hold: { label: "On hold", tone: "warn", order: 1 },
  done: { label: "Done", tone: "neutral", order: 2 },
  archived: { label: "Archived", tone: "muted", order: 3 },
};

const TONE_CLASSES: Record<string, string> = {
  ok: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30",
  warn: "bg-amber-500/10 text-amber-400 border border-amber-500/30",
  neutral: "bg-brand-blue-500/10 text-brand-blue-500 border border-brand-blue-400/30",
  muted: "bg-ops-bg text-ops-text-muted border border-ops-border",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || isNaN(ms)) return "?";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

export default function Projects() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<"" | ProjectStatus>("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [editing, setEditing] = useState<Project | "new" | null>(null);

  const queryUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    if (includeArchived) params.set("includeArchived", "true");
    return `/api/ops/projects${params.toString() ? `?${params.toString()}` : ""}`;
  }, [statusFilter, includeArchived]);

  const { data, isLoading, error } = useQuery<{ projects: Project[] }>({
    queryKey: ["ops-projects", statusFilter, includeArchived],
    queryFn: () => fetch(queryUrl).then((r) => r.json()),
  });

  const projects = data?.projects ?? [];
  const counts = useMemo(() => {
    const by: Record<string, number> = { active: 0, on_hold: 0, done: 0, archived: 0 };
    for (const p of projects) by[p.status] = (by[p.status] || 0) + 1;
    return by;
  }, [projects]);

  return (
    <div>
      <PageHero
        eyebrow="Workspace"
        title="Projects"
        subtitle="Shared list of active projects across FitScript. Owner, status, and due dates visible to the team."
        actions={
          <button
            onClick={() => setEditing("new")}
            className="px-4 py-2 text-sm font-semibold rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white shadow-[0_4px_14px_-4px_rgba(46,91,255,0.5)] hover:opacity-95"
          >
            + New project
          </button>
        }
      />

      <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card p-4 sm:p-5 mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2 flex-wrap">
          {(["", "active", "on_hold", "done"] as const).map((s) => {
            const isActive = statusFilter === s;
            const label = s === "" ? `All (${projects.length})` : `${STATUS_META[s as ProjectStatus].label} (${counts[s as string] || 0})`;
            return (
              <button
                key={s || "all"}
                onClick={() => setStatusFilter(s)}
                className={`text-[12px] font-medium px-3 py-1.5 rounded-lg border transition-colors ${
                  isActive
                    ? "bg-brand-blue-500/10 text-brand-blue-500 border-brand-blue-400/40"
                    : "bg-ops-bg text-ops-text-muted border-ops-border hover:text-ops-text"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <label className="flex items-center gap-2 text-[11px] text-ops-text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
            className="rounded"
          />
          Include archived
        </label>
      </div>

      <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card overflow-hidden">
        {isLoading ? (
          <div className="px-4 py-12 text-center text-sm text-ops-text-muted">Loading projects…</div>
        ) : error ? (
          <div className="px-4 py-12 text-center text-sm text-red-400">Failed to load projects.</div>
        ) : projects.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <div className="text-sm text-ops-text-muted mb-3">No projects yet.</div>
            <button
              onClick={() => setEditing("new")}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-brand-blue-500/10 border border-brand-blue-400/40 text-brand-blue-500 hover:bg-brand-blue-500/20"
            >
              Create the first project
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-ops-text-muted border-b border-ops-border">
                  <th className="px-4 py-2 font-semibold">Name</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 font-semibold">Assigned to</th>
                  <th className="px-4 py-2 font-semibold">Due</th>
                  <th className="px-4 py-2 font-semibold">Updated</th>
                  <th className="px-4 py-2 font-semibold w-0"></th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => {
                  const meta = STATUS_META[p.status] ?? STATUS_META.active;
                  const isOverdue = p.due_date && p.status === "active" && new Date(p.due_date) < new Date();
                  return (
                    <tr
                      key={p.id}
                      onClick={() => setEditing(p)}
                      className="border-b border-ops-border last:border-b-0 hover:bg-ops-surface-hover cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3 text-ops-text">
                        <div className="font-medium">{p.name}</div>
                        {p.description && (
                          <div className="text-[11px] text-ops-text-muted line-clamp-1 mt-0.5">{p.description}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${TONE_CLASSES[meta.tone]}`}>
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {p.owner_email ? (
                          <span className="text-ops-text-muted">{p.owner_email}</span>
                        ) : (
                          <span className="text-ops-text-subtle italic">Unassigned</span>
                        )}
                      </td>
                      <td className={`px-4 py-3 text-xs ${isOverdue ? "text-red-400 font-semibold" : "text-ops-text-muted"}`}>
                        {fmtDate(p.due_date)}{isOverdue ? " (overdue)" : ""}
                      </td>
                      <td className="px-4 py-3 text-ops-text-subtle text-xs">{fmtRelative(p.updated_at)}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditing(p); }}
                          className="text-[11px] text-brand-blue-500 hover:text-brand-blue-600 font-semibold"
                        >
                          Edit →
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <ProjectEditModal
          project={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ["ops-projects"] });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

interface AdminOption {
  email: string;
}

function ProjectEditModal({
  project,
  onClose,
  onSaved,
}: {
  project: Project | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = project === null;
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? "active");
  const [ownerEmail, setOwnerEmail] = useState(project?.owner_email ?? "");
  const [dueDate, setDueDate] = useState(project?.due_date ?? "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pull the live admin list so the assignee dropdown stays in sync as
  // admins are added or removed in /settings.
  const { data: adminData } = useQuery<{ admins: AdminOption[] }>({
    queryKey: ["ops-admins"],
    queryFn: () => fetch("/api/ops/admins").then((r) => r.json()),
    staleTime: 1000 * 60 * 5, // 5 min — admins don't churn
  });
  const admins = adminData?.admins ?? [];
  // If the saved owner isn't in the admin list anymore (renamed / removed),
  // still show it as an option so we don't silently drop the assignment.
  const ownerOptions = useMemo(() => {
    const emails = new Set(admins.map((a) => a.email.toLowerCase()));
    const list = admins.map((a) => a.email);
    if (ownerEmail && !emails.has(ownerEmail.toLowerCase())) list.push(ownerEmail);
    return list;
  }, [admins, ownerEmail]);

  const save = async () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        status,
        owner_email: ownerEmail.trim().toLowerCase() || null,
        due_date: dueDate || null,
      };
      const url = isNew ? "/api/ops/projects" : `/api/ops/projects/${project!.id}`;
      const r = await fetch(url, {
        method: isNew ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.error || `HTTP ${r.status}`);
        return;
      }
      onSaved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (!project) return;
    if (!confirm(`Delete "${project.name}" permanently? This cannot be undone. To hide it instead, set status to Archived.`)) return;
    setDeleting(true);
    setError(null);
    try {
      const r = await fetch(`/api/ops/projects/${project.id}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setError(j.error || `HTTP ${r.status}`);
        return;
      }
      onSaved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <ModalPortal onClose={onClose}>
      <div
        className="bg-ops-surface border border-ops-border rounded-xl p-5 sm:p-6 w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-y-auto shadow-2xl my-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between mb-5">
          <h3 className="text-base font-bold text-ops-text">
            {isNew ? "New project" : `Edit "${project!.name}"`}
          </h3>
          <button onClick={onClose} className="text-ops-text-muted hover:text-ops-text text-xl leading-none">×</button>
        </div>

        <div className="space-y-4">
          <Field label="Name" required>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Klaviyo deliverability launch"
              className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
              autoFocus
            />
          </Field>

          <Field label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this project? Goals, scope, links."
              rows={3}
              className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Status">
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as ProjectStatus)}
                className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
              >
                <option value="active">Active</option>
                <option value="on_hold">On hold</option>
                <option value="done">Done</option>
                <option value="archived">Archived</option>
              </select>
            </Field>
            <Field label="Assigned to">
              <select
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
              >
                <option value="">Unassigned</option>
                {ownerOptions.map((email) => (
                  <option key={email} value={email}>{email}</option>
                ))}
              </select>
            </Field>
            <Field label="Due date">
              <input
                type="date"
                value={dueDate ? dueDate.slice(0, 10) : ""}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
              />
            </Field>
          </div>
        </div>

        {!isNew && project && (
          <TasksSection projectId={project.id} ownerOptions={ownerOptions} />
        )}

        {error && (
          <div className="mt-4 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-400">
            {error}
          </div>
        )}

        <div className="flex flex-col sm:flex-row justify-between gap-3 mt-6">
          <div>
            {!isNew && (
              <button
                onClick={del}
                disabled={deleting || saving}
                className="px-4 py-2 text-xs font-medium rounded-lg bg-red-500/10 border border-red-500/40 text-red-400 hover:bg-red-500/20 disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-ops-text-muted hover:text-ops-text"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving || !name.trim()}
              className="px-5 py-2 text-sm font-semibold rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white shadow-[0_4px_14px_-4px_rgba(46,91,255,0.5)] disabled:opacity-40 hover:opacity-95"
            >
              {saving ? "Saving…" : isNew ? "Create project" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold text-ops-text-muted uppercase tracking-wider mb-1.5">
        {label}{required && <span className="text-red-400 ml-1">*</span>}
      </label>
      {children}
    </div>
  );
}

// ─── Project tasks section ────────────────────────────────────────

type TaskStatus = "todo" | "doing" | "done";

interface ProjectTask {
  id: string;
  project_id: string;
  title: string;
  status: TaskStatus;
  assignee_email: string | null;
  sort_order: number;
  created_at: string;
  completed_at: string | null;
}

const TASK_STATUS_META: Record<TaskStatus, { label: string; tone: string }> = {
  todo: { label: "To do", tone: "bg-ops-bg text-ops-text-muted border-ops-border" },
  doing: { label: "Doing", tone: "bg-amber-500/10 text-amber-400 border-amber-500/30" },
  done: { label: "Done", tone: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" },
};

function TasksSection({ projectId, ownerOptions }: { projectId: string; ownerOptions: string[] }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<{ tasks: ProjectTask[] }>({
    queryKey: ["project-tasks", projectId],
    queryFn: () => fetch(`/api/ops/projects/${projectId}/tasks`).then((r) => r.json()),
  });
  const tasks = data?.tasks ?? [];
  const [newTitle, setNewTitle] = useState("");
  const [adding, setAdding] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["project-tasks", projectId] });

  const addTask = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    setAdding(true);
    try {
      await fetch(`/api/ops/projects/${projectId}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      setNewTitle("");
      invalidate();
    } finally {
      setAdding(false);
    }
  };

  const patchTask = async (taskId: string, body: Partial<{ title: string; status: TaskStatus; assignee_email: string | null }>) => {
    await fetch(`/api/ops/projects/${projectId}/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    invalidate();
  };

  const deleteTask = async (taskId: string) => {
    if (!confirm("Delete this task?")) return;
    await fetch(`/api/ops/projects/${projectId}/tasks/${taskId}`, { method: "DELETE" });
    invalidate();
  };

  const counts = useMemo(() => {
    const c = { todo: 0, doing: 0, done: 0 };
    for (const t of tasks) c[t.status] = (c[t.status] ?? 0) + 1;
    return c;
  }, [tasks]);
  const total = tasks.length;
  const pctDone = total === 0 ? 0 : Math.round((counts.done / total) * 100);

  return (
    <div className="mt-6 pt-5 border-t border-ops-border">
      <div className="flex items-baseline justify-between mb-3">
        <h4 className="text-sm font-semibold text-ops-text">
          Tasks {total > 0 && <span className="text-[11px] font-normal text-ops-text-muted ml-1">({counts.done}/{total} · {pctDone}%)</span>}
        </h4>
        {total > 0 && (
          <span className="text-[10px] text-ops-text-subtle">{counts.doing} doing · {counts.todo} todo</span>
        )}
      </div>

      {total > 0 && (
        <div className="h-1.5 bg-ops-bg rounded-full overflow-hidden mb-3">
          <div className="h-full bg-gradient-to-r from-brand-blue-500 to-emerald-500 transition-all" style={{ width: `${pctDone}%` }} />
        </div>
      )}

      {isLoading ? (
        <div className="text-xs text-ops-text-muted py-3">Loading tasks…</div>
      ) : (
        <ul className="space-y-1.5 mb-3">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-center gap-2 group">
              <button
                onClick={() => patchTask(t.id, { status: t.status === "done" ? "todo" : t.status === "todo" ? "doing" : "done" })}
                title={`Toggle status (currently ${TASK_STATUS_META[t.status].label})`}
                className={`shrink-0 w-5 h-5 rounded-full border flex items-center justify-center text-[10px] font-bold transition-colors ${
                  t.status === "done"
                    ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-400"
                    : t.status === "doing"
                      ? "bg-amber-500/15 border-amber-500/40 text-amber-400"
                      : "bg-ops-bg border-ops-border text-ops-text-muted hover:border-brand-blue-500/50"
                }`}
              >
                {t.status === "done" ? "✓" : t.status === "doing" ? "•" : ""}
              </button>
              <span className={`flex-1 text-sm ${t.status === "done" ? "text-ops-text-muted line-through" : "text-ops-text"}`}>
                {t.title}
              </span>
              {t.assignee_email && (
                <span className="text-[10px] text-ops-text-subtle shrink-0">{t.assignee_email.split("@")[0]}</span>
              )}
              <select
                value={t.assignee_email ?? ""}
                onChange={(e) => patchTask(t.id, { assignee_email: e.target.value || null })}
                className="opacity-0 group-hover:opacity-100 text-[10px] bg-ops-bg border border-ops-border rounded px-1 py-0.5 text-ops-text-muted focus:outline-none focus:border-brand-blue-500 transition-opacity shrink-0"
                title="Assign"
              >
                <option value="">—</option>
                {ownerOptions.map((email) => (
                  <option key={email} value={email}>{email.split("@")[0]}</option>
                ))}
              </select>
              <button
                onClick={() => deleteTask(t.id)}
                className="opacity-0 group-hover:opacity-100 text-[10px] text-red-400 hover:text-red-300 px-1 transition-opacity"
                title="Delete"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={addTask} className="flex gap-1.5">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="+ Add a task"
          disabled={adding}
          className="flex-1 bg-ops-bg border border-ops-border rounded px-2 py-1 text-xs text-ops-text focus:outline-none focus:border-brand-blue-500"
        />
        <button
          type="submit"
          disabled={adding || !newTitle.trim()}
          className="text-xs font-semibold px-3 py-1 rounded bg-brand-blue-500/15 border border-brand-blue-400/40 text-brand-blue-500 hover:bg-brand-blue-500/25 disabled:opacity-40"
        >
          {adding ? "…" : "Add"}
        </button>
      </form>
    </div>
  );
}
