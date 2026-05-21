import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";

interface Template {
  id: string;
  name: string;
  editorType: string | null;
  updatedAt: string | null;
}

interface List {
  id: string;
  name: string;
}

interface Segment {
  id: string;
  name: string;
  isActive: boolean;
}

interface AudienceSize {
  total: number;
  breakdown: Array<{ kind: "list" | "segment"; id: string; name: string; count: number }>;
}

interface Status {
  configured: boolean;
  connected: boolean;
  defaultSenderEmail?: string | null;
  defaultSenderName?: string | null;
  organization?: string | null;
}

type SendMethod = "immediate" | "static" | "smart_send_time" | "throttled";

// Klaviyo accepts throttle_percentage 1-100. These are the preset durations
// we expose — each maps to (100 / pct) hours of send window.
const THROTTLE_PRESETS: { label: string; hours: number; pct: number }[] = [
  { label: "2 hours", hours: 2, pct: 50 },
  { label: "4 hours", hours: 4, pct: 25 },
  { label: "8 hours", hours: 8, pct: 13 },
  { label: "12 hours", hours: 12, pct: 8 },
  { label: "24 hours", hours: 24, pct: 4 },
];
type Step = 1 | 2 | 3 | 4;

const TYPE_TO_CONFIRM_THRESHOLD = 1000;

