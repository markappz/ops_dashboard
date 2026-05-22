import { useEffect, useRef, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * DIRT — the FitScript Ops AI. Always-on floating launcher + ⌘K + premium
 * glass-morphism slide-out panel with SSE-streamed responses.
 *
 * Architecture:
 * - Streams /api/ops/dirt/chat (SSE: text_delta, tool_start, tool_result,
 *   tool_error, usage, done, error events)
 * - Keeps an in-progress "streaming" assistant message that appends text as
 *   deltas arrive AND grows a per-message tool timeline as tools execute
 * - When the stream completes, the streaming message moves into history
 * - Slash commands: /clear, /tools, /read (read-only mode toggle)
 */

type Role = "user" | "assistant";
type ToolStatus = "pending" | "ok" | "error";

interface ToolEvent {
  id: string;
  name: string;
  input?: unknown;
  status: ToolStatus;
  result?: unknown;
  error?: string;
  durationMs?: number;
  startedAt: number;
}

interface Message {
  id: string;
  role: Role;
  content: string;
  tools: ToolEvent[];
  createdAt: number;
  copied?: boolean;
  /** still streaming */
  streaming?: boolean;
}

const QUICK_PROMPTS = [
  { icon: "📊", label: "What's MRR right now?" },
  { icon: "⚠️", label: "Are any integrations broken?" },
  { icon: "💸", label: "Top 5 most expensive AI users this month" },
  { icon: "📦", label: "Show me orders waiting to ship" },
  { icon: "✍️", label: "What content is pending approval?" },
  { icon: "📬", label: "Pause the welcome flow in Klaviyo" },
];

interface ConvoSummary {
  id: string;
  title: string;
  message_count: number;
  last_message_at: string;
  created_at: string;
}

export function Dirt() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<ConvoSummary[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Voice input — Web Speech API, browser-native, no API cost
  const voice = useVoiceInput({
    onTranscript: (text, isFinal) => {
      setInput(text);
      if (isFinal) {
        // Auto-focus textarea so user can edit or hit Enter
        inputRef.current?.focus();
      }
    },
  });

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch("/api/ops/dirt/conversations?limit=30");
      if (!r.ok) return;
      const j = await r.json();
      setHistory(j.conversations || []);
    } catch {}
  }, []);

  // Load history when panel opens
  useEffect(() => {
    if (open) loadHistory();
  }, [open, loadHistory]);

  const resumeConversation = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/ops/dirt/conversations/${id}`);
      if (!r.ok) return;
      const j = await r.json();
      const restored: Message[] = (j.messages || []).map((m: any) => ({
        id: crypto.randomUUID(),
        role: m.role,
        content: m.content,
        tools: [],
        createdAt: Date.now(),
      }));
      setMessages(restored);
      setConversationId(id);
      setHistoryOpen(false);
    } catch {}
  }, []);

  const deleteConversation = useCallback(async (id: string) => {
    await fetch(`/api/ops/dirt/conversations/${id}`, { method: "DELETE" });
    setHistory((prev) => prev.filter((c) => c.id !== id));
    if (conversationId === id) {
      setConversationId(null);
      setMessages([]);
    }
  }, [conversationId]);

  // ⌘K / Ctrl+K toggles, Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inField = ["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName || "");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open && !inField) {
        setOpen(false);
      }
      // Slash to focus input when panel open
      if (e.key === "/" && open && !inField) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Listen for the global "open dirt" event so the top-bar command bar can summon
  useEffect(() => {
    const onOpenWithQuery = (e: Event) => {
      const detail = (e as CustomEvent).detail as { prompt?: string } | undefined;
      setOpen(true);
      if (detail?.prompt) {
        setTimeout(() => {
          setInput(detail.prompt!);
          inputRef.current?.focus();
        }, 60);
      }
    };
    window.addEventListener("dirt:open", onOpenWithQuery);
    return () => window.removeEventListener("dirt:open", onOpenWithQuery);
  }, []);

  // Focus + autosize on open
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Auto-resize input
  useEffect(() => {
    if (!inputRef.current) return;
    const el = inputRef.current;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const reset = useCallback(() => {
    if (streaming) {
      abortRef.current?.abort();
    }
    setMessages([]);
    setInput("");
    setConversationId(null);
    setStreaming(false);
  }, [streaming]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;

      // Slash commands
      if (trimmed === "/clear") return reset();
      if (trimmed === "/read") {
        setReadOnly((v) => !v);
        setInput("");
        setMessages((m) => [
          ...m,
          { id: crypto.randomUUID(), role: "assistant", content: `*Read-only mode is now **${!readOnly ? "ON" : "OFF"}**. ${!readOnly ? "Write tools blocked." : "Write tools available again."}*`, tools: [], createdAt: Date.now() },
        ]);
        return;
      }
      if (trimmed === "/tools") {
        setInput("");
        send("List your available tools and what each one does.");
        return;
      }

      const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: trimmed, tools: [], createdAt: Date.now() };
      const assistantMsg: Message = { id: crypto.randomUUID(), role: "assistant", content: "", tools: [], createdAt: Date.now(), streaming: true };
      const nextHistory = [...messages, userMsg];
      setMessages([...nextHistory, assistantMsg]);
      setInput("");
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const r = await fetch("/api/ops/dirt/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: nextHistory.map((m) => ({ role: m.role, content: m.content })),
            readOnly,
            conversationId,
          }),
          signal: controller.signal,
        });

        if (!r.ok) {
          let detail = `HTTP ${r.status}`;
          try {
            const j = await r.json();
            detail = j.error || detail;
          } catch {}
          throw new Error(detail);
        }
        if (!r.body) throw new Error("No response body");

        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (!payload) continue;
            try {
              const evt = JSON.parse(payload);
              if (evt.type === "conversation" && evt.id) {
                setConversationId(evt.id);
              } else if (evt.type === "done" && evt.conversationId) {
                setConversationId(evt.conversationId);
                loadHistory(); // refresh the list with the new convo
              } else {
                applySSEEvent(assistantMsg.id, evt, setMessages);
              }
            } catch {
              // ignore malformed lines
            }
          }
        }
      } catch (e: any) {
        const errMsg = e?.name === "AbortError" ? "*(canceled)*" : `**Error:** ${e.message}`;
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: m.content + (m.content ? "\n\n" : "") + errMsg, streaming: false } : m)),
        );
      } finally {
        setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, streaming: false } : m)));
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [streaming, messages, readOnly, reset, conversationId, loadHistory],
  );

  const cancel = () => abortRef.current?.abort();

  const copy = async (msg: Message) => {
    await navigator.clipboard.writeText(msg.content);
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, copied: true } : m)));
    setTimeout(() => {
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, copied: false } : m)));
    }, 1500);
  };

  return (
    <>
      {/* Floating launcher */}
      <button
        onClick={() => setOpen(true)}
        title="Talk Dirt — ⌘K"
        aria-label="Open DIRT — Talk Dirt"
        className={`fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-40 group transition-all duration-300 ${
          open ? "scale-0 opacity-0 pointer-events-none" : "scale-100 opacity-100 animate-dirt-float"
        }`}
      >
        <div className="absolute -inset-1.5 bg-gradient-to-r from-brand-blue-600 via-brand-blue-500 to-brand-blue-400 rounded-full opacity-60 blur-lg group-hover:opacity-90 group-hover:blur-xl transition-all duration-300" />
        <div className="relative flex items-center justify-center sm:gap-2.5 sm:px-5 w-12 h-12 sm:w-auto sm:h-12 rounded-full bg-gradient-to-r from-brand-navy-900 via-brand-blue-600 to-brand-blue-500 text-white shadow-[0_10px_30px_-6px_rgba(46,91,255,0.6)] hover:shadow-[0_18px_40px_-8px_rgba(46,91,255,0.8)] transition-all duration-300 hover:-translate-y-0.5">
          <SparkleIcon className="w-5 h-5 sm:w-4 sm:h-4 animate-dirt-spin-slow" />
          <span className="hidden sm:inline text-sm font-bold tracking-tight">Talk Dirt</span>
          <span className="hidden md:inline text-[10px] font-semibold opacity-80 px-1.5 py-0.5 rounded bg-white/15 ml-0.5">⌘K</span>
        </div>
      </button>

      {/* Panel + backdrop */}
      <div
        className={`fixed inset-0 z-50 transition-opacity duration-200 ${
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      >
        <div
          className="absolute inset-0 bg-black/40 backdrop-blur-[3px]"
          onClick={() => setOpen(false)}
        />

        <div
          className={`absolute top-0 right-0 h-full w-full sm:w-[540px] bg-ops-surface/95 backdrop-blur-xl border-l border-ops-border shadow-[0_0_60px_-12px_rgba(0,0,0,0.5)] flex flex-col transition-transform duration-300 ease-out ${
            open ? "translate-x-0" : "translate-x-full"
          }`}
        >
          {/* Header — glass with brand cloud wash */}
          <div className="relative h-[72px] px-5 border-b border-ops-border flex items-center justify-between overflow-hidden shrink-0">
            <div
              aria-hidden
              className="absolute inset-0 pointer-events-none"
              style={{
                backgroundImage:
                  "radial-gradient(600px 200px at 0% 0%, rgb(46,91,255,0.16), transparent 60%), radial-gradient(400px 200px at 100% 100%, rgb(159,182,255,0.10), transparent 60%)",
              }}
            />
            <div className="relative flex items-center gap-3">
              <div className="relative">
                <div className="absolute -inset-1 bg-gradient-to-br from-brand-blue-500 to-brand-blue-700 rounded-xl opacity-50 blur-md" />
                <div className="relative w-10 h-10 rounded-xl bg-gradient-to-br from-brand-blue-500 to-brand-blue-700 flex items-center justify-center shadow-[0_4px_12px_-4px_rgba(46,91,255,0.5)]">
                  <SparkleIcon className="w-5 h-5 text-white" />
                </div>
              </div>
              <div>
                <div className="text-base font-bold text-ops-text leading-none tracking-tight flex items-center gap-2">
                  DIRT
                  {readOnly && (
                    <span className="text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 border border-amber-500/30">
                      Read-only
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-ops-text-muted mt-1">
                  Your FitScript ops AI · <kbd className="text-[10px] font-mono px-1 py-px rounded bg-ops-bg border border-ops-border">⌘K</kbd> to toggle
                </div>
              </div>
            </div>
            <div className="relative flex items-center gap-1">
              <button
                onClick={() => { setHistoryOpen((v) => !v); if (!historyOpen) loadHistory(); }}
                className={`text-[11px] px-2 py-1 rounded transition-colors flex items-center gap-1 ${
                  historyOpen
                    ? "bg-ops-accent-soft text-brand-blue-500"
                    : "text-ops-text-muted hover:text-ops-text hover:bg-ops-surface-hover"
                }`}
                title="Conversation history"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                History
              </button>
              {messages.length > 0 && (
                <button
                  onClick={reset}
                  className="text-[11px] text-ops-text-muted hover:text-ops-text px-2 py-1 rounded hover:bg-ops-surface-hover transition-colors"
                  title="Start a new conversation"
                >
                  New
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                className="p-1.5 rounded-lg text-ops-text-muted hover:text-ops-text hover:bg-ops-surface-hover transition-colors"
                title="Close (Esc)"
              >
                <CloseIcon />
              </button>
            </div>
          </div>

          {/* History dropdown — rendered OUTSIDE the header (which has
              overflow-hidden for the gradient wash) so it isn't clipped. */}
          {historyOpen && (
            <HistoryDropdown
              history={history}
              activeId={conversationId}
              onPick={resumeConversation}
              onDelete={deleteConversation}
              onClose={() => setHistoryOpen(false)}
            />
          )}

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
            {messages.length === 0 && !streaming && <EmptyState onPick={send} />}

            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} onCopy={copy} />
            ))}

            {streaming && messages[messages.length - 1]?.streaming && messages[messages.length - 1]?.content === "" && messages[messages.length - 1]?.tools.length === 0 && (
              <ThinkingBubble />
            )}
          </div>

          {/* Composer */}
          <div className="border-t border-ops-border p-3 shrink-0">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
              className="relative flex items-end gap-2"
            >
              <div className="flex-1 relative">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send(input);
                    }
                  }}
                  rows={1}
                  placeholder={
                    voice.listening
                      ? "Listening… speak now"
                      : streaming
                        ? "DIRT is digging…"
                        : "Talk dirt · / for commands · 🎙 for voice"
                  }
                  disabled={streaming}
                  className={`w-full resize-none bg-ops-bg border rounded-xl px-3.5 py-2.5 pr-10 text-sm text-ops-text placeholder-ops-text-subtle focus:outline-none focus:ring-2 max-h-40 transition-all ${
                    voice.listening
                      ? "border-red-400 focus:border-red-400 focus:ring-red-400/20"
                      : "border-ops-border focus:border-brand-blue-500 focus:ring-brand-blue-500/20"
                  }`}
                  style={{ minHeight: "44px" }}
                />
                {input.startsWith("/") && (
                  <SlashHint
                    input={input}
                    onPick={(cmd) => send(cmd)}
                  />
                )}
              </div>
              <VoiceButton voice={voice} disabled={streaming} />
              {streaming ? (
                <button
                  type="button"
                  onClick={cancel}
                  className="h-[44px] px-4 rounded-xl bg-ops-surface border border-ops-border text-ops-text text-sm font-semibold hover:bg-ops-surface-hover transition-colors"
                  title="Stop DIRT"
                >
                  Stop
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim()}
                  className="h-[44px] w-[44px] flex items-center justify-center rounded-xl bg-gradient-to-br from-brand-blue-600 to-brand-blue-500 text-white disabled:opacity-30 disabled:cursor-not-allowed hover:from-brand-blue-700 hover:to-brand-blue-600 hover:scale-105 transition-all shadow-[0_4px_14px_-4px_rgba(46,91,255,0.5)]"
                  title="Send (Enter)"
                >
                  <SendIcon />
                </button>
              )}
            </form>
            <div className="text-[10px] text-ops-text-subtle mt-2 px-1 flex items-center justify-between">
              <span>13 read tools · 9 write tools · audit-logged</span>
              <span className="opacity-70">
                {voice.error
                  ? <span className="text-red-400">mic: {voice.error}</span>
                  : <>cost: <code>ops_dirt</code></>}
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="py-2">
      <div className="text-base text-ops-text font-bold tracking-tight mb-1">Hey Paul — what do you need?</div>
      <div className="text-xs text-ops-text-muted mb-5">
        I have read access to every data source and can pause flows, approve drafts, queue topics. Try one of these:
      </div>
      <div className="space-y-1.5">
        {QUICK_PROMPTS.map((q, i) => (
          <button
            key={q.label}
            onClick={() => onPick(q.label)}
            className="w-full text-left px-3.5 py-2.5 rounded-xl border border-ops-border bg-ops-bg hover:bg-ops-surface-hover hover:border-brand-blue-500/40 text-sm text-ops-text-muted hover:text-ops-text transition-all group flex items-center gap-3 animate-dirt-fade-in"
            style={{ animationDelay: `${i * 50}ms` }}
          >
            <span className="text-base opacity-90">{q.icon}</span>
            <span className="flex-1">{q.label}</span>
            <span className="text-brand-blue-500 opacity-0 group-hover:opacity-100 transition-opacity">›</span>
          </button>
        ))}
      </div>
      <div className="mt-5 text-[11px] text-ops-text-subtle px-1">
        Slash commands: <code>/clear</code> · <code>/tools</code> · <code>/read</code> (toggle read-only)
      </div>
    </div>
  );
}

