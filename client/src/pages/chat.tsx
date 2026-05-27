import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";

interface Channel {
  id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
  last_message_at: string | null;
  message_count: number;
}

interface ChatMessage {
  id: number;
  channel_id: string;
  sender_email: string;
  body: string;
  created_at: string;
  edited_at: string | null;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "?";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function shortName(email: string): string {
  return email.split("@")[0];
}

// Parse a message body and split into plain text + @username mention nodes.
// Mentions are matched against the supplied admin emails (case-insensitive).
function renderBody(body: string, mentionableUsernames: Set<string>, myUsername: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /@([a-zA-Z0-9_.+-]+)/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = regex.exec(body)) !== null) {
    if (m.index > lastIdx) parts.push(body.slice(lastIdx, m.index));
    const username = m[1];
    const isKnown = mentionableUsernames.has(username.toLowerCase());
    const isMe = username.toLowerCase() === myUsername.toLowerCase();
    parts.push(
      <span
        key={key++}
        className={`inline-block px-1 rounded text-[13px] font-semibold ${
          isMe
            ? "bg-amber-500/20 text-amber-300"
            : isKnown
              ? "bg-brand-blue-500/15 text-brand-blue-400"
              : "text-ops-text-muted"
        }`}
      >
        @{username}
      </span>,
    );
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < body.length) parts.push(body.slice(lastIdx));
  return parts;
}

function avatarColor(email: string): string {
  // Stable hash → one of 8 brand-aligned hues
  let h = 0;
  for (const c of email) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  const hues = [220, 200, 180, 260, 280, 320, 350, 30];
  return `hsl(${hues[h % hues.length]} 60% 55%)`;
}

function avatarInitial(email: string): string {
  const c = (email || "?").trim()[0];
  return (c || "?").toUpperCase();
}

export default function Chat() {
  const queryClient = useQueryClient();
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [newChannelOpen, setNewChannelOpen] = useState(false);

  const { data: channelsData } = useQuery<{ channels: Channel[] }>({
    queryKey: ["chat-channels"],
    queryFn: () => fetch("/api/ops/chat/channels").then((r) => r.json()),
    refetchInterval: 30_000,
  });
  const channels = channelsData?.channels ?? [];

  // Auto-pick #general (or first channel) on first load
  useEffect(() => {
    if (selectedChannelId || channels.length === 0) return;
    const general = channels.find((c) => c.name === "general");
    setSelectedChannelId((general ?? channels[0]).id);
  }, [channels, selectedChannelId]);

  // Get the current user's email so we can render "me" bubbles + author-only deletes
  const { data: settingsData } = useQuery<{ session: { email: string | null } }>({
    queryKey: ["ops-settings"],
    queryFn: () => fetch("/api/ops/settings").then((r) => r.json()),
    staleTime: 1000 * 60 * 5,
  });
  const myEmail = settingsData?.session?.email ?? "";

  // Live SSE subscription — invalidates message + channel queries on incoming events
  useEffect(() => {
    const es = new EventSource("/api/ops/chat/stream");
    es.addEventListener("message", () => {
      queryClient.invalidateQueries({ queryKey: ["chat-messages"] });
      queryClient.invalidateQueries({ queryKey: ["chat-channels"] });
    });
    es.addEventListener("message_deleted", () => {
      queryClient.invalidateQueries({ queryKey: ["chat-messages"] });
    });
    es.addEventListener("channel_created", () => {
      queryClient.invalidateQueries({ queryKey: ["chat-channels"] });
    });
    es.addEventListener("channel_deleted", () => {
      queryClient.invalidateQueries({ queryKey: ["chat-channels"] });
    });
    es.onerror = () => {
      // Browser auto-reconnects EventSource; nothing to do here.
    };
    return () => es.close();
  }, [queryClient]);

  const activeChannel = channels.find((c) => c.id === selectedChannelId) ?? null;

  return (
    <div>
      <PageHero
        eyebrow="Workspace"
        title="Team chat"
        subtitle="Centralized team comms. Channels for topics, history persists, every admin sees the same view."
      />

      <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card overflow-hidden flex flex-col lg:flex-row h-[calc(100vh-260px)] min-h-[520px]">
        {/* Channel sidebar */}
        <aside className="lg:w-64 border-b lg:border-b-0 lg:border-r border-ops-border bg-ops-bg flex flex-col shrink-0">
          <div className="px-3 py-3 border-b border-ops-border flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ops-text-muted">Channels</h3>
            <button
              onClick={() => setNewChannelOpen(true)}
              className="text-xs font-semibold text-brand-blue-500 hover:text-brand-blue-600"
              title="New channel"
            >
              + New
            </button>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {channels.map((c) => {
              const isActive = c.id === selectedChannelId;
              return (
                <button
                  key={c.id}
                  onClick={() => setSelectedChannelId(c.id)}
                  className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                    isActive
                      ? "bg-brand-blue-500/15 text-brand-blue-400 border-l-2 border-brand-blue-500"
                      : "text-ops-text-muted hover:text-ops-text hover:bg-ops-surface-hover border-l-2 border-transparent"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium"># {c.name}</span>
                    {c.message_count > 0 && (
                      <span className="text-[10px] text-ops-text-subtle">{c.message_count}</span>
                    )}
                  </div>
                </button>
              );
            })}
            {channels.length === 0 && (
              <div className="px-3 py-4 text-xs text-ops-text-muted text-center">
                No channels yet
              </div>
            )}
          </div>
        </aside>

        {/* Thread + composer */}
        <main className="flex-1 flex flex-col min-h-0 min-w-0">
          {activeChannel ? (
            <ChannelThread
              channel={activeChannel}
              myEmail={myEmail}
              onChannelDeleted={() => {
                setSelectedChannelId(null);
                queryClient.invalidateQueries({ queryKey: ["chat-channels"] });
              }}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-ops-text-muted">
              Select a channel to start
            </div>
          )}
        </main>
      </div>

      {newChannelOpen && (
        <NewChannelDialog
          onClose={() => setNewChannelOpen(false)}
          onCreated={(c) => {
            setSelectedChannelId(c.id);
            setNewChannelOpen(false);
            queryClient.invalidateQueries({ queryKey: ["chat-channels"] });
          }}
        />
      )}
    </div>
  );
}

