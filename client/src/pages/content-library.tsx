import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";
import { ModalPortal } from "../components/modal-portal";

interface ContentFile {
  id: string;
  s3_key: string;
  original_filename: string;
  content_type: string | null;
  size_bytes: number | null;
  uploaded_by: string;
  uploaded_at: string;
  project_id: string | null;
  project_name: string | null;
  tags: string[];
  description: string | null;
}

interface Status {
  configured: boolean;
  reason: string | null;
  bucket: string | null;
  region: string;
  max_bytes: number;
}

interface Project {
  id: string;
  name: string;
}

function formatBytes(b: number | null): string {
  if (!b) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || isNaN(ms)) return "?";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

function fileIcon(ct: string | null): { label: string; color: string } {
  const t = (ct || "").toLowerCase();
  if (t.startsWith("video/")) return { label: "VIDEO", color: "#7C3AED" };
  if (t.startsWith("image/")) return { label: "IMAGE", color: "#0EA5E9" };
  if (t.startsWith("audio/")) return { label: "AUDIO", color: "#10B981" };
  if (t.includes("pdf")) return { label: "PDF", color: "#EF4444" };
  if (t.startsWith("text/")) return { label: "TEXT", color: "#F59E0B" };
  return { label: "FILE", color: "#6B7280" };
}