function MessageBubble({ message, onCopy }: { message: Message; onCopy: (m: Message) => void }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end animate-dirt-fade-in">
        <div className="max-w-[88%] px-4 py-2.5 rounded-2xl rounded-br-md bg-gradient-to-br from-brand-blue-600 to-brand-blue-500 text-white text-sm shadow-[0_4px_14px_-4px_rgba(46,91,255,0.4)]">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-2.5 animate-dirt-fade-in group/msg">
      <div className="relative w-8 h-8 rounded-xl bg-gradient-to-br from-brand-blue-500 to-brand-blue-700 flex items-center justify-center shrink-0 mt-0.5 shadow-[0_2px_8px_-2px_rgba(46,91,255,0.4)]">
        <SparkleIcon className="w-4 h-4 text-white" />
      </div>
      <div className="flex-1 min-w-0 space-y-2">
        {message.tools.length > 0 && <ToolTimeline tools={message.tools} />}
        {message.content && (
          <div className="relative">
            <div className="text-sm text-ops-text prose-dirt">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
              {message.streaming && <CaretBlink />}
            </div>
            {!message.streaming && message.content.length > 0 && (
              <button
                onClick={() => onCopy(message)}
                className="absolute -top-1 right-0 opacity-0 group-hover/msg:opacity-100 transition-opacity text-[11px] text-ops-text-muted hover:text-ops-text px-2 py-1 rounded-md bg-ops-surface border border-ops-border"
                title="Copy"
              >
                {message.copied ? "✓ Copied" : "Copy"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolTimeline({ tools }: { tools: ToolEvent[] }) {
  return (
    <div className="space-y-1.5">
      {tools.map((t) => (
        <ToolEventCard key={t.id} tool={t} />
      ))}
    </div>
  );
}

function ToolEventCard({ tool }: { tool: ToolEvent }) {
  const [open, setOpen] = useState(false);
  const isPending = tool.status === "pending";
  const isError = tool.status === "error";
  return (
    <div className="animate-dirt-slide-down">
      <button
        onClick={() => !isPending && setOpen((v) => !v)}
        disabled={isPending}
        className={`group/tool w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors text-left ${
          isError
            ? "bg-red-500/10 border-red-500/30 text-red-400"
            : isPending
              ? "bg-brand-blue-500/5 border-brand-blue-500/20 text-brand-blue-500"
              : "bg-ops-accent-soft border-brand-blue-400/30 text-ops-text-muted hover:border-brand-blue-400/60 hover:text-ops-text"
        }`}
      >
        <span className="relative inline-flex items-center justify-center w-3 h-3 shrink-0">
          {isPending ? (
            <span className="w-2.5 h-2.5 rounded-full border-2 border-brand-blue-500/30 border-t-brand-blue-500 animate-spin" />
          ) : isError ? (
            <span className="w-2 h-2 rounded-full bg-red-400" />
          ) : (
            <CheckIcon />
          )}
        </span>
        <span className="font-semibold text-ops-text">{prettyToolName(tool.name)}</span>
        {!isPending && tool.durationMs != null && (
          <span className="opacity-50 text-[10px]">{tool.durationMs}ms</span>
        )}
        <span className="flex-1" />
        {!isPending && (
          <svg className={`w-3 h-3 transition-transform opacity-40 group-hover/tool:opacity-100 ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>
      {open && !isPending && (
        <div className="mt-1.5 ml-5 p-2.5 rounded-lg bg-ops-bg border border-ops-border text-[10.5px] font-mono text-ops-text-muted max-h-48 overflow-auto">
          {tool.input != null && Object.keys(tool.input as object).length > 0 ? (
            <div className="mb-1.5">
              <span className="text-brand-blue-500 font-semibold">input:</span>{" "}
              {JSON.stringify(tool.input)}
            </div>
          ) : null}
          <div>
            <span className="text-brand-blue-500 font-semibold">{isError ? "error" : "result"}:</span>{" "}
            <pre className="whitespace-pre-wrap break-all inline">
              {isError ? tool.error : truncate(JSON.stringify(tool.result, null, 2))}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function truncate(s?: string, max = 1500) {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n…";
}

function prettyToolName(name: string): string {
  return name
    .replace(/^(get|search|set|approve|deny|queue|send)_/, (_, v) => v.charAt(0).toUpperCase() + v.slice(1) + " ")
    .replace(/_/g, " ");
}

function ThinkingBubble() {
  return (
    <div className="flex gap-2.5 animate-dirt-fade-in">
      <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-brand-blue-500 to-brand-blue-700 flex items-center justify-center shrink-0 shadow-[0_2px_8px_-2px_rgba(46,91,255,0.4)]">
        <SparkleIcon className="w-4 h-4 text-white" />
      </div>
      <div className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-2xl rounded-tl-md bg-ops-bg border border-ops-border">
        <Dot delay="0s" />
        <Dot delay="0.15s" />
        <Dot delay="0.3s" />
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="w-1.5 h-1.5 rounded-full bg-brand-blue-400 inline-block"
      style={{ animation: `dirt-pulse 1.4s ease-in-out ${delay} infinite` }}
    />
  );
}

function CaretBlink() {
  return <span className="inline-block w-[2px] h-[1em] bg-brand-blue-500 align-text-bottom ml-0.5 animate-dirt-blink" />;
}

function SlashHint({ input, onPick }: { input: string; onPick: (cmd: string) => void }) {
  const all = [
    { cmd: "/clear", desc: "Wipe the conversation" },
    { cmd: "/tools", desc: "List available tools" },
    { cmd: "/read", desc: "Toggle read-only mode" },
  ];
  const matching = all.filter((c) => c.cmd.startsWith(input));
  if (matching.length === 0) return null;
  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 bg-ops-surface border border-ops-border rounded-xl shadow-card-lg p-1.5 z-10">
      {matching.map((c, i) => (
        <button
          key={c.cmd}
          type="button"
          onMouseDown={(e) => {
            // mousedown beats blur so the textarea doesn't lose focus first
            e.preventDefault();
            onPick(c.cmd);
          }}
          className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[12px] text-left transition-colors hover:bg-ops-surface-hover focus:bg-ops-surface-hover focus:outline-none ${i === 0 ? "bg-ops-accent-soft/40" : ""}`}
        >
          <code className="text-brand-blue-500 font-semibold">{c.cmd}</code>
          <span className="text-ops-text-muted text-[11px]">{c.desc}</span>
        </button>
      ))}
      <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] text-ops-text-subtle border-t border-ops-border mt-1">
        Click or press <kbd className="font-mono px-1 py-px rounded bg-ops-bg border border-ops-border">↵</kbd> to run
      </div>
    </div>
  );
}

// ─── History dropdown ───────────────────────────────────────────────

function HistoryDropdown({
  history,
  activeId,
  onPick,
  onDelete,
  onClose,
}: {
  history: ConvoSummary[];
  activeId: string | null;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute top-[68px] inset-x-3 sm:inset-x-auto sm:right-3 z-50 sm:w-[380px] max-h-[480px] overflow-y-auto bg-ops-surface border border-ops-border rounded-xl shadow-card-lg p-1.5 animate-dirt-slide-down">
        <div className="px-2.5 py-2 text-[10px] tracking-[0.14em] uppercase text-ops-text-subtle font-semibold border-b border-ops-border mb-1">
          Recent conversations
        </div>
        {history.length === 0 ? (
          <div className="px-3 py-4 text-xs text-ops-text-muted text-center">
            No saved conversations yet.
          </div>
        ) : (
          history.map((c) => (
            <div
              key={c.id}
              className={`group/h flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${
                activeId === c.id ? "bg-ops-accent-soft" : "hover:bg-ops-surface-hover"
              }`}
              onClick={() => onPick(c.id)}
            >
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-ops-text truncate">
                  {c.title || "(untitled)"}
                </div>
                <div className="text-[10.5px] text-ops-text-subtle mt-0.5 flex items-center gap-2">
                  <span>{c.message_count} msg{c.message_count !== 1 ? "s" : ""}</span>
                  <span>·</span>
                  <span>{relativeTime(c.last_message_at)}</span>
                  {activeId === c.id && (
                    <span className="ml-auto text-brand-blue-500 font-semibold">Active</span>
                  )}
                </div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}
                className="opacity-0 group-hover/h:opacity-100 p-1 rounded text-ops-text-subtle hover:text-red-400 hover:bg-red-500/10 transition-all"
                title="Delete from history"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2" />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ─── Icons ──────────────────────────────────────────────────────────

function SparkleIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 2l1.91 6.09L20 10l-6.09 1.91L12 18l-1.91-6.09L4 10l6.09-1.91L12 2zM19 14l.95 3.05L23 18l-3.05.95L19 22l-.95-3.05L15 18l3.05-.95L19 14zM5 14l.62 1.99L7.61 16.62 5.62 17.24 5 19.23 4.38 17.24 2.39 16.62 4.38 15.99 5 14z" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12l14-7-7 14-2-5-5-2z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="w-2.5 h-2.5 text-brand-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
    </svg>
  );
}

// ─── SSE event handler ─────────────────────────────────────────────

function applySSEEvent(
  msgId: string,
  evt: any,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
) {
  if (evt.type === "text_delta") {
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, content: m.content + evt.text } : m)),
    );
    return;
  }
  if (evt.type === "tool_start") {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? {
              ...m,
              tools: [
                ...m.tools,
                { id: evt.id, name: evt.name, input: evt.input, status: "pending", startedAt: Date.now() },
              ],
            }
          : m,
      ),
    );
    return;
  }
  if (evt.type === "tool_result") {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? {
              ...m,
              tools: m.tools.map((t) =>
                t.id === evt.id ? { ...t, status: "ok", result: evt.result, durationMs: evt.durationMs } : t,
              ),
            }
          : m,
      ),
    );
    return;
  }
  if (evt.type === "tool_error") {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? {
              ...m,
              tools: m.tools.map((t) =>
                t.id === evt.id ? { ...t, status: "error", error: evt.error, durationMs: evt.durationMs } : t,
              ),
            }
          : m,
      ),
    );
    return;
  }
  if (evt.type === "error") {
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, content: m.content + `\n\n**Error:** ${evt.message}` } : m)),
    );
  }
  // 'usage' and 'done' are informational; the stream end already finalizes the message
}

