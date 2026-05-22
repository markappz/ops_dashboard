import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";
import { ModalPortal } from "../components/modal-portal";

type EmailStyle = "html" | "branded" | "plain-text";

interface BrandProfile {
  id: string;
  name: string;
  is_default: boolean;
  primary_color: string;
  accent_color: string | null;
  text_color: string;
  bg_color: string;
  page_bg_color: string;
  font_family: string;
  logo_url: string | null;
  logo_width: number;
  footer_text: string | null;
  unsubscribe_text: string;
  brand_voice: string | null;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

interface ParsedEmail {
  subject: string;
  preheader: string;
  changes: string;
  html: string;
  text: string;
}

const STYLE_OPTIONS: { value: EmailStyle; label: string; description: string }[] = [
  { value: "html", label: "HTML", description: "Clean responsive layout — navy band + white card. Fast, deliverable." },
  { value: "branded", label: "Branded", description: "Editorial magazine — hero photo, serif headlines, multi-section." },
  { value: "plain-text", label: "Plain text", description: "Text-only newsletter. No HTML at all." },
];

// Some models override the prompt's light-mode rule and paint the email frame
// near-black (training-data bias toward "dark = premium"). Coerce those back to
// the brand's page background. The white card and logo band stay untouched.
const FORBIDDEN_FRAME_COLORS = [
  "#0a0a0a", "#0A0A0A",
  "#000000", "#000",
  "#111111", "#111",
  "#1a1a1a", "#1A1A1A",
  "#0f0f0f", "#0F0F0F",
  "#0f172a", "#0F172A",
];

function coerceFrameColors(html: string, pageBg: string, accentBand: string): string {
  if (!html) return html;
  let out = html;
  // Replace any forbidden hex when used as a background-color value. Be careful
  // not to touch the navy logo band (which is the profile's accent color, e.g.
  // #0A1628) — accentBand is allowed.
  for (const bad of FORBIDDEN_FRAME_COLORS) {
    if (bad.toLowerCase() === accentBand.toLowerCase()) continue;
    const re = new RegExp(`background-color\\s*:\\s*${bad}\\b`, "gi");
    out = out.replace(re, `background-color: ${pageBg}`);
  }
  return out;
}

// Models occasionally wrap their HTML output in a ```html ... ``` markdown
// fence despite the prompt saying not to. Strip it so the iframe doesn't
// render literal backticks above the doctype.
function stripCodeFence(s: string): string {
  let out = s.trim();
  out = out.replace(/^```(?:html|HTML)?\s*\n?/, "");
  out = out.replace(/\n?```\s*$/, "");
  return out.trim();
}

function parseFinalEmail(raw: string): ParsedEmail {
  const subjectIdx = raw.indexOf("=== SUBJECT ===");
  const preheaderIdx = raw.indexOf("=== PREHEADER ===");
  const changesIdx = raw.indexOf("=== CHANGES ===");
  const htmlIdx = raw.indexOf("=== HTML ===");
  const textIdx = raw.indexOf("=== TEXT ===");
  const bodyIdx = htmlIdx >= 0 ? htmlIdx : textIdx >= 0 ? textIdx : raw.length;

  let subject = "";
  let preheader = "";
  let changes = "";
  let html = "";
  let text = "";

  // Pick the first delimiter that appears AFTER each section header to bound it.
  const nextAfter = (start: number, candidates: number[]): number => {
    const valid = candidates.filter((i) => i > start);
    return valid.length ? Math.min(...valid) : raw.length;
  };

  if (subjectIdx >= 0) {
    const end = nextAfter(subjectIdx, [preheaderIdx, changesIdx, htmlIdx, textIdx]);
    subject = raw.slice(subjectIdx + "=== SUBJECT ===".length, end).trim();
  }
  if (preheaderIdx >= 0) {
    const end = nextAfter(preheaderIdx, [changesIdx, htmlIdx, textIdx]);
    preheader = raw.slice(preheaderIdx + "=== PREHEADER ===".length, end).trim();
  }
  if (changesIdx >= 0) {
    const end = nextAfter(changesIdx, [htmlIdx, textIdx]);
    changes = raw.slice(changesIdx + "=== CHANGES ===".length, end).trim();
  }
  if (htmlIdx >= 0) html = stripCodeFence(raw.slice(htmlIdx + "=== HTML ===".length, textIdx > htmlIdx ? textIdx : raw.length).trim());
  if (textIdx >= 0) text = raw.slice(textIdx + "=== TEXT ===".length).trim();
  void bodyIdx;

  return { subject, preheader, changes, html, text };
}

export default function EmailCompose() {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  const { data: profilesData } = useQuery<{ profiles: BrandProfile[] }>({
    queryKey: ["email-brand-profiles"],
    queryFn: () => fetch("/api/ops/email/brand-profiles").then((r) => r.json()),
  });
  const profiles = profilesData?.profiles || [];
  const defaultProfile = profiles.find((p) => p.is_default) || profiles[0];

  const [profileId, setProfileId] = useState<string>("");
  const [style, setStyle] = useState<EmailStyle>("html");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [profileEditOpen, setProfileEditOpen] = useState<BrandProfile | "new" | null>(null);

  // Save state
  const [templateName, setTemplateName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ templateId: string; klaviyoUrl: string | null } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!profileId && defaultProfile) setProfileId(defaultProfile.id);
  }, [defaultProfile, profileId]);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages]);

  // Pick the most-recent assistant message content as the "final" email candidate
  const lastAssistant = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && !messages[i].streaming) {
        return messages[i].content;
      }
    }
    return "";
  }, [messages]);
  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === profileId) || defaultProfile,
    [profiles, profileId, defaultProfile],
  );

  const parsed = useMemo(() => {
    const p = parseFinalEmail(lastAssistant);
    if (p.html && activeProfile) {
      p.html = coerceFrameColors(
        p.html,
        activeProfile.page_bg_color,
        activeProfile.accent_color || "#0A1628",
      );
    }
    return p;
  }, [lastAssistant, activeProfile]);
  const hasFinal = (parsed.html || parsed.text).length > 0;

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", content: trimmed };
    const asstMsg: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "", streaming: true };
    const nextHistory = [...messages, userMsg];
    setMessages([...nextHistory, asstMsg]);
    setInput("");
    setStreaming(true);
    setSaveMsg(null);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const r = await fetch("/api/ops/email/compose/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileId,
          style,
          messages: nextHistory.map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: controller.signal,
      });
      if (!r.ok || !r.body) {
        const detail = await r.text().catch(() => "");
        throw new Error(detail || `HTTP ${r.status}`);
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(line.slice(6).trim());
            if (evt.type === "text_delta") {
              setMessages((prev) =>
                prev.map((m) => (m.id === asstMsg.id ? { ...m, content: m.content + evt.text } : m)),
              );
            }
          } catch {}
        }
      }
    } catch (e: any) {
      const errText = e?.name === "AbortError" ? "*(canceled)*" : `**Error:** ${e.message}`;
      setMessages((prev) =>
        prev.map((m) => (m.id === asstMsg.id ? { ...m, content: m.content + (m.content ? "\n\n" : "") + errText } : m)),
      );
    } finally {
      setMessages((prev) => prev.map((m) => (m.id === asstMsg.id ? { ...m, streaming: false } : m)));
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const reset = () => {
    abortRef.current?.abort();
    setMessages([]);
    setInput("");
    setSaveMsg(null);
  };

  const saveToKlaviyo = async () => {
    if (!templateName.trim()) {
      setSaveMsg("Template name required");
      return;
    }
    setSaving(true);
    setSaveMsg(null);
    setSaved(null);
    try {
      const r = await fetch("/api/ops/email/compose/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: templateName.trim(),
          subject: parsed.subject,
          preheader: parsed.preheader,
          html: parsed.html || undefined,
          text: parsed.text || undefined,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setSaveMsg(`Failed: ${j.error || "unknown"}`);
      } else {
        setSaveMsg(null);
        setSaved({ templateId: j.templateId, klaviyoUrl: j.klaviyoUrl ?? null });
      }
    } catch (e: any) {
      setSaveMsg(`Failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const continueToSend = () => {
    if (!saved) return;
    const qs = new URLSearchParams({
      templateId: saved.templateId,
      name: templateName.trim(),
      subject: parsed.subject || "",
      preheader: parsed.preheader || "",
    });
    navigate(`/email/send?${qs.toString()}`);
  };

  const SUGGESTED = [
    "Win-back campaign for users who haven't logged in for 30+ days. One CTA: open dashboard.",
    "Welcome email for new signups — explain how to upload their first lab report.",
    "Product announcement: launching personalized supplement stacks.",
    "Monthly newsletter — biomarker tip of the month + recap of recent product changes.",
  ];

  return (
    <div>
      <PageHero
        eyebrow="Growth"
        title="Compose with Claude"
        subtitle="Chat with Claude to write branded HTML or plain-text emails. Profile + style apply to every turn."
        actions={
          <button
            onClick={() => navigate("/email")}
            className="text-xs text-ops-text-muted hover:text-ops-text px-3 py-1.5 rounded-lg border border-ops-border hover:bg-ops-surface-hover"
          >
            ← Back to Email
          </button>
        }
      />

      {/* Profile + Style controls */}
      <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card p-4 sm:p-5 mb-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-[11px] font-semibold text-ops-text-muted uppercase tracking-wider mb-1.5">
              Brand profile
            </label>
            <div className="flex gap-2">
              <select
                value={profileId}
                onChange={(e) => setProfileId(e.target.value)}
                className="flex-1 bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.is_default ? " (default)" : ""}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  const active = profiles.find((p) => p.id === profileId);
                  if (active) setProfileEditOpen(active);
                }}
                className="text-xs font-medium px-3 py-2 rounded-lg bg-ops-bg border border-ops-border text-ops-text-muted hover:text-ops-text"
              >
                Edit
              </button>
              <button
                onClick={() => setProfileEditOpen("new")}
                className="text-xs font-semibold px-3 py-2 rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white hover:opacity-95"
              >
                + New
              </button>
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-ops-text-muted uppercase tracking-wider mb-1.5">
              Style
            </label>
            <div className="flex gap-1 bg-ops-bg border border-ops-border rounded-lg p-1">
              {STYLE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setStyle(opt.value)}
                  title={opt.description}
                  className={`flex-1 px-3 py-1.5 text-[12px] font-medium rounded-md transition-colors ${
                    style === opt.value
                      ? "bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white shadow-[0_2px_8px_-2px_rgba(46,91,255,0.4)]"
                      : "text-ops-text-muted hover:text-ops-text"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Chat + Preview — both panels height-bounded so the page doesn't
          grow infinitely as Claude streams long HTML output */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-5 mb-5 h-[calc(100vh-340px)] min-h-[520px]">
        {/* Chat panel */}
        <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-ops-border flex items-center justify-between shrink-0">
            <h3 className="text-sm font-semibold text-ops-text">Chat with Claude</h3>
            {messages.length > 0 && (
              <button
                onClick={reset}
                className="text-[11px] text-ops-text-muted hover:text-ops-text px-2 py-1 rounded hover:bg-ops-surface-hover"
              >
                New thread
              </button>
            )}
          </div>
          <div ref={chatRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-0">
            {messages.length === 0 && (
              <div>
                <div className="text-sm text-ops-text-muted mb-3">
                  Tell Claude what email you need. Refine in follow-up messages — Claude remembers context.
                </div>
                <div className="space-y-1.5">
                  {SUGGESTED.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="w-full text-left px-3 py-2.5 rounded-lg border border-ops-border bg-ops-bg hover:bg-ops-surface-hover hover:border-brand-blue-500/40 text-xs text-ops-text-muted hover:text-ops-text transition-all"
                    >
                      › {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="flex justify-end animate-dirt-fade-in">
                  <div className="max-w-[88%] px-3 py-2 rounded-2xl rounded-br-md bg-gradient-to-br from-brand-blue-600 to-brand-blue-500 text-white text-sm break-words">
                    {m.content}
                  </div>
                </div>
              ) : (
                <AssistantTurn key={m.id} message={m} />
              ),
            )}
          </div>
          <form
            onSubmit={(e) => { e.preventDefault(); send(input); }}
            className="border-t border-ops-border p-3 flex gap-2 shrink-0"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); }
              }}
              rows={1}
              placeholder={streaming ? "Claude is writing…" : "Describe the email or refine the last draft…"}
              disabled={streaming}
              className="flex-1 resize-none bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text placeholder-ops-text-subtle focus:outline-none focus:border-brand-blue-500 max-h-32"
              style={{ minHeight: "42px" }}
            />
            {streaming ? (
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="h-[42px] px-4 rounded-lg bg-ops-surface border border-ops-border text-ops-text text-sm hover:bg-ops-surface-hover"
              >
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="h-[42px] px-4 rounded-lg bg-gradient-to-br from-brand-blue-600 to-brand-blue-500 text-white text-sm font-semibold disabled:opacity-30 hover:opacity-95"
              >
                Send
              </button>
            )}
          </form>
        </div>

        {/* Live preview — iframe fills the remaining flex height with internal scroll */}
        <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-ops-border flex items-center justify-between shrink-0">
            <h3 className="text-sm font-semibold text-ops-text">Live preview</h3>
            {hasFinal && (
              <span className="text-[10px] text-ops-text-subtle">
                {parsed.html ? `${parsed.html.length.toLocaleString()} chars HTML` : `${parsed.text.length.toLocaleString()} chars text`}
              </span>
            )}
          </div>
          <div className="flex-1 bg-white relative min-h-0">
            {!hasFinal ? (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-ops-text-muted p-6 text-center">
                Preview will appear here once Claude returns a complete email.
              </div>
            ) : parsed.html ? (
              <iframe
                srcDoc={parsed.html}
                title="Email preview"
                className="absolute inset-0 w-full h-full border-0 bg-white"
                sandbox="allow-same-origin"
              />
            ) : (
              <pre className="absolute inset-0 w-full h-full p-6 text-sm text-gray-800 bg-white font-mono whitespace-pre-wrap overflow-y-auto">
                {parsed.text}
              </pre>
            )}
          </div>
        </div>
      </div>

      {/* Save to Klaviyo */}
      {hasFinal && (
        <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card p-4 sm:p-5">
          {!saved ? (
            <>
              <h3 className="text-sm font-semibold text-ops-text mb-3">Save to Klaviyo</h3>
              {parsed.subject && (
                <div className="mb-3">
                  <div className="text-[11px] font-semibold text-ops-text-muted uppercase tracking-wider mb-1">Subject</div>
                  <div className="text-sm text-ops-text bg-ops-bg border border-ops-border rounded-lg px-3 py-2">
                    {parsed.subject}
                  </div>
                </div>
              )}
              <div className="flex flex-col sm:flex-row gap-3">
                <input
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="Template name (e.g. Win-back · Lapsed 30d)"
                  className="flex-1 bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
                />
                <button
                  onClick={saveToKlaviyo}
                  disabled={saving || !templateName.trim()}
                  className="px-5 py-2 text-sm font-semibold rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white shadow-[0_4px_14px_-4px_rgba(46,91,255,0.5)] disabled:opacity-40 hover:opacity-95"
                >
                  {saving ? "Saving…" : "Save to Klaviyo"}
                </button>
              </div>
              {saveMsg && (
                <div className="mt-3 px-3 py-2 rounded-lg text-xs bg-red-500/10 text-red-400 border border-red-500/30">
                  {saveMsg}
                </div>
              )}
            </>
          ) : (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <div className="w-7 h-7 rounded-full bg-brand-blue-500/15 border border-brand-blue-400/40 flex items-center justify-center">
                  <svg className="w-4 h-4 text-brand-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                </div>
                <div>
                  <div className="text-sm font-semibold text-ops-text">Saved to Klaviyo</div>
                  <div className="text-[11px] text-ops-text-muted">Template <span className="font-mono">{saved.templateId}</span> · "{templateName}"</div>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                <button
                  onClick={continueToSend}
                  className="px-5 py-2.5 text-sm font-semibold rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white shadow-[0_4px_14px_-4px_rgba(46,91,255,0.5)] hover:opacity-95 inline-flex items-center gap-1.5"
                >
                  Continue to schedule send
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
                </button>
                {saved.klaviyoUrl && (
                  <a
                    href={saved.klaviyoUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="px-4 py-2.5 text-xs font-medium rounded-lg bg-ops-bg border border-ops-border text-ops-text-muted hover:text-ops-text hover:bg-ops-surface-hover inline-flex items-center gap-1.5"
                  >
                    Open in Klaviyo
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                  </a>
                )}
                <button
                  onClick={() => { setSaved(null); setTemplateName(""); }}
                  className="px-3 py-2.5 text-xs text-ops-text-muted hover:text-ops-text"
                >
                  Save another
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Profile management modal */}
      {profileEditOpen && (
        <BrandProfileEditModal
          profile={profileEditOpen === "new" ? null : profileEditOpen}
          onClose={() => setProfileEditOpen(null)}
          onSaved={(saved) => {
            queryClient.invalidateQueries({ queryKey: ["email-brand-profiles"] });
            if (saved) setProfileId(saved.id);
            setProfileEditOpen(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Profile edit modal ────────────────────────────────────────────

function BrandProfileEditModal({
  profile,
  onClose,
  onSaved,
}: {
  profile: BrandProfile | null;
  onClose: () => void;
  onSaved: (saved: BrandProfile | null) => void;
}) {
  const isNew = profile === null;
  const [name, setName] = useState(profile?.name || "");
  const [primaryColor, setPrimaryColor] = useState(profile?.primary_color || "#2E5BFF");
  const [accentColor, setAccentColor] = useState(profile?.accent_color || "#0A1628");
  const [textColor, setTextColor] = useState(profile?.text_color || "#0A1628");
  const [bgColor, setBgColor] = useState(profile?.bg_color || "#FFFFFF");
  const [pageBgColor, setPageBgColor] = useState(profile?.page_bg_color || "#F2F6FC");
  const [fontFamily, setFontFamily] = useState(profile?.font_family || '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif');
  const [logoUrl, setLogoUrl] = useState(profile?.logo_url || "");
  const [logoWidth, setLogoWidth] = useState(profile?.logo_width || 160);
  const [footerText, setFooterText] = useState(profile?.footer_text || "");
  const [brandVoice, setBrandVoice] = useState(profile?.brand_voice || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = {
        name,
        primary_color: primaryColor,
        accent_color: accentColor,
        text_color: textColor,
        bg_color: bgColor,
        page_bg_color: pageBgColor,
        font_family: fontFamily,
        logo_url: logoUrl || null,
        logo_width: logoWidth,
        footer_text: footerText || null,
        brand_voice: brandVoice || null,
      };
      const url = isNew
        ? "/api/ops/email/brand-profiles"
        : `/api/ops/email/brand-profiles/${profile.id}`;
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
      onSaved(j.profile || null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (!profile || profile.is_default) return;
    if (!confirm(`Delete "${profile.name}" profile?`)) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/ops/email/brand-profiles/${profile.id}`, { method: "DELETE" });
      if (r.ok) onSaved(null);
      else {
        const j = await r.json().catch(() => ({}));
        setError(j.error || `HTTP ${r.status}`);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalPortal onClose={onClose}>
      <div
        className="bg-ops-surface border border-ops-border rounded-xl p-4 sm:p-6 w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-y-auto shadow-2xl my-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between mb-1">
          <h3 className="text-base font-bold text-ops-text">{isNew ? "New brand profile" : `Edit "${profile.name}"`}</h3>
          <button onClick={onClose} className="text-ops-text-muted hover:text-ops-text text-xl leading-none">×</button>
        </div>
        <p className="text-xs text-ops-text-muted mb-5">
          Colors, fonts, logo, and voice that Claude will use for every email composed under this profile.
        </p>

        <div className="space-y-4">
          <Field label="Profile name" value={name} onChange={setName} placeholder="e.g. FitScript, Real Peptides" />

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <ColorField label="Primary (CTA)" value={primaryColor} onChange={setPrimaryColor} />
            <ColorField label="Accent / dark" value={accentColor} onChange={setAccentColor} />
            <ColorField label="Body text" value={textColor} onChange={setTextColor} />
            <ColorField label="Card bg" value={bgColor} onChange={setBgColor} />
            <ColorField label="Page bg" value={pageBgColor} onChange={setPageBgColor} />
          </div>

          <Field label="Font stack" value={fontFamily} onChange={setFontFamily} placeholder='-apple-system, "Segoe UI", Helvetica, Arial, sans-serif' />
          <Field label="Logo URL" value={logoUrl} onChange={setLogoUrl} placeholder="https://yoursite.com/logo.png" />
          <Field label="Logo width (px)" value={String(logoWidth)} onChange={(v) => setLogoWidth(parseInt(v) || 160)} placeholder="160" />
          <Field label="Footer text" value={footerText} onChange={setFooterText} placeholder="FitScript · Optimize what your biology can do." />
          <Field label="Brand voice" value={brandVoice} onChange={setBrandVoice} placeholder="Direct, warm, science-grounded…" multiline />
        </div>

        {error && (
          <div className="mt-4 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-400">
            {error}
          </div>
        )}

        <div className="flex flex-col sm:flex-row justify-between gap-3 mt-6">
          <div>
            {!isNew && profile && !profile.is_default && (
              <button onClick={del} disabled={saving} className="px-3 py-2 text-xs rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20">
                Delete
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-ops-text-muted hover:text-ops-text">
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving || !name.trim()}
              className="px-5 py-2 text-sm font-semibold rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white shadow-[0_4px_14px_-4px_rgba(46,91,255,0.5)] disabled:opacity-40 hover:opacity-95"
            >
              {saving ? "Saving…" : isNew ? "Create profile" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

function AssistantTurn({ message }: { message: ChatMessage }) {
  const [showRaw, setShowRaw] = useState(false);
  const parsed = useMemo(() => parseFinalEmail(message.content), [message.content]);
  const hasParsed = (parsed.html || parsed.text).length > 100;
  const isStreaming = !!message.streaming;
  const charCount = message.content.length;

  return (
    <div className="animate-dirt-fade-in">
      <div className="text-[10px] text-ops-text-subtle uppercase tracking-wider mb-1.5">Claude</div>
      {isStreaming && !hasParsed ? (
        <div className="text-sm text-ops-text-muted bg-ops-bg border border-ops-border rounded-lg p-3 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-brand-blue-400 animate-pulse" />
          Writing… {charCount > 0 && <span className="text-[10px] text-ops-text-subtle">{charCount.toLocaleString()} chars so far</span>}
        </div>
      ) : hasParsed ? (
        <div className="bg-ops-bg border border-ops-border rounded-lg p-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <svg className="w-3.5 h-3.5 text-brand-blue-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
            <span className="text-xs font-semibold text-ops-text">Email drafted</span>
            {isStreaming && <span className="text-[10px] text-ops-text-subtle">streaming…</span>}
          </div>
          {parsed.subject && (
            <div className="text-[12px] text-ops-text"><span className="text-ops-text-subtle">Subject: </span>{parsed.subject}</div>
          )}
          {parsed.preheader && (
            <div className="text-[11px] text-ops-text-muted"><span className="text-ops-text-subtle">Preheader: </span>{parsed.preheader}</div>
          )}
          {parsed.changes && <ChangesBlock changes={parsed.changes} />}
          <div className="flex items-center gap-3 pt-1">
            <span className="text-[10px] text-ops-text-subtle">
              {parsed.html ? `${parsed.html.length.toLocaleString()} chars HTML` : `${parsed.text.length.toLocaleString()} chars text`}
            </span>
            <button
              onClick={() => setShowRaw((v) => !v)}
              className="text-[10px] text-brand-blue-500 hover:text-brand-blue-600 font-semibold"
            >
              {showRaw ? "Hide raw" : "Show raw"}
            </button>
          </div>
          {showRaw && (
            <pre className="mt-2 text-[10px] font-mono text-ops-text-muted bg-ops-surface border border-ops-border rounded-md p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
              {message.content}
            </pre>
          )}
        </div>
      ) : (
        // No parseable email yet — Claude's response is either chat-style
        // (e.g. asking clarifying question) or hasn't finished a section header
        <div className="text-sm text-ops-text bg-ops-bg border border-ops-border rounded-lg p-3 whitespace-pre-wrap break-words">
          {message.content}
          {isStreaming && <span className="inline-block w-[2px] h-[1em] bg-brand-blue-500 align-text-bottom ml-0.5 animate-dirt-blink" />}
        </div>
      )}
    </div>
  );
}

function ChangesBlock({ changes }: { changes: string }) {
  const lines = useMemo(() => {
    return changes
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^[-*•]\s*/, ""));
  }, [changes]);

  if (lines.length === 0) return null;

  const isInitial = lines.length === 1 && /^initial draft\.?$/i.test(lines[0]);

  return (
    <div className="mt-1.5 pt-1.5 border-t border-ops-border/60">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ops-text-subtle mb-1">
        {isInitial ? "Status" : "What changed"}
      </div>
      {isInitial ? (
        <div className="text-[11px] text-ops-text-muted">Initial draft.</div>
      ) : (
        <ul className="space-y-0.5">
          {lines.map((line, i) => (
            <li key={i} className="text-[11px] text-ops-text-muted leading-snug flex gap-1.5">
              <span className="text-brand-blue-500 shrink-0">›</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Field({
  label, value, onChange, placeholder, multiline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <div>
      <label className="block text-[11px] font-semibold text-ops-text-muted uppercase tracking-wider mb-1.5">{label}</label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={2}
          className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
        />
      )}
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-[10px] font-semibold text-ops-text-muted uppercase tracking-wider mb-1">{label}</label>
      <div className="flex items-center gap-2 bg-ops-bg border border-ops-border rounded-lg px-2 py-1.5">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-8 h-8 rounded cursor-pointer border-0 p-0 bg-transparent"
          style={{ minHeight: "32px" }}
        />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#2E5BFF"
          className="flex-1 bg-transparent text-xs font-mono text-ops-text focus:outline-none"
        />
      </div>
    </div>
  );
}
