import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PuLoading, PuUnavailable } from "../components/peptideu/ui";

interface ApItem { id: string; kind: "article" | "video"; title: string; cover_url: string | null; published_at: string | null; native: boolean; has_video: boolean; }

const ago = (iso: string | null) => {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export default function PeptideuAp() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [kind, setKind] = useState<"article" | "video">("video");
  const [title, setTitle] = useState("");
  const [youtube, setYoutube] = useState("");
  const [body, setBody] = useState("");
  const [cover, setCover] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const { data, isLoading } = useQuery<ApItem[] | { error: string }>({
    queryKey: ["peptideu-ap"],
    queryFn: () => fetch("/api/ops/peptideu/ap").then((r) => r.json()),
  });

  const flash = (ok: boolean, text: string) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 5000); };
  const clear = () => { setEditing(null); setKind("video"); setTitle(""); setYoutube(""); setBody(""); setCover(""); };

  const save = async () => {
    if (!title.trim()) return flash(false, "Title is required.");
    if (kind === "video" && !youtube.trim()) return flash(false, "Paste the YouTube URL for a video post.");
    setBusy(true);
    try {
      const url = editing ? `/api/ops/peptideu/ap/${editing}` : "/api/ops/peptideu/ap";
      const r = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, title: title.trim(), youtube_url: youtube.trim(), body: body.trim(), cover_url: cover.trim() }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error === "read_only" ? "Read-only account — ask an admin" : d.error === "valid_youtube_url_required" ? "That doesn't look like a YouTube URL." : d.error);
      await qc.invalidateQueries({ queryKey: ["peptideu-ap"] });
      flash(true, editing ? "Updated." : "Published to AP Class.");
      clear();
    } catch (e: any) { flash(false, e.message); } finally { setBusy(false); }
  };

  const edit = (it: ApItem) => { setEditing(it.id); setKind(it.kind); setTitle(it.title); setCover(it.cover_url ?? ""); setYoutube(""); setBody(""); flash(true, "Editing — re-enter the YouTube URL and body to replace them."); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const remove = async (it: ApItem) => {
    if (!confirm(`Delete "${it.title}"?`)) return;
    const r = await fetch(`/api/ops/peptideu/ap/${it.id}`, { method: "DELETE" });
    const d = await r.json();
    if (d.error) return flash(false, d.error === "read_only" ? "Read-only account" : d.error);
    qc.invalidateQueries({ queryKey: ["peptideu-ap"] });
  };

  if (isLoading) return <PuLoading />;
  if ((data as any)?.error) return <PuUnavailable message={(data as any).error} />;
  const items = Array.isArray(data) ? data : [];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-ops-text">AP Class</h1>
        <p className="text-sm text-ops-text-muted mt-1">Publish native AP Class content — coaching replays (YouTube, plays in-app) and articles. No Circle needed.</p>
      </div>

      {/* editor */}
      <div className="bg-ops-surface border border-ops-border rounded-xl p-5 mb-8">
        <div className="flex items-center justify-between mb-1">
          <div className="text-sm font-semibold text-ops-text">{editing ? "Edit post" : "New AP post"}</div>
          {editing ? <button onClick={clear} className="text-xs text-ops-text-muted hover:text-ops-text">Cancel edit</button> : null}
        </div>
        <div className="flex gap-2 my-3">
          {(["video", "article"] as const).map((k) => (
            <button key={k} onClick={() => setKind(k)}
              className={`text-xs font-medium px-4 py-1.5 rounded-lg border ${kind === k ? "bg-fitscript-green/15 border-fitscript-green/50 text-fitscript-green" : "border-ops-border text-ops-text-muted"}`}>
              {k === "video" ? "Video replay" : "Article"}
            </button>
          ))}
        </div>
        <label className="block text-[11px] uppercase tracking-wide text-ops-text-muted mb-1">Title</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Kisspeptin — The Body's Upstream Switch"
          className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text mb-3" />
        {kind === "video" ? (
          <>
            <label className="block text-[11px] uppercase tracking-wide text-ops-text-muted mb-1">YouTube URL</label>
            <input value={youtube} onChange={(e) => setYoutube(e.target.value)} placeholder="https://youtube.com/watch?v=… or youtu.be/…"
              className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text mb-3" />
          </>
        ) : null}
        <label className="block text-[11px] uppercase tracking-wide text-ops-text-muted mb-1">Body {kind === "video" ? "(optional notes below the video)" : ""}</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} placeholder="Write the article / session notes. Blank lines separate paragraphs."
          className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text mb-3" />
        <label className="block text-[11px] uppercase tracking-wide text-ops-text-muted mb-1">Cover image URL (optional)</label>
        <input value={cover} onChange={(e) => setCover(e.target.value)} placeholder="https://…"
          className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text mb-4" />
        <button onClick={save} disabled={busy}
          className="text-sm font-medium px-5 py-2 rounded-lg bg-fitscript-green text-black hover:opacity-90 disabled:opacity-50">
          {busy ? "Saving…" : editing ? "Save changes" : "Publish to AP Class"}
        </button>
        {msg ? <span className={`ml-3 text-sm ${msg.ok ? "text-fitscript-green" : "text-red-400"}`}>{msg.text}</span> : null}
      </div>

      {/* list */}
      <div className="bg-ops-surface border border-ops-border rounded-xl">
        <div className="p-4 border-b border-ops-border flex items-center justify-between">
          <div className="text-sm font-semibold text-ops-text">Published ({items.length})</div>
          <div className="text-xs text-ops-text-muted">{items.filter((i) => i.native).length} native · {items.filter((i) => !i.native).length} imported</div>
        </div>
        {items.length === 0 ? (
          <div className="p-8 text-center text-sm text-ops-text-muted">No AP content yet.</div>
        ) : items.map((it) => (
          <div key={it.id} className="flex items-center gap-3 p-4 border-t border-ops-border first:border-t-0">
            <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded shrink-0 ${it.kind === "video" ? "bg-[#5C7FFF]/15 text-[#5C7FFF]" : "bg-ops-border/50 text-ops-text-muted"}`}>{it.kind}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-ops-text truncate">{it.title}</div>
              <div className="text-xs text-ops-text-muted mt-0.5">{it.native ? "native" : "imported from Circle"}{it.published_at ? ` · ${ago(it.published_at)}` : ""}</div>
            </div>
            <button onClick={() => edit(it)} className="text-xs px-2.5 py-1.5 rounded-lg border border-ops-border text-ops-text-muted hover:text-ops-text">Edit</button>
            <button onClick={() => remove(it)} className="text-xs px-2.5 py-1.5 rounded-lg border border-red-400/40 text-red-400 hover:bg-red-400/10">Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}