export default function ContentLibrary() {
  const queryClient = useQueryClient();
  const [typeFilter, setTypeFilter] = useState<"" | "video" | "image" | "audio" | "application">("");
  const [projectFilter, setProjectFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadEntry[]>([]);

  const { data: status } = useQuery<Status>({
    queryKey: ["content-status"],
    queryFn: () => fetch("/api/ops/content/status").then((r) => r.json()),
  });

  const { data: projectsData } = useQuery<{ projects: Project[] }>({
    queryKey: ["ops-projects-all-for-content"],
    queryFn: () => fetch("/api/ops/projects?includeArchived=true").then((r) => r.json()),
    staleTime: 1000 * 60 * 5,
  });
  const projects = projectsData?.projects ?? [];

  const queryUrl = useMemo(() => {
    const p = new URLSearchParams();
    if (typeFilter) p.set("type", typeFilter);
    if (projectFilter) p.set("project_id", projectFilter);
    if (search.trim()) p.set("q", search.trim());
    const qs = p.toString();
    return `/api/ops/content/files${qs ? `?${qs}` : ""}`;
  }, [typeFilter, projectFilter, search]);

  const { data, isLoading } = useQuery<{ files: ContentFile[] }>({
    queryKey: ["content-files", typeFilter, projectFilter, search],
    queryFn: () => fetch(queryUrl).then((r) => r.json()),
  });
  const files = data?.files ?? [];

  const startUploads = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    if (!status?.configured) {
      alert(`Storage not configured: ${status?.reason ?? "unknown"}`);
      return;
    }
    const newEntries: UploadEntry[] = Array.from(fileList).map((f) => ({
      id: crypto.randomUUID(),
      name: f.name,
      size: f.size,
      progress: 0,
      status: "queued",
      _file: f,
    }));
    setUploads((u) => [...newEntries, ...u]);
    for (const entry of newEntries) {
      await uploadOne(entry);
    }
  };

  const uploadOne = async (entry: UploadEntry) => {
    setUploads((u) => u.map((e) => (e.id === entry.id ? { ...e, status: "presigning" } : e)));
    try {
      const presign = await fetch("/api/ops/content/presign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: entry.name,
          content_type: entry._file.type || "application/octet-stream",
          size_bytes: entry.size,
        }),
      });
      const pj = await presign.json();
      if (!presign.ok) throw new Error(pj.error || "presign failed");

      setUploads((u) => u.map((e) => (e.id === entry.id ? { ...e, status: "uploading" } : e)));

      // XHR for upload progress
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", pj.uploadUrl);
        xhr.setRequestHeader("Content-Type", entry._file.type || "application/octet-stream");
        xhr.upload.onprogress = (evt) => {
          if (evt.lengthComputable) {
            const pct = Math.round((evt.loaded / evt.total) * 100);
            setUploads((u) => u.map((e) => (e.id === entry.id ? { ...e, progress: pct } : e)));
          }
        };
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`S3 ${xhr.status}: ${xhr.responseText.slice(0, 200)}`)));
        xhr.onerror = () => reject(new Error("Network error during upload — check bucket CORS"));
        xhr.send(entry._file);
      });

      setUploads((u) => u.map((e) => (e.id === entry.id ? { ...e, status: "saving", progress: 100 } : e)));

      const save = await fetch("/api/ops/content/files", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: pj.id,
          s3_key: pj.key,
          original_filename: entry.name,
          content_type: entry._file.type || null,
          size_bytes: entry.size,
        }),
      });
      const sj = await save.json();
      if (!save.ok) throw new Error(sj.error || "save failed");

      setUploads((u) => u.map((e) => (e.id === entry.id ? { ...e, status: "done", progress: 100 } : e)));
      queryClient.invalidateQueries({ queryKey: ["content-files"] });
    } catch (err: any) {
      setUploads((u) => u.map((e) => (e.id === entry.id ? { ...e, status: "error", error: err.message } : e)));
    }
  };

  const inflight = uploads.filter((u) => u.status !== "done" && u.status !== "error");

  return (
    <div>
      <PageHero
        eyebrow="Workspace"
        title="Content library"
        subtitle="Team-shared storage for video, images, audio. Direct browser → S3 uploads. Tag by project, filter by type."
        actions={
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={!status?.configured}
            className="px-4 py-2 text-sm font-semibold rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white shadow-[0_4px_14px_-4px_rgba(46,91,255,0.5)] hover:opacity-95 disabled:opacity-40 disabled:cursor-not-allowed"
            title={status?.configured ? "Upload files" : "Storage not configured"}
          >
            + Upload files
          </button>
        }
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          startUploads(e.target.files);
          if (fileInputRef.current) fileInputRef.current.value = "";
        }}
      />

      {status && !status.configured && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 mb-5 text-sm">
          <div className="font-semibold text-amber-400 mb-1">Storage not configured</div>
          <div className="text-amber-300/80 text-[12px]">{status.reason}. See the prereqs in SESSION_LOG for the AWS CLI commands to set up the S3 bucket + IAM.</div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card p-4 sm:p-5 mb-5">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search filename or description…"
            className="flex-1 bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
          />
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as any)}
            className="bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
          >
            <option value="">All types</option>
            <option value="video">Video</option>
            <option value="image">Image</option>
            <option value="audio">Audio</option>
            <option value="application">Documents</option>
          </select>
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
          >
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>

      {/* In-flight upload tray */}
      {inflight.length > 0 && (
        <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card p-4 mb-5">
          <h3 className="text-sm font-semibold text-ops-text mb-3">Uploading {inflight.length} file{inflight.length === 1 ? "" : "s"}</h3>
          <div className="space-y-2">
            {inflight.map((u) => (
              <div key={u.id}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-ops-text truncate flex-1 min-w-0">{u.name}</span>
                  <span className="text-ops-text-muted ml-2">{u.status === "uploading" ? `${u.progress}%` : u.status}</span>
                </div>
                <div className="w-full h-1.5 bg-ops-bg rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 transition-all" style={{ width: `${u.progress}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Failed uploads */}
      {uploads.filter((u) => u.status === "error").map((u) => (
        <div key={u.id} className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3 text-xs flex items-center justify-between">
          <div>
            <span className="font-semibold text-red-400">Failed:</span> <span className="text-red-300">{u.name}</span>
            <div className="text-red-300/80 text-[11px] mt-0.5">{u.error}</div>
          </div>
          <button onClick={() => setUploads((s) => s.filter((e) => e.id !== u.id))} className="text-red-400 hover:text-red-300">✕</button>
        </div>
      ))}

      {/* File grid */}
      {isLoading ? (
        <div className="bg-ops-surface border border-ops-border rounded-xl p-12 text-center text-sm text-ops-text-muted">Loading…</div>
      ) : files.length === 0 ? (
        <div className="bg-ops-surface border border-ops-border rounded-xl p-12 text-center">
          <div className="text-sm text-ops-text-muted mb-2">No files yet.</div>
          {status?.configured && (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="text-xs font-semibold text-brand-blue-500 hover:text-brand-blue-600"
            >
              Upload the first file
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {files.map((f) => {
            const icon = fileIcon(f.content_type);
            return (
              <button
                key={f.id}
                onClick={() => setSelectedId(f.id)}
                className="bg-ops-surface border border-ops-border rounded-xl shadow-card overflow-hidden hover:border-brand-blue-500/40 hover:shadow-[0_4px_14px_-4px_rgba(46,91,255,0.25)] transition-all text-left flex flex-col"
              >
                <div
                  className="aspect-video flex items-center justify-center text-white font-bold text-sm tracking-wider"
                  style={{ background: icon.color }}
                >
                  {icon.label}
                </div>
                <div className="p-3 min-w-0">
                  <div className="text-xs font-semibold text-ops-text truncate" title={f.original_filename}>{f.original_filename}</div>
                  <div className="text-[10px] text-ops-text-muted mt-1 flex items-center justify-between">
                    <span>{formatBytes(f.size_bytes)}</span>
                    <span>{fmtRelative(f.uploaded_at)}</span>
                  </div>
                  {f.project_name && (
                    <div className="text-[10px] text-brand-blue-400 mt-1.5 truncate">{f.project_name}</div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {selectedId && (
        <FileDetailDrawer
          id={selectedId}
          projects={projects}
          onClose={() => setSelectedId(null)}
          onChanged={() => queryClient.invalidateQueries({ queryKey: ["content-files"] })}
        />
      )}
    </div>
  );
}

interface UploadEntry {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: "queued" | "presigning" | "uploading" | "saving" | "done" | "error";
  error?: string;
  _file: File;
}

function FileDetailDrawer({
  id,
  projects,
  onClose,
  onChanged,
}: {
  id: string;
  projects: Project[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<{ file: ContentFile; downloadUrl: string | null }>({
    queryKey: ["content-file-detail", id],
    queryFn: () => fetch(`/api/ops/content/files/${id}`).then((r) => r.json()),
  });
  const file = data?.file;
  const [projectId, setProjectId] = useState<string>("");
  const [tags, setTags] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Seed form when file loads
  useMemo(() => {
    if (file) {
      setProjectId(file.project_id ?? "");
      setTags((file.tags ?? []).join(", "));
      setDescription(file.description ?? "");
    }
  }, [file]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const tagsArr = tags.split(",").map((t) => t.trim()).filter(Boolean);
      const r = await fetch(`/api/ops/content/files/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_id: projectId || null, tags: tagsArr, description: description || null }),
      });
      if (r.ok) {
        setMsg("✓ Saved");
        onChanged();
        queryClient.invalidateQueries({ queryKey: ["content-file-detail", id] });
      } else {
        const j = await r.json().catch(() => ({}));
        setMsg(`Failed: ${j.error || r.status}`);
      }
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (!file) return;
    if (!confirm(`Delete "${file.original_filename}" permanently? Removes both the S3 object and the metadata.`)) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/ops/content/files/${id}`, { method: "DELETE" });
      if (r.ok) {
        onChanged();
        onClose();
      } else {
        const j = await r.json().catch(() => ({}));
        setMsg(`Failed: ${j.error || r.status}`);
      }
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
        <div className="flex items-baseline justify-between mb-4">
          <h3 className="text-base font-bold text-ops-text">File detail</h3>
          <button onClick={onClose} className="text-ops-text-muted hover:text-ops-text text-xl leading-none">×</button>
        </div>

        {isLoading || !file ? (
          <div className="py-12 text-center text-sm text-ops-text-muted">Loading…</div>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="text-sm font-bold text-ops-text break-all">{file.original_filename}</div>
              <div className="text-[11px] text-ops-text-subtle mt-1">
                {formatBytes(file.size_bytes)} · {file.content_type ?? "unknown"} · uploaded by {file.uploaded_by} {fmtRelative(file.uploaded_at)}
              </div>
            </div>

            {data?.downloadUrl && (
              <a
                href={data.downloadUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-block px-4 py-2 text-sm font-semibold rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white shadow-[0_4px_14px_-4px_rgba(46,91,255,0.5)] hover:opacity-95"
                download={file.original_filename}
              >
                Download
              </a>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-ops-text-muted uppercase tracking-wider mb-1.5">Project</label>
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
                >
                  <option value="">— Unassigned —</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-ops-text-muted uppercase tracking-wider mb-1.5">Tags (comma-separated)</label>
                <input
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="raw-footage, b-roll, gym"
                  className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
                />
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ops-text-muted uppercase tracking-wider mb-1.5">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Notes for the team about this file"
                rows={2}
                className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
              />
            </div>

            {msg && (
              <div className={`px-3 py-2 rounded-lg text-xs ${msg.startsWith("✓") ? "bg-brand-blue-500/10 text-brand-blue-500 border border-brand-blue-400/30" : "bg-red-500/10 text-red-400 border border-red-500/30"}`}>{msg}</div>
            )}

            <div className="flex justify-between gap-3 pt-2">
              <button
                onClick={del}
                disabled={deleting || saving}
                className="px-4 py-2 text-xs font-medium rounded-lg bg-red-500/10 border border-red-500/40 text-red-400 hover:bg-red-500/20 disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
              <div className="flex gap-2">
                <button onClick={onClose} className="px-4 py-2 text-sm text-ops-text-muted hover:text-ops-text">Close</button>
                <button
                  onClick={save}
                  disabled={saving || deleting}
                  className="px-5 py-2 text-sm font-semibold rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white shadow-[0_4px_14px_-4px_rgba(46,91,255,0.5)] disabled:opacity-40 hover:opacity-95"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </ModalPortal>
  );
}