function ChannelThread({
  channel,
  myEmail,
  onChannelDeleted,
}: {
  channel: Channel;
  myEmail: string;
  onChannelDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // @-mention autocomplete state
  const { data: adminData } = useQuery<{ admins: Array<{ email: string }> }>({
    queryKey: ["ops-admins"],
    queryFn: () => fetch("/api/ops/admins").then((r) => r.json()),
    staleTime: 1000 * 60 * 5,
  });
  const adminUsernames = useMemo(
    () => (adminData?.admins ?? []).map((a) => a.email.split("@")[0]),
    [adminData],
  );
  const mentionableSet = useMemo(
    () => new Set(adminUsernames.map((u) => u.toLowerCase())),
    [adminUsernames],
  );
  const myUsername = myEmail.split("@")[0];

  const [mentionState, setMentionState] = useState<{
    open: boolean;
    query: string;
    startIdx: number;
    cursorIdx: number;
    activeIdx: number;
  }>({ open: false, query: "", startIdx: 0, cursorIdx: 0, activeIdx: 0 });

  const mentionMatches = useMemo(() => {
    if (!mentionState.open) return [];
    const q = mentionState.query.toLowerCase();
    return adminUsernames
      .filter((u) => u.toLowerCase().includes(q))
      .slice(0, 8);
  }, [mentionState.open, mentionState.query, adminUsernames]);

  const onInputChange = (value: string, cursorIdx: number) => {
    setInput(value);
    // Detect @<word> immediately before cursor; opens dropdown when found.
    const slice = value.slice(0, cursorIdx);
    const m = slice.match(/(?:^|\s)@([a-zA-Z0-9_.+-]*)$/);
    if (m) {
      const startIdx = slice.length - m[0].length + (m[0].startsWith(" ") ? 1 : 0);
      setMentionState({ open: true, query: m[1], startIdx, cursorIdx, activeIdx: 0 });
    } else {
      setMentionState((s) => ({ ...s, open: false }));
    }
  };

  const insertMention = (username: string) => {
    const before = input.slice(0, mentionState.startIdx);
    const after = input.slice(mentionState.cursorIdx);
    const inserted = `@${username} `;
    const next = before + inserted + after;
    const newCursor = before.length + inserted.length;
    setInput(next);
    setMentionState((s) => ({ ...s, open: false }));
    // Re-focus + position cursor after the inserted mention
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = newCursor;
    });
  };

  const { data, isLoading } = useQuery<{ messages: ChatMessage[] }>({
    queryKey: ["chat-messages", channel.id],
    queryFn: () => fetch(`/api/ops/chat/channels/${channel.id}/messages?limit=200`).then((r) => r.json()),
  });
  const messages = data?.messages ?? [];

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = input.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const r = await fetch(`/api/ops/chat/channels/${channel.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (r.ok) {
        setInput("");
        queryClient.invalidateQueries({ queryKey: ["chat-messages", channel.id] });
      }
    } finally {
      setSending(false);
    }
  };

  const deleteMessage = async (id: number) => {
    if (!confirm("Delete this message?")) return;
    const r = await fetch(`/api/ops/chat/messages/${id}`, { method: "DELETE" });
    if (r.ok) queryClient.invalidateQueries({ queryKey: ["chat-messages", channel.id] });
  };

  const deleteChannel = async () => {
    if (!confirm(`Delete #${channel.name}? All messages will be lost.`)) return;
    const r = await fetch(`/api/ops/chat/channels/${channel.id}`, { method: "DELETE" });
    if (r.ok) onChannelDeleted();
    else {
      const j = await r.json().catch(() => ({}));
      alert(j.error || "Failed to delete channel");
    }
  };

  // Group consecutive messages from same sender within 5 min
  const groups = useMemo(() => {
    const g: Array<{ sender: string; messages: ChatMessage[]; firstAt: string }> = [];
    for (const m of messages) {
      const last = g[g.length - 1];
      const sameSender = last && last.sender === m.sender_email;
      const recent = last && new Date(m.created_at).getTime() - new Date(last.messages[last.messages.length - 1].created_at).getTime() < 5 * 60_000;
      if (sameSender && recent) {
        last.messages.push(m);
      } else {
        g.push({ sender: m.sender_email, messages: [m], firstAt: m.created_at });
      }
    }
    return g;
  }, [messages]);

  return (
    <>
      <div className="px-4 py-3 border-b border-ops-border flex items-center justify-between shrink-0">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ops-text"># {channel.name}</h3>
          {channel.description && (
            <p className="text-[11px] text-ops-text-muted truncate">{channel.description}</p>
          )}
        </div>
        {channel.name !== "general" && (
          <button
            onClick={deleteChannel}
            className="text-[11px] text-red-400 hover:text-red-300"
            title="Delete channel"
          >
            Delete channel
          </button>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-0">
        {isLoading ? (
          <div className="text-center text-sm text-ops-text-muted">Loading…</div>
        ) : groups.length === 0 ? (
          <div className="text-center text-sm text-ops-text-muted py-12">
            No messages yet. Send the first one →
          </div>
        ) : (
          groups.map((g, i) => (
            <div key={i} className="flex gap-3">
              <div
                className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-semibold"
                style={{ background: avatarColor(g.sender) }}
                title={g.sender}
              >
                {avatarInitial(g.sender)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-sm font-semibold text-ops-text">{shortName(g.sender)}</span>
                  <span className="text-[10px] text-ops-text-subtle">{fmtTime(g.firstAt)}</span>
                </div>
                <div className="space-y-1">
                  {g.messages.map((m) => (
                    <div key={m.id} className="group flex items-start gap-2">
                      <div className="text-sm text-ops-text whitespace-pre-wrap break-words flex-1 min-w-0">
                        {renderBody(m.body, mentionableSet, myUsername)}
                      </div>
                      {m.sender_email === myEmail && (
                        <button
                          onClick={() => deleteMessage(m.id)}
                          className="opacity-0 group-hover:opacity-100 text-[10px] text-red-400 hover:text-red-300 shrink-0 transition-opacity"
                          title="Delete"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <form onSubmit={send} className="border-t border-ops-border p-3 shrink-0 relative">
        {mentionState.open && mentionMatches.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 mb-1 bg-ops-surface border border-ops-border rounded-lg shadow-2xl overflow-hidden z-10 max-h-64 overflow-y-auto">
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-ops-text-muted border-b border-ops-border bg-ops-bg">
              Mention an admin
            </div>
            {mentionMatches.map((username, i) => (
              <button
                key={username}
                type="button"
                onClick={() => insertMention(username)}
                onMouseEnter={() => setMentionState((s) => ({ ...s, activeIdx: i }))}
                className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${
                  i === mentionState.activeIdx
                    ? "bg-brand-blue-500/15 text-brand-blue-400"
                    : "text-ops-text-muted hover:text-ops-text hover:bg-ops-surface-hover"
                }`}
              >
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-semibold shrink-0"
                  style={{ background: avatarColor(username) }}
                >
                  {avatarInitial(username)}
                </div>
                <span className="font-medium">@{username}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => onInputChange(e.target.value, e.target.selectionStart)}
            onKeyDown={(e) => {
              if (mentionState.open && mentionMatches.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMentionState((s) => ({ ...s, activeIdx: Math.min(s.activeIdx + 1, mentionMatches.length - 1) }));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionState((s) => ({ ...s, activeIdx: Math.max(s.activeIdx - 1, 0) }));
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  insertMention(mentionMatches[mentionState.activeIdx]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMentionState((s) => ({ ...s, open: false }));
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(e as unknown as React.FormEvent);
              }
            }}
            onSelect={(e) => {
              // Re-check mention context as cursor moves (e.g. user clicked into middle of text)
              const ta = e.currentTarget;
              onInputChange(ta.value, ta.selectionStart);
            }}
            rows={1}
            placeholder={`Message #${channel.name} — @ to mention, Enter to send, Shift+Enter for newline`}
            disabled={sending}
            className="flex-1 resize-none bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text placeholder-ops-text-subtle focus:outline-none focus:border-brand-blue-500 max-h-40"
            style={{ minHeight: "42px" }}
          />
          <button
            type="submit"
            disabled={!input.trim() || sending}
            className="h-[42px] px-4 rounded-lg bg-gradient-to-br from-brand-blue-600 to-brand-blue-500 text-white text-sm font-semibold disabled:opacity-30 hover:opacity-95"
          >
            {sending ? "…" : "Send"}
          </button>
        </div>
      </form>
    </>
  );
}

function NewChannelDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (c: Channel) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/ops/chat/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.error || `HTTP ${r.status}`);
        return;
      }
      onCreated(j.channel);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-ops-surface border border-ops-border rounded-xl p-5 sm:p-6 w-full max-w-md shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-bold text-ops-text mb-4">New channel</h3>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-[11px] font-semibold text-ops-text-muted uppercase tracking-wider mb-1.5">
              Name
            </label>
            <div className="flex items-center bg-ops-bg border border-ops-border rounded-lg px-3 py-2 focus-within:border-brand-blue-500">
              <span className="text-ops-text-muted text-sm mr-1">#</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="design-feedback"
                className="flex-1 bg-transparent text-sm text-ops-text placeholder-ops-text-subtle focus:outline-none"
                autoFocus
                required
              />
            </div>
            <p className="text-[10px] text-ops-text-subtle mt-1">Lowercase, hyphens only. Auto-normalized.</p>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-ops-text-muted uppercase tracking-wider mb-1.5">
              Description (optional)
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's this channel for?"
              className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
            />
          </div>
          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-400">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-ops-text-muted hover:text-ops-text">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="px-5 py-2 text-sm font-semibold rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white shadow-[0_4px_14px_-4px_rgba(46,91,255,0.5)] disabled:opacity-40 hover:opacity-95"
            >
              {saving ? "Creating…" : "Create channel"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
