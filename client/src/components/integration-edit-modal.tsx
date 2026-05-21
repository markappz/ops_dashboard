import { useState, useEffect } from "react";
import { ModalPortal } from "./modal-portal";

interface FieldSpec {
  envKey: string;
  label: string;
  placeholder: string | null;
  secret: boolean;
  currentTail: string | null;
}

interface SpecResp {
  name: string;
  fields: FieldSpec[];
  managedBy: "secrets-manager" | "env-only";
}

interface TestResp {
  ok: boolean;
  detail?: string;
  error?: string;
}

/**
 * Modal for updating + testing one integration's credentials. Server
 * route returns the field schema; this component renders the form.
 *
 * UX: Test before save — operator pastes new values, hits "Test", sees
 * green/red status, then "Save" to commit. Save calls PATCH which
 * writes Secrets Manager + reloads process.env in the running container.
 */
export function IntegrationEditModal({
  integration,
  title,
  onClose,
  onSaved,
}: {
  integration: "klaviyo" | "slack" | "meta-ads" | "clomark";
  title: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [spec, setSpec] = useState<SpecResp | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<TestResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/ops/integrations/${integration}/spec`)
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) setSpec(j);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [integration]);

  const setField = (envKey: string, v: string) => {
    setValues((p) => ({ ...p, [envKey]: v }));
    setTestResult(null);
    setError(null);
  };

  const dirtyKeys = () =>
    Object.entries(values)
      .filter(([_, v]) => v && v.trim().length > 0)
      .map(([k]) => k);

  const test = async () => {
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      // Save first (so test runs against the new values), then test, then surface result.
      // If save fails, we don't proceed to test.
      const keys = dirtyKeys();
      if (keys.length > 0) {
        const filtered = Object.fromEntries(keys.map((k) => [k, values[k]]));
        const sr = await fetch(`/api/ops/integrations/${integration}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fields: filtered }),
        });
        const sj = await sr.json().catch(() => ({}));
        if (!sr.ok || sj.ok === false) {
          setError(sj.error || `Save failed (${sr.status})`);
          setBusy(false);
          return;
        }
        setSaved(true);
      }
      const tr = await fetch(`/api/ops/integrations/${integration}/test`, { method: "POST" });
      const tj: TestResp = await tr.json().catch(() => ({ ok: false, error: "Test response unreadable" }));
      setTestResult(tj);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const keys = dirtyKeys();
    if (keys.length === 0) {
      setError("Nothing to save — fill in at least one field.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const filtered = Object.fromEntries(keys.map((k) => [k, values[k]]));
      const r = await fetch(`/api/ops/integrations/${integration}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fields: filtered }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) {
        setError(j.error || `Save failed (${r.status})`);
        return;
      }
      setSaved(true);
      setTimeout(() => {
        onSaved();
        onClose();
      }, 600);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalPortal onClose={onClose}>
      <div
        className="bg-ops-surface border border-ops-border rounded-xl p-5 sm:p-6 w-full max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto shadow-2xl my-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between mb-1">
          <h3 className="text-base font-bold text-ops-text">Edit {title}</h3>
          <button onClick={onClose} className="text-ops-text-muted hover:text-ops-text text-xl leading-none">×</button>
        </div>
        <p className="text-xs text-ops-text-muted mb-5">
          Updates apply immediately — no redeploy needed. Stored in AWS Secrets Manager so they survive restarts.
        </p>

        {!spec ? (
          <div className="py-8 text-center text-sm text-ops-text-muted">Loading…</div>
        ) : (
          <div className="space-y-4">
            {spec.managedBy !== "secrets-manager" && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-xs text-amber-500">
                Server can't write to AWS Secrets Manager (AWS creds missing). Updates here will only stick for the lifetime of this container.
              </div>
            )}

            {spec.fields.map((f) => (
              <div key={f.envKey}>
                <label className="block text-[11px] font-semibold text-ops-text-muted uppercase tracking-wider mb-1.5">
                  {f.label}
                </label>
                <input
                  type={f.secret ? "password" : "text"}
                  value={values[f.envKey] ?? ""}
                  onChange={(e) => setField(f.envKey, e.target.value)}
                  placeholder={f.placeholder || ""}
                  className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500 focus:ring-2 focus:ring-brand-blue-500/20 font-mono"
                  autoComplete="off"
                />
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[10px] text-ops-text-subtle font-mono">{f.envKey}</span>
                  {f.currentTail && (
                    <span className="text-[10px] text-ops-text-subtle">currently: {f.currentTail}</span>
                  )}
                </div>
              </div>
            ))}

            {testResult && (
              <div
                className={`rounded-lg border px-3 py-2 text-xs ${
                  testResult.ok
                    ? "bg-brand-blue-500/10 border-brand-blue-400/30 text-brand-blue-500"
                    : "bg-red-500/10 border-red-500/30 text-red-400"
                }`}
              >
                {testResult.ok ? (
                  <>✓ <strong>Connected.</strong> {testResult.detail}</>
                ) : (
                  <>✗ <strong>Failed:</strong> {testResult.error}</>
                )}
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {error}
              </div>
            )}

            {saved && !testResult && (
              <div className="rounded-lg border border-brand-blue-400/30 bg-brand-blue-500/10 px-3 py-2 text-xs text-brand-blue-500">
                ✓ Saved
              </div>
            )}

            <div className="flex justify-between items-center pt-2">
              <button
                onClick={test}
                disabled={busy}
                className="px-3 py-2 text-xs font-semibold rounded-lg bg-ops-bg border border-ops-border text-ops-text-muted hover:text-ops-text hover:border-brand-blue-400/40 disabled:opacity-40"
              >
                {busy ? "Testing…" : "Save & Test"}
              </button>
              <div className="flex gap-2">
                <button onClick={onClose} className="px-3 py-2 text-xs text-ops-text-muted hover:text-ops-text">
                  Cancel
                </button>
                <button
                  onClick={save}
                  disabled={busy || dirtyKeys().length === 0}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 text-white shadow-[0_4px_14px_-4px_rgba(46,91,255,0.5)] disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-95"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </ModalPortal>
  );
}
