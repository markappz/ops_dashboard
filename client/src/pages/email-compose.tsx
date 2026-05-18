import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";

type Section = "subject" | "preheader" | "html";

interface Parsed {
  subject: string;
  preheader: string;
  html: string;
}

const DEFAULT_GOAL_PLACEHOLDER = `Win-back campaign for users who haven't logged into FitScript in 30+ days. Lead with a free protocol refresh (no card required) and one specific biomarker insight from their last lab. Single CTA: open dashboard.`;
const DEFAULT_AUDIENCE_PLACEHOLDER = `Lapsed users (last_active_date > 30 days ago) with at least one lab uploaded.`;
const DEFAULT_VOICE_PLACEHOLDER = `Direct, science-grounded, warm. No marketing-speak. Reads like a smart founder writing to their list.`;

function parseStream(raw: string): Parsed {
  const subjectIdx = raw.indexOf("=== SUBJECT ===");
  const preheaderIdx = raw.indexOf("=== PREHEADER ===");
  const htmlIdx = raw.indexOf("=== HTML ===");

  let subject = "";
  let preheader = "";
  let html = "";

  if (subjectIdx >= 0) {
    const end = preheaderIdx >= 0 ? preheaderIdx : htmlIdx >= 0 ? htmlIdx : raw.length;
    subject = raw.slice(subjectIdx + "=== SUBJECT ===".length, end).trim();
  }
  if (preheaderIdx >= 0) {
    const end = htmlIdx >= 0 ? htmlIdx : raw.length;
    preheader = raw.slice(preheaderIdx + "=== PREHEADER ===".length, end).trim();
  }
  if (htmlIdx >= 0) {
    html = raw.slice(htmlIdx + "=== HTML ===".length).trim();
  }
  return { subject, preheader, html };
}