export default function EmailSend() {
  const [, navigate] = useLocation();
  // Pre-select template if /email/send?templateId=... (from compose handoff)
  const initialTemplateId = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("templateId") || "";
  }, []);

  const [step, setStep] = useState<Step>(initialTemplateId ? 2 : 1);

  // form state
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState<string>(initialTemplateId);
  const [includeListIds, setIncludeListIds] = useState<string[]>([]);
  const [includeSegmentIds, setIncludeSegmentIds] = useState<string[]>([]);
  const [excludedSegmentIds, setExcludedSegmentIds] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [fromLabel, setFromLabel] = useState("");
  const [sendMethod, setSendMethod] = useState<SendMethod>("immediate");
  const [scheduledFor, setScheduledFor] = useState<string>("");
  const [throttlePercentage, setThrottlePercentage] = useState<number>(25);
  const [smartSendingEnabled, setSmartSendingEnabled] = useState(true);
  const [confirmText, setConfirmText] = useState("");

  // submit state
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<{ campaignId: string } | null>(null);

  // bootstrap from connector
  const { data: status } = useQuery<Status>({
    queryKey: ["klaviyo-status"],
    queryFn: () => fetch("/api/ops/klaviyo/status").then((r) => r.json()),
  });

  useEffect(() => {
    if (status?.defaultSenderEmail && !fromEmail) setFromEmail(status.defaultSenderEmail);
    if (status?.defaultSenderName && !fromLabel) setFromLabel(status.defaultSenderName);
  }, [status]);

  const { data: templatesData } = useQuery<{ templates: Template[] }>({
    queryKey: ["klaviyo-templates"],
    queryFn: () => fetch("/api/ops/klaviyo/templates").then((r) => r.json()),
  });

  const { data: listsData } = useQuery<{ lists: List[] }>({
    queryKey: ["klaviyo-lists"],
    queryFn: () => fetch("/api/ops/klaviyo/lists").then((r) => r.json()),
  });

  const { data: segmentsData } = useQuery<{ segments: Segment[] }>({
    queryKey: ["klaviyo-segments"],
    queryFn: () => fetch("/api/ops/klaviyo/segments").then((r) => r.json()),
  });

  const audiencePayload = useMemo(
    () => ({ listIds: includeListIds, segmentIds: includeSegmentIds }),
    [includeListIds, includeSegmentIds]
  );

  const { data: audienceSize } = useQuery<AudienceSize>({
    queryKey: ["klaviyo-audience-size", audiencePayload],
    queryFn: () =>
      fetch("/api/ops/klaviyo/audience-size", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(audiencePayload),
      }).then((r) => r.json()),
    enabled: includeListIds.length + includeSegmentIds.length > 0,
  });

  const recipientCount = audienceSize?.total ?? 0;
  const needsTypeConfirm = recipientCount >= TYPE_TO_CONFIRM_THRESHOLD;

  const selectedTemplate = templatesData?.templates?.find((t) => t.id === templateId);

  function toggleId(arr: string[], setArr: (v: string[]) => void, id: string) {
    setArr(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  }

  function canAdvance(): boolean {
    if (step === 1) return !!name && !!templateId;
    if (step === 2) return includeListIds.length + includeSegmentIds.length > 0;
    if (step === 3)
      return (
        !!subject &&
        !!fromEmail &&
        !!fromLabel &&
        (sendMethod !== "static" || !!scheduledFor) &&
        (sendMethod !== "throttled" || throttlePercentage > 0)
      );
    return true;
  }

  async function submit() {
    if (needsTypeConfirm && confirmText !== "SEND") {
      setSubmitError(`Type SEND to confirm sending to ${recipientCount.toLocaleString()} people`);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r = await fetch("/api/ops/klaviyo/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          templateId,
          subject,
          previewText,
          fromEmail,
          fromLabel,
          listIds: includeListIds,
          segmentIds: includeSegmentIds,
          excludedSegmentIds,
          sendMethod,
          scheduledFor: sendMethod !== "immediate" ? scheduledFor : undefined,
          throttlePercentage: sendMethod === "throttled" ? throttlePercentage : undefined,
          smartSendingEnabled,
        }),
      });
      const body = await r.json();
      if (!r.ok) {
        setSubmitError(body.error || `Send failed (HTTP ${r.status})`);
      } else {
        setSubmitSuccess({ campaignId: body.campaignId });
      }
    } catch (e: any) {
      setSubmitError(e.message || "Send failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitSuccess) {
    return (
      <div>
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-ops-text">Send submitted</h1>
        </div>
        <div className="bg-ops-surface border border-ops-border rounded-xl p-6 max-w-2xl">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-3 h-3 rounded-full bg-fitscript-green mt-1.5" />
            <div>
              <div className="text-base font-semibold text-ops-text">Campaign queued in Klaviyo</div>
              <div className="text-sm text-ops-text-muted mt-1">
                Klaviyo campaign id: <code className="text-ops-text">{submitSuccess.campaignId}</code>
              </div>
              <div className="text-sm text-ops-text-muted mt-1">
                {sendMethod === "immediate"
                  ? "Sending now."
                  : sendMethod === "static"
                  ? `Scheduled for ${new Date(scheduledFor).toLocaleString()}.`
                  : sendMethod === "throttled"
                  ? `Throttled — Klaviyo will release ${throttlePercentage}% of recipients per hour.`
                  : "Smart Send Time — Klaviyo will pick the best time per recipient."}
              </div>
            </div>
          </div>
          <div className="flex gap-3 mt-6">
            <button
              onClick={() => navigate("/email")}
              className="px-4 py-2 text-sm rounded-lg bg-fitscript-green text-white hover:bg-fitscript-green/90"
            >
              Back to Email
            </button>
            <a
              href={`https://www.klaviyo.com/campaign/${submitSuccess.campaignId}/reports/overview`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 text-sm rounded-lg border border-ops-border text-ops-text hover:bg-ops-surface-hover"
            >
              Open in Klaviyo
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ops-text">Send a campaign</h1>
          <p className="text-sm text-ops-text-muted mt-1">
            Pick a template, choose your audience, send (or schedule).
          </p>
        </div>
        <button
          onClick={() => navigate("/email")}
          className="text-sm text-ops-text-muted hover:text-ops-text"
        >
          Cancel
        </button>
      </div>

      <Stepper step={step} />

      <div className="max-w-3xl">
        {step === 1 && (
          <Step1
            name={name}
            setName={setName}
            templateId={templateId}
            setTemplateId={setTemplateId}
            templates={templatesData?.templates ?? []}
          />
        )}
        {step === 2 && (
          <Step2
            lists={listsData?.lists ?? []}
            segments={segmentsData?.segments ?? []}
            includeListIds={includeListIds}
            includeSegmentIds={includeSegmentIds}
            excludedSegmentIds={excludedSegmentIds}
            audienceSize={audienceSize}
            onToggleList={(id) => toggleId(includeListIds, setIncludeListIds, id)}
            onToggleSegment={(id) => toggleId(includeSegmentIds, setIncludeSegmentIds, id)}
            onToggleExcluded={(id) =>
              toggleId(excludedSegmentIds, setExcludedSegmentIds, id)
            }
          />
        )}
        {step === 3 && (
          <Step3
            subject={subject}
            setSubject={setSubject}
            previewText={previewText}
            setPreviewText={setPreviewText}
            fromEmail={fromEmail}
            setFromEmail={setFromEmail}
            fromLabel={fromLabel}
            setFromLabel={setFromLabel}
            sendMethod={sendMethod}
            setSendMethod={setSendMethod}
            scheduledFor={scheduledFor}
            setScheduledFor={setScheduledFor}
            throttlePercentage={throttlePercentage}
            setThrottlePercentage={setThrottlePercentage}
            smartSendingEnabled={smartSendingEnabled}
            setSmartSendingEnabled={setSmartSendingEnabled}
          />
        )}
        {step === 4 && (
          <Step4
            name={name}
            template={selectedTemplate}
            templateId={templateId}
            subject={subject}
            previewText={previewText}
            fromEmail={fromEmail}
            fromLabel={fromLabel}
            sendMethod={sendMethod}
            scheduledFor={scheduledFor}
            throttlePercentage={throttlePercentage}
            audienceSize={audienceSize}
            needsTypeConfirm={needsTypeConfirm}
            confirmText={confirmText}
            setConfirmText={setConfirmText}
            submitting={submitting}
            submitError={submitError}
            onSubmit={submit}
          />
        )}

        <div className="flex items-center justify-between mt-8 pt-6 border-t border-ops-border">
          <button
            onClick={() => {
              if (step === 1) navigate("/email");
              else setStep((s) => ((s - 1) as Step));
            }}
            className="px-4 py-2 text-sm rounded-lg border border-ops-border text-ops-text hover:bg-ops-surface-hover"
          >
            {step === 1 ? "← Back to Email" : "Back"}
          </button>
          {step < 4 ? (
            <button
              onClick={() =>
                canAdvance() && setStep((s) => (s < 4 ? ((s + 1) as Step) : s))
              }
              disabled={!canAdvance()}
              className="px-5 py-2 text-sm rounded-lg bg-fitscript-green text-white hover:bg-fitscript-green/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Continue
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const steps = ["Template", "Audience", "Compose", "Confirm"];
  return (
    <div className="flex items-center gap-3 mb-8 text-xs">
      {steps.map((label, i) => {
        const idx = (i + 1) as Step;
        const active = step === idx;
        const done = step > idx;
        return (
          <div key={label} className="flex items-center gap-2">
            <span
              className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold ${
                active
                  ? "bg-fitscript-green text-white"
                  : done
                  ? "bg-fitscript-green/20 text-fitscript-green"
                  : "bg-ops-surface text-ops-text-muted border border-ops-border"
              }`}
            >
              {idx}
            </span>
            <span
              className={`font-medium ${active ? "text-ops-text" : "text-ops-text-muted"}`}
            >
              {label}
            </span>
            {idx < steps.length && <span className="text-ops-text-muted">›</span>}
          </div>
        );
      })}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <label className="text-sm font-medium text-ops-text mb-1 block">{label}</label>
      {hint && <p className="text-xs text-ops-text-muted mb-2">{hint}</p>}
      {children}
    </div>
  );
}

const inputClass =
  "bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text w-full focus:outline-none focus:border-fitscript-green";

function Step1({
  name,
  setName,
  templateId,
  setTemplateId,
  templates,
}: {
  name: string;
  setName: (v: string) => void;
  templateId: string;
  setTemplateId: (v: string) => void;
  templates: Template[];
}) {
  return (
    <div>
      <Field
        label="Internal name"
        hint="What this campaign is called in Klaviyo. Not visible to recipients."
      >
        <input
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. May newsletter — paid subscribers"
        />
      </Field>

      <Field label="Template" hint="Designed in Klaviyo. Pick the one you want to send.">
        {templates.length === 0 ? (
          <div className="text-sm text-ops-text-muted">No templates found in Klaviyo.</div>
        ) : (
          <div className="border border-ops-border rounded-lg max-h-96 overflow-y-auto divide-y divide-ops-border">
            {templates.map((t) => (
              <label
                key={t.id}
                className={`flex items-center gap-3 px-4 py-3 cursor-pointer ${
                  templateId === t.id ? "bg-fitscript-green/8" : "hover:bg-ops-surface-hover"
                }`}
              >
                <input
                  type="radio"
                  name="template"
                  className="accent-fitscript-green"
                  checked={templateId === t.id}
                  onChange={() => setTemplateId(t.id)}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-ops-text truncate">{t.name}</div>
                  <div className="text-xs text-ops-text-muted">
                    {t.editorType ?? "—"} · updated {fmt(t.updatedAt)}
                  </div>
                </div>
              </label>
            ))}
          </div>
        )}
      </Field>
    </div>
  );
}

function Step2({
  lists,
  segments,
  includeListIds,
  includeSegmentIds,
  excludedSegmentIds,
  audienceSize,
  onToggleList,
  onToggleSegment,
  onToggleExcluded,
}: {
  lists: List[];
  segments: Segment[];
  includeListIds: string[];
  includeSegmentIds: string[];
  excludedSegmentIds: string[];
  audienceSize: AudienceSize | undefined;
  onToggleList: (id: string) => void;
  onToggleSegment: (id: string) => void;
  onToggleExcluded: (id: string) => void;
}) {
  return (
    <div>
      <div className="grid grid-cols-2 gap-4 mb-6">
        <AudiencePicker
          title="Lists"
          items={lists.map((l) => ({ id: l.id, name: l.name }))}
          selected={includeListIds}
          onToggle={onToggleList}
        />
        <AudiencePicker
          title="Segments"
          items={segments
            .filter((s) => s.isActive)
            .map((s) => ({ id: s.id, name: s.name }))}
          selected={includeSegmentIds}
          onToggle={onToggleSegment}
        />
      </div>

      <div className="bg-ops-surface border border-ops-border rounded-xl p-5 mb-6">
        <div className="text-xs uppercase tracking-wider text-ops-text-muted font-medium mb-3">
          Estimated recipients
        </div>
        <div className="text-3xl font-bold text-ops-text">
          {(audienceSize?.total ?? 0).toLocaleString()}
        </div>
        <div className="text-xs text-ops-text-muted mt-1">
          Upper bound — Klaviyo dedups across audiences at send time.
        </div>
        {audienceSize && audienceSize.breakdown.length > 0 && (
          <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
            {audienceSize.breakdown.map((b) => (
              <div key={`${b.kind}-${b.id}`} className="flex justify-between text-ops-text-muted">
                <span className="truncate pr-2">{b.name}</span>
                <span>{b.count.toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer text-ops-text-muted">
          Exclude segments (optional)
        </summary>
        <div className="mt-3">
          <AudiencePicker
            title=""
            items={segments
              .filter((s) => s.isActive)
              .map((s) => ({ id: s.id, name: s.name }))}
            selected={excludedSegmentIds}
            onToggle={onToggleExcluded}
          />
        </div>
      </details>
    </div>
  );
}

function AudiencePicker({
  title,
  items,
  selected,
  onToggle,
}: {
  title: string;
  items: { id: string; name: string }[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl">
      {title && (
        <div className="px-4 py-2 border-b border-ops-border text-xs uppercase tracking-wider text-ops-text-muted font-medium">
          {title}
        </div>
      )}
      <div className="max-h-64 overflow-y-auto divide-y divide-ops-border">
        {items.length === 0 ? (
          <div className="px-4 py-3 text-sm text-ops-text-muted">None.</div>
        ) : (
          items.map((it) => (
            <label
              key={it.id}
              className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer ${
                selected.includes(it.id) ? "bg-fitscript-green/8" : "hover:bg-ops-surface-hover"
              }`}
            >
              <input
                type="checkbox"
                className="accent-fitscript-green"
                checked={selected.includes(it.id)}
                onChange={() => onToggle(it.id)}
              />
              <span className="text-sm text-ops-text truncate">{it.name}</span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}

function Step3({
  subject,
  setSubject,
  previewText,
  setPreviewText,
  fromEmail,
  setFromEmail,
  fromLabel,
  setFromLabel,
  sendMethod,
  setSendMethod,
  scheduledFor,
  setScheduledFor,
  throttlePercentage,
  setThrottlePercentage,
  smartSendingEnabled,
  setSmartSendingEnabled,
}: {
  subject: string;
  setSubject: (v: string) => void;
  previewText: string;
  setPreviewText: (v: string) => void;
  fromEmail: string;
  setFromEmail: (v: string) => void;
  fromLabel: string;
  setFromLabel: (v: string) => void;
  sendMethod: SendMethod;
  setSendMethod: (v: SendMethod) => void;
  scheduledFor: string;
  setScheduledFor: (v: string) => void;
  throttlePercentage: number;
  setThrottlePercentage: (v: number) => void;
  smartSendingEnabled: boolean;
  setSmartSendingEnabled: (v: boolean) => void;
}) {
  return (
    <div>
      <Field label="Subject" hint={`${subject.length} chars · aim for under 60`}>
        <input className={inputClass} value={subject} onChange={(e) => setSubject(e.target.value)} />
      </Field>

      <Field label="Preview text" hint={`${previewText.length} chars · the snippet shown after the subject`}>
        <input
          className={inputClass}
          value={previewText}
          onChange={(e) => setPreviewText(e.target.value)}
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="From name">
          <input
            className={inputClass}
            value={fromLabel}
            onChange={(e) => setFromLabel(e.target.value)}
          />
        </Field>
        <Field label="From email">
          <input
            className={inputClass}
            value={fromEmail}
            onChange={(e) => setFromEmail(e.target.value)}
          />
        </Field>
      </div>

      <Field label="When to send">
        <div className="flex gap-2 flex-wrap">
          {(
            [
              { v: "immediate", label: "Now" },
              { v: "static", label: "Schedule" },
              { v: "smart_send_time", label: "Smart Send Time" },
              { v: "throttled", label: "Throttled" },
            ] as { v: SendMethod; label: string }[]
          ).map((opt) => (
            <button
              key={opt.v}
              onClick={() => setSendMethod(opt.v)}
              className={`px-4 py-2 text-sm rounded-lg border transition-colors ${
                sendMethod === opt.v
                  ? "border-fitscript-green text-fitscript-green bg-fitscript-green/8"
                  : "border-ops-border text-ops-text-muted hover:text-ops-text"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </Field>

      {(sendMethod === "static" ||
        sendMethod === "smart_send_time" ||
        sendMethod === "throttled") && (
        <Field
          label={
            sendMethod === "static"
              ? "Send at"
              : sendMethod === "throttled"
                ? "Start sending at"
                : "Window starts at"
          }
          hint={
            sendMethod === "smart_send_time"
              ? "Klaviyo picks the optimal time per recipient inside a 24h window starting at this time."
              : sendMethod === "throttled"
                ? "Optional — leave blank to start immediately."
                : ""
          }
        >
          <input
            type="datetime-local"
            className={inputClass}
            value={scheduledFor}
            onChange={(e) => setScheduledFor(toIso(e.target.value))}
          />
        </Field>
      )}

      {sendMethod === "throttled" && (
        <Field
          label="Spread over"
          hint="Spreads the send across the chosen window. Easier on deliverability for larger lists."
        >
          <div className="flex gap-2 flex-wrap">
            {THROTTLE_PRESETS.map((p) => (
              <button
                key={p.pct}
                onClick={() => setThrottlePercentage(p.pct)}
                className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                  throttlePercentage === p.pct
                    ? "border-fitscript-green text-fitscript-green bg-fitscript-green/8"
                    : "border-ops-border text-ops-text-muted hover:text-ops-text"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="text-[10px] text-ops-text-muted mt-2">
            {throttlePercentage}% of recipients per hour
          </div>
        </Field>
      )}

      <Field label="Smart Sending" hint="Skip recipients who already received a Klaviyo message in the last 16 hours.">
        <label className="flex items-center gap-2 text-sm text-ops-text">
          <input
            type="checkbox"
            checked={smartSendingEnabled}
            onChange={(e) => setSmartSendingEnabled(e.target.checked)}
            className="accent-fitscript-green"
          />
          Enabled (recommended)
        </label>
      </Field>
    </div>
  );
}

function Step4({
  name,
  template,
  templateId,
  subject,
  previewText,
  fromEmail,
  fromLabel,
  sendMethod,
  scheduledFor,
  throttlePercentage,
  audienceSize,
  needsTypeConfirm,
  confirmText,
  setConfirmText,
  submitting,
  submitError,
  onSubmit,
}: {
  name: string;
  template: Template | undefined;
  templateId: string;
  subject: string;
  previewText: string;
  fromEmail: string;
  fromLabel: string;
  sendMethod: SendMethod;
  scheduledFor: string;
  throttlePercentage: number;
  audienceSize: AudienceSize | undefined;
  needsTypeConfirm: boolean;
  confirmText: string;
  setConfirmText: (v: string) => void;
  submitting: boolean;
  submitError: string | null;
  onSubmit: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { data: html } = useQuery<{ html: string; text: string; name: string | null }>({
    queryKey: ["klaviyo-template-html", templateId],
    queryFn: () =>
      fetch(`/api/ops/klaviyo/templates/${templateId}/html`).then((r) => r.json()),
    enabled: !!templateId,
  });

  useEffect(() => {
    if (iframeRef.current && html?.html) {
      iframeRef.current.srcdoc = html.html;
    }
  }, [html]);

  const summaryRow = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between py-2 border-b border-ops-border last:border-0">
      <span className="text-xs uppercase tracking-wider text-ops-text-muted font-medium">
        {label}
      </span>
      <span className="text-sm text-ops-text text-right max-w-[60%] truncate">{value}</span>
    </div>
  );

  return (
    <div>
      <div className="grid grid-cols-2 gap-6 mb-6">
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5">
          <div className="text-xs uppercase tracking-wider text-ops-text-muted font-medium mb-3">
            Send summary
          </div>
          <div className="px-1">
            {summaryRow("Internal name", name)}
            {summaryRow("Template", template?.name ?? "—")}
            {summaryRow("Subject", subject)}
            {summaryRow("From", `${fromLabel} <${fromEmail}>`)}
            {summaryRow(
              "Recipients",
              <span className="font-bold">
                {(audienceSize?.total ?? 0).toLocaleString()}
              </span>
            )}
            {summaryRow(
              "When",
              sendMethod === "immediate"
                ? "Now"
                : sendMethod === "static"
                ? new Date(scheduledFor).toLocaleString()
                : sendMethod === "throttled"
                ? `Throttled · ${throttlePercentage}%/hr starting ${
                    scheduledFor ? new Date(scheduledFor).toLocaleString() : "now"
                  }`
                : `Smart Send Time after ${new Date(scheduledFor || Date.now()).toLocaleString()}`
            )}
          </div>
        </div>

        <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-ops-border text-xs uppercase tracking-wider text-ops-text-muted font-medium">
            Email preview
          </div>
          <div className="bg-white">
            <iframe
              ref={iframeRef}
              title="Email preview"
              className="w-full h-96 border-0"
              sandbox=""
            />
          </div>
          <div className="px-5 py-3 border-t border-ops-border text-xs text-ops-text-muted">
            Preview is the raw template HTML. Personalization variables render at send time.
          </div>
        </div>
      </div>

      {needsTypeConfirm && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-5 mb-6">
          <div className="text-sm font-medium text-yellow-300 mb-1">
            High-volume send confirmation
          </div>
          <div className="text-xs text-yellow-300/80 mb-3">
            You're about to send to{" "}
            <strong>{(audienceSize?.total ?? 0).toLocaleString()}</strong> people. Type{" "}
            <code className="font-mono">SEND</code> below to confirm.
          </div>
          <input
            className="bg-ops-bg border border-yellow-500/30 rounded-lg px-3 py-2 text-sm text-ops-text font-mono w-48"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="Type SEND"
          />
        </div>
      )}

      {submitError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-6">
          <div className="text-sm font-medium text-red-300 mb-1">Send failed</div>
          <div className="text-xs text-red-300/80 break-all">{submitError}</div>
        </div>
      )}

      <button
        onClick={onSubmit}
        disabled={
          submitting || (needsTypeConfirm && confirmText !== "SEND") || !audienceSize?.total
        }
        className="px-6 py-3 text-sm font-semibold rounded-lg bg-fitscript-green text-white hover:bg-fitscript-green/90 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {submitting
          ? "Sending…"
          : sendMethod === "immediate"
          ? `Send to ${(audienceSize?.total ?? 0).toLocaleString()} people`
          : "Schedule send"}
      </button>
    </div>
  );
}

function fmt(d: string | null) {
  if (!d) return "—";
  const date = new Date(d);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Convert local-datetime input value to ISO 8601 (Klaviyo expects UTC).
function toIso(local: string): string {
  if (!local) return "";
  return new Date(local).toISOString();
}
