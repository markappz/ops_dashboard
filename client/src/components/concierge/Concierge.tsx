import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Ops Concierge — floating brand-gradient launcher (bottom-right) +
 * right-side slide-out panel + ⌘K keyboard shortcut. All three surfaces
 * open the same conversational pane.
 *
 * Phase 1: read-only. Powered by /api/ops/concierge/chat which runs Claude
 * (Bedrock) with tool-use over every primary ops data source.
 */

type Role = "user" | "assistant";

interface ToolUse {
  name: string;
  input: unknown;
  result?: unknown;
  error?: string;
  durationMs: number;
}

interface Message {
  role: Role;
  content: string;
  toolUses?: ToolUse[];
}

interface ChatResp {
  response: string;
  toolUses: ToolUse[];
  usage: { inputTokens: number; outputTokens: number };
}

const SUGGESTED_PROMPTS = [
  "What's MRR right now?",
  "Are any integrations broken?",
  "Who's costing the most in AI this month?",
  "Show me orders waiting to ship",
  "What content is pending approval?",
];

export function Concierge() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ⌘K / Ctrl+K toggles the panel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Focus input when panel opens
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const chat = useMutation<ChatResp, Error, Message[]>({
    mutationFn: async (history) => {
      const r = await fetch("/api/ops/concierge/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`HTTP ${r.status}: ${text}`);
      }
      return r.json();
    },
    onSuccess: (data) => {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.response, toolUses: data.toolUses },
      ]);
    },
    onError: (e) => {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `**Error:** ${e.message}` },
      ]);
    },
  });

  const sending = chat.isPending;

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    const next: Message[] = [...messages, { role: "user", content: trimmed }];
    setMessages(next);
    setInput("");
    chat.mutate(next);
  };

  const reset = () => {
    if (sending) return;
    setMessages([]);
    setInput("");
  };

  return (
    <>
      {/* Floating launcher (always visible) */}
      <button
        onClick={() => setOpen(true)}
        title="Ask the Concierge — ⌘K"
        aria-label="Open Ops Concierge"
        className={`fixed bottom-6 right-6 z-40 transition-all duration-200 ${
          open ? "scale-0 opacity-0 pointer-events-none" : "scale-100 opacity-100"
        }`}
      >
        <div className="relative group">
          <div className="absolute -inset-1 bg-gradient-to-r from-brand-blue-600 to-brand-blue-400 rounded-full opacity-50 blur-md group-hover:opacity-75 transition" />
          <div className="relative flex items-center gap-2 px-4 h-12 rounded-full bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white shadow-[0_10px_30px_-6px_rgba(46,91,255,0.55)] hover:shadow-[0_14px_36px_-8px_rgba(46,91,255,0.7)] transition-shadow">
            <SparkleIcon />
            <span className="text-sm font-semibold tracking-tight">Concierge</span>
            <span className="hidden md:inline text-[10px] font-medium opacity-80 px-1.5 py-0.5 rounded bg-white/15 ml-1">⌘K</span>
          </div>
        </div>
      </button>

      {/* Slide-out panel */}
      <div
        className={`fixed inset-0 z-50 transition-opacity ${
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      >
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-black/30 backdrop-blur-[2px]"
          onClick={() => setOpen(false)}
        />

        {/* Panel */}
        <div
          className={`absolute top-0 right-0 h-full w-full sm:w-[480px] bg-ops-surface border-l border-ops-border shadow-2xl flex flex-col transition-transform duration-200 ${
            open ? "translate-x-0" : "translate-x-full"
          }`}
        >
          {/* Header */}
          <div className="relative h-16 px-5 border-b border-ops-border flex items-center justify-between bg-ops-surface overflow-hidden">
            <div
              aria-hidden
              className="absolute inset-0 pointer-events-none opacity-90"
              style={{
                backgroundImage:
                  "radial-gradient(500px 200px at 0% 0%, rgb(var(--ops-accent) / 0.12), transparent 60%)",
              }}
            />
            <div className="relative flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-blue-500 to-brand-blue-600 flex items-center justify-center shadow-[0_4px_12px_-4px_rgba(46,91,255,0.5)]">
                <SparkleIcon />
              </div>
              <div>
                <div className="text-sm font-bold text-ops-text leading-none">Ops Concierge</div>
                <div className="text-[10px] text-ops-text-muted mt-0.5">Ask anything · ⌘K to toggle</div>
              </div>
            </div>
            <div className="relative flex items-center gap-1">
              {messages.length > 0 && (
                <button
                  onClick={reset}
                  className="text-[11px] text-ops-text-muted hover:text-ops-text px-2 py-1 rounded hover:bg-ops-surface-hover transition-colors"
                  title="Clear conversation"
                >
                  Reset
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                className="p-1.5 rounded-lg text-ops-text-muted hover:text-ops-text hover:bg-ops-surface-hover transition-colors"
                title="Close (Esc)"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            {messages.length === 0 && !sending && (
              <EmptyState onPick={send} />
            )}

            {messages.map((m, i) => (
              <MessageBubble key={i} message={m} />
            ))}

            {sending && <ThinkingBubble />}
          </div>

          {/* Composer */}
          <div className="border-t border-ops-border p-3 bg-ops-surface">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
              className="flex items-end gap-2"
            >
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
                placeholder="Ask the Concierge…"
                className="flex-1 resize-none bg-ops-bg border border-ops-border rounded-lg px-3 py-2.5 text-sm text-ops-text placeholder-ops-text-subtle focus:outline-none focus:border-brand-blue-500 focus:ring-2 focus:ring-brand-blue-500/20 max-h-32"
                style={{
                  minHeight: "42px",
                  height: input ? "auto" : "42px",
                }}
              />
              <button
                type="submit"
                disabled={!input.trim() || sending}
                className="h-[42px] px-4 rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-95 transition-all shadow-[0_4px_14px_-4px_rgba(46,91,255,0.5)]"
              >
                {sending ? (
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 2a10 10 0 0110 10" />
                  </svg>
                ) : (
                  <SendIcon />
                )}
              </button>
            </form>
            <div className="text-[10px] text-ops-text-subtle mt-1.5 px-1">
              Read-only • cost logged as <code>ops_concierge</code> • write actions coming in Phase 2
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
    <div className="py-6">
      <div className="text-sm text-ops-text font-medium mb-1">What can I help you with?</div>
      <div className="text-xs text-ops-text-muted mb-5">
        I have read access to members, orders, marketing, content, email, and integrations. Try one of these:
      </div>
      <div className="space-y-1.5">
        {SUGGESTED_PROMPTS.map((q) => (
          <button
            key={q}
            onClick={() => onPick(q)}
            className="w-full text-left px-3 py-2.5 rounded-lg border border-ops-border bg-ops-bg hover:bg-ops-surface-hover hover:border-brand-blue-500/40 text-sm text-ops-text-muted hover:text-ops-text transition-all group"
          >
            <span className="text-brand-blue-500 mr-2 opacity-70 group-hover:opacity-100">›</span>
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] px-3.5 py-2 rounded-2xl rounded-br-md bg-gradient-to-br from-brand-blue-600 to-brand-blue-500 text-white text-sm shadow-[0_4px_14px_-4px_rgba(46,91,255,0.4)]">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-2.5">
      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-brand-blue-500 to-brand-blue-600 flex items-center justify-center shrink-0 mt-0.5 shadow-[0_2px_8px_-2px_rgba(46,91,255,0.4)]">
        <SparkleIcon className="w-3.5 h-3.5" />
      </div>
      <div className="flex-1 min-w-0 space-y-2">
        {message.toolUses && message.toolUses.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {message.toolUses.map((t, i) => (
              <ToolChip key={i} tool={t} />
            ))}
          </div>
        )}
        <div className="text-sm text-ops-text prose-concierge">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

function ToolChip({ tool }: { tool: ToolUse }) {
  const [open, setOpen] = useState(false);
  const hasError = !!tool.error;
  return (
    <div className="w-full">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium border transition-colors ${
          hasError
            ? "bg-red-500/10 border-red-500/30 text-red-400"
            : "bg-ops-accent-soft border-brand-blue-400/30 text-brand-blue-500 hover:border-brand-blue-400/60"
        }`}
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" /></svg>
        {tool.name}
        <span className="opacity-60">{tool.durationMs}ms</span>
        <svg className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </button>
      {open && (
        <div className="mt-1.5 p-2 rounded-lg bg-ops-bg border border-ops-border text-[10px] font-mono text-ops-text-muted max-h-48 overflow-auto">
          <div className="mb-1.5">
            <span className="text-brand-blue-500">input:</span> {JSON.stringify(tool.input)}
          </div>
          <div>
            <span className="text-brand-blue-500">{hasError ? "error" : "result"}:</span>{" "}
            <pre className="whitespace-pre-wrap break-all inline">
              {hasError ? tool.error : JSON.stringify(tool.result, null, 2)?.slice(0, 1200)}
              {!hasError && JSON.stringify(tool.result, null, 2)?.length > 1200 ? "…" : ""}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div className="flex gap-2.5">
      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-brand-blue-500 to-brand-blue-600 flex items-center justify-center shrink-0 shadow-[0_2px_8px_-2px_rgba(46,91,255,0.4)]">
        <SparkleIcon className="w-3.5 h-3.5" />
      </div>
      <div className="flex items-center gap-1.5 px-3 py-2.5 rounded-2xl rounded-tl-md bg-ops-bg border border-ops-border">
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
      style={{ animation: `pulse 1.4s ease-in-out ${delay} infinite` }}
    />
  );
}

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