// ─── Voice input (browser Web Speech API) ──────────────────────────

interface VoiceState {
  supported: boolean;
  listening: boolean;
  error: string | null;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

function useVoiceInput({
  onTranscript,
}: {
  onTranscript: (text: string, isFinal: boolean) => void;
}): VoiceState {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<any>(null);

  useEffect(() => {
    const Recognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setSupported(!!Recognition);
  }, []);

  const start = useCallback(() => {
    const Recognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Recognition) {
      setError("not supported in this browser");
      return;
    }
    if (recRef.current) {
      try { recRef.current.stop(); } catch {}
      recRef.current = null;
    }
    const rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";

    let accumulated = "";
    rec.onresult = (e: any) => {
      let interim = "";
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const transcript = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += transcript;
        else interim += transcript;
      }
      if (final) {
        accumulated += final;
        onTranscript(accumulated + interim, false);
      } else {
        onTranscript(accumulated + interim, false);
      }
    };
    rec.onerror = (e: any) => {
      setError(e.error || "mic error");
      setListening(false);
    };
    rec.onend = () => {
      setListening(false);
      onTranscript(accumulated.trim(), true);
      recRef.current = null;
    };
    try {
      rec.start();
      recRef.current = rec;
      setListening(true);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [onTranscript]);

  const stop = useCallback(() => {
    if (recRef.current) {
      try { recRef.current.stop(); } catch {}
    }
    setListening(false);
  }, []);

  const toggle = useCallback(() => {
    if (listening) stop();
    else start();
  }, [listening, start, stop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { if (recRef.current) { try { recRef.current.stop(); } catch {} } };
  }, []);

  return { supported, listening, error, start, stop, toggle };
}

function VoiceButton({ voice, disabled }: { voice: VoiceState; disabled: boolean }) {
  if (!voice.supported) return null;
  return (
    <button
      type="button"
      onClick={voice.toggle}
      disabled={disabled}
      title={voice.listening ? "Stop listening" : "Talk to DIRT"}
      className={`h-[44px] w-[44px] flex items-center justify-center rounded-xl transition-all shrink-0 ${
        voice.listening
          ? "bg-gradient-to-br from-red-500 to-red-600 text-white shadow-[0_4px_14px_-4px_rgba(239,68,68,0.5)] animate-dirt-pulse-mic"
          : "bg-ops-surface border border-ops-border text-ops-text-muted hover:text-ops-text hover:border-brand-blue-400/40"
      } disabled:opacity-30 disabled:cursor-not-allowed`}
    >
      {voice.listening ? (
        // Stop / square icon
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      ) : (
        // Mic icon
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" />
        </svg>
      )}
    </button>
  );
}