export default function EmailCompose() {
  const [, navigate] = useLocation();

  // Form
  const [goal, setGoal] = useState("");
  const [audience, setAudience] = useState("");
  const [brandVoice, setBrandVoice] = useState("");
  const [references, setReferences] = useState("");
  const [ctaUrl, setCtaUrl] = useState("https://fitscript.me");
  const [modelChoice, setModelChoice] = useState<"smart" | "fast">("smart");

  // Stream state
  const [streaming, setStreaming] = useState(false);
  const [raw, setRaw] = useState("");
  const [usage, setUsage] = useState<{
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Edits (override after parse)
  const [editedSubject, setEditedSubject] = useState<string | null>(null);
  const [editedPreheader, setEditedPreheader] = useState<string | null>(null);
  const [editedHtml, setEditedHtml] = useState<string | null>(null);

  // Save state
  const [templateName, setTemplateName] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedTemplate, setSavedTemplate] = useState<{ id: string; name: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const parsed = useMemo(() => parseStream(raw), [raw]);
  const finalSubject = editedSubject !== null ? editedSubject : parsed.subject;
  const finalPreheader = editedPreheader !== null ? editedPreheader : parsed.preheader;
  const finalHtml = editedHtml !== null ? editedHtml : parsed.html;
  const hasGenerated = parsed.html.length > 0;

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const handleGenerate = async () => {
    if (goal.trim().length < 5) {
      setError("Goal must be at least 5 chars");
      return;
    }
    setError(null);
    setRaw("");
    setUsage(null);
    setEditedSubject(null);
    setEditedPreheader(null);
    setEditedHtml(null);
    setSavedTemplate(null);
    setSaveError(null);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/ops/email/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal,
          audience: audience || undefined,
          brandVoice: brandVoice || undefined,
          references: references || undefined,
          ctaUrl: ctaUrl || undefined,
          model: modelChoice === "fast" ? "fast" : undefined,
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }

      // Parse SSE manually so we can render progressive deltas.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE events separated by \n\n
        let sep;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const lines = frame.split("\n");
          let eventName = "message";
          let dataPayload = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) eventName = line.slice(7).trim();
            else if (line.startsWith("data: ")) dataPayload += line.slice(6);
          }
          if (!dataPayload) continue;
          try {
            const data = JSON.parse(dataPayload);
            if (eventName === "delta") {
              setRaw((prev) => prev + (data.text || ""));
            } else if (eventName === "done") {
              setUsage({
                inputTokens: data.inputTokens || 0,
                outputTokens: data.outputTokens || 0,
                latencyMs: data.latencyMs || 0,
              });
            } else if (eventName === "error") {
              setError(data.message || "stream error");
            }
          } catch {
            // ignore parse errors mid-stream
          }
        }
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        setError(e?.message || "compose failed");
      }
    } finally {
      setStreaming(false);
    }
  };

  const handleSave = async () => {
    const name = templateName.trim() || (finalSubject ? `${finalSubject.slice(0, 60)}` : "Untitled");
    if (!finalHtml || finalHtml.length < 100) {
      setSaveError("HTML too short to save");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/ops/email/compose/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          html: finalHtml,
          subject: finalSubject,
          preheader: finalPreheader,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || body.detail?.errors?.[0]?.detail || `HTTP ${res.status}`);
      setSavedTemplate({ id: body.templateId, name: body.name });
    } catch (e: any) {
      setSaveError(e?.message || "save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleSendNow = () => {
    if (!savedTemplate) return;
    navigate(`/email/send?templateId=${savedTemplate.id}`);
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-ops-text">Compose with Claude</h1>
          <p className="text-sm text-ops-text-muted mt-1">
            Generate a mobile-responsive HTML email, save it as a Klaviyo template, then send.
          </p>
        </div>
        <button
          onClick={() => navigate("/email")}
          className="text-sm text-ops-text-muted hover:text-ops-text"
        >
          ← Back to Email
        </button>
      </div>

      <div className="grid grid-cols-12 gap-5">
        {/* LEFT — Brief */}
        <div className="col-span-5 space-y-4">
          <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card space-y-4">
            <div>
              <label className="block text-xs font-medium text-ops-text-muted uppercase tracking-wider mb-1.5">
                Campaign Goal *
              </label>
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder={DEFAULT_GOAL_PLACEHOLDER}
                rows={4}
                className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text placeholder:text-ops-text-muted/50 focus:outline-none focus:border-fitscript-green"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ops-text-muted uppercase tracking-wider mb-1.5">
                Audience
              </label>
              <textarea
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                placeholder={DEFAULT_AUDIENCE_PLACEHOLDER}
                rows={2}
                className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text placeholder:text-ops-text-muted/50 focus:outline-none focus:border-fitscript-green"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ops-text-muted uppercase tracking-wider mb-1.5">
                Brand Voice
              </label>
              <textarea
                value={brandVoice}
                onChange={(e) => setBrandVoice(e.target.value)}
                placeholder={DEFAULT_VOICE_PLACEHOLDER}
                rows={2}
                className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text placeholder:text-ops-text-muted/50 focus:outline-none focus:border-fitscript-green"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ops-text-muted uppercase tracking-wider mb-1.5">
                References (URLs, past copy, etc.)
              </label>
              <textarea
                value={references}
                onChange={(e) => setReferences(e.target.value)}
                rows={2}
                className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-ops-text-muted uppercase tracking-wider mb-1.5">
                  Primary CTA URL
                </label>
                <input
                  value={ctaUrl}
                  onChange={(e) => setCtaUrl(e.target.value)}
                  className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ops-text-muted uppercase tracking-wider mb-1.5">
                  Model
                </label>
                <select
                  value={modelChoice}
                  onChange={(e) => setModelChoice(e.target.value as "smart" | "fast")}
                  className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
                >
                  <option value="smart">Sonnet (better design)</option>
                  <option value="fast">Haiku (faster, cheaper)</option>
                </select>
              </div>
            </div>

            <button
              onClick={handleGenerate}
              disabled={streaming || goal.trim().length < 5}
              className="w-full py-2.5 rounded-lg bg-fitscript-green text-white font-medium text-sm hover:bg-fitscript-green/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title={goal.trim().length < 5 ? "Enter a campaign goal (min 5 chars) to enable" : ""}
            >
              {streaming
                ? "Composing…"
                : goal.trim().length < 5
                ? `Add a goal to enable (${goal.trim().length}/5)`
                : hasGenerated
                ? "Regenerate"
                : "Compose Email"}
            </button>

            {error && (
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
                {error}
              </div>
            )}
            {usage && (
              <div className="text-[10px] text-ops-text-muted flex gap-3">
                <span>{usage.inputTokens.toLocaleString()} in / {usage.outputTokens.toLocaleString()} out</span>
                <span>•</span>
                <span>{(usage.latencyMs / 1000).toFixed(1)}s</span>
                <span>•</span>
                <span>Logged to ai_costs as ops_email_compose</span>
              </div>
            )}
          </div>

          {/* Subject + preheader edits */}
          {hasGenerated && (
            <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card space-y-3">
              <div>
                <label className="block text-xs font-medium text-ops-text-muted uppercase tracking-wider mb-1.5">
                  Subject
                </label>
                <input
                  value={finalSubject}
                  onChange={(e) => setEditedSubject(e.target.value)}
                  className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
                />
                <div className="text-[10px] text-ops-text-muted mt-1">{finalSubject.length} chars</div>
              </div>
              <div>
                <label className="block text-xs font-medium text-ops-text-muted uppercase tracking-wider mb-1.5">
                  Preheader
                </label>
                <input
                  value={finalPreheader}
                  onChange={(e) => setEditedPreheader(e.target.value)}
                  className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
                />
                <div className="text-[10px] text-ops-text-muted mt-1">{finalPreheader.length} chars</div>
              </div>
              <div>
                <label className="block text-xs font-medium text-ops-text-muted uppercase tracking-wider mb-1.5">
                  Template name (for Klaviyo)
                </label>
                <input
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder={finalSubject || "Untitled"}
                  className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text placeholder:text-ops-text-muted/50 focus:outline-none focus:border-fitscript-green"
                />
              </div>

              <div className="flex gap-2 pt-2">
                {!savedTemplate ? (
                  <button
                    onClick={handleSave}
                    disabled={saving || !finalHtml}
                    className="flex-1 py-2 rounded-lg bg-ops-bg border border-ops-border text-ops-text font-medium text-sm hover:bg-ops-surface-hover disabled:opacity-40 transition-colors"
                  >
                    {saving ? "Saving…" : "Save to Klaviyo"}
                  </button>
                ) : (
                  <>
                    <div className="flex-1 text-xs text-fitscript-green bg-fitscript-green/10 border border-fitscript-green/20 rounded-lg px-3 py-2 flex items-center justify-between">
                      <span>Saved: {savedTemplate.name}</span>
                      <span className="font-mono text-[10px] opacity-60">{savedTemplate.id.slice(0, 8)}</span>
                    </div>
                    <button
                      onClick={handleSendNow}
                      className="px-4 py-2 rounded-lg bg-fitscript-green text-white font-medium text-sm hover:bg-fitscript-green/90 transition-colors"
                    >
                      Send Now →
                    </button>
                  </>
                )}
              </div>
              {saveError && (
                <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
                  {saveError}
                </div>
              )}
            </div>
          )}
        </div>

        {/* RIGHT — Preview */}
        <div className="col-span-7">
          <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card overflow-hidden h-[calc(100vh-180px)] flex flex-col">
            <div className="px-5 py-3 border-b border-ops-border flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-ops-text">Preview</div>
                {finalSubject && (
                  <div className="text-xs text-ops-text-muted mt-0.5 truncate max-w-[400px]">
                    {finalSubject} · <span className="opacity-60">{finalPreheader}</span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-ops-text-muted">
                {streaming && (
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 bg-fitscript-green rounded-full animate-pulse" />
                    streaming
                  </span>
                )}
                {finalHtml && <span>{(finalHtml.length / 1024).toFixed(1)} KB</span>}
              </div>
            </div>
            <div className="flex-1 bg-zinc-200 p-3 overflow-auto">
              {finalHtml ? (
                <iframe
                  srcDoc={finalHtml}
                  title="Email preview"
                  className="w-full h-full bg-white rounded shadow-sm border border-zinc-300"
                />
              ) : streaming ? (
                <div className="h-full flex items-center justify-center text-sm text-zinc-500">
                  <span>Composing…</span>
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-sm text-zinc-500 text-center px-12">
                  <div>
                    <div className="text-base font-medium mb-2 text-zinc-700">No email yet</div>
                    <div>Fill in a campaign goal on the left and click <span className="text-zinc-800 font-medium">Compose Email</span>.</div>
                  </div>
                </div>
              )}
            </div>
            {/* Raw output toggle */}
            {raw && (
              <details className="border-t border-ops-border">
                <summary className="px-5 py-2 text-xs text-ops-text-muted cursor-pointer hover:text-ops-text">
                  View raw stream ({raw.length} chars)
                </summary>
                <pre className="px-5 py-3 text-[10px] text-ops-text-muted bg-ops-bg max-h-64 overflow-auto font-mono">
                  {raw}
                </pre>
              </details>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
