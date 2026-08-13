import { useState } from "react";

export default function Login({ error }: { error?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");

  // Password login exists for team addresses that aren't Google accounts —
  // hello@pawgen.com and support@realpeptides.co are mail aliases, so
  // "Sign in with Google" has nothing to authenticate against.
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFormError("");
    try {
      const r = await fetch("/api/ops/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      if (r.ok) {
        window.location.href = "/";
        return;
      }
      const d = await r.json().catch(() => ({}));
      setFormError(d.error || "Invalid email or password.");
    } catch {
      setFormError("Login failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-ops-bg px-4 relative overflow-hidden">
      {/* Branded gradient backdrop — mirrors FitScript marketing hero */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(900px 600px at 30% 20%, rgb(46,91,255,0.12), transparent 60%), radial-gradient(700px 500px at 80% 70%, rgb(159,182,255,0.10), transparent 60%)",
        }}
      />
      <div className="relative w-full max-w-sm bg-ops-surface border border-ops-border rounded-2xl shadow-card-lg p-8">
        <div className="mb-6">
          <div className="text-[10px] font-semibold text-brand-blue-500 uppercase tracking-[0.18em] mb-2">
            FitScript · Ops
          </div>
          <h1 className="text-2xl font-bold text-ops-text tracking-tight">Welcome back</h1>
          <p className="text-sm text-ops-text-muted mt-1.5">
            Authorized admins only.
          </p>
        </div>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
            {error}
          </div>
        )}

        <a
          href="/api/ops/auth/login"
          className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 hover:opacity-95 text-white text-sm font-medium transition-all shadow-[0_8px_24px_-8px_rgba(46,91,255,0.5)]"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden>
            <path
              fill="currentColor"
              d="M21.35 11.1H12v3.2h5.35c-.23 1.4-1.62 4.1-5.35 4.1-3.22 0-5.85-2.66-5.85-5.95S8.78 6.5 12 6.5c1.83 0 3.06.78 3.76 1.45l2.55-2.46C16.74 3.99 14.6 3 12 3 6.93 3 2.85 7.08 2.85 12.15S6.93 21.3 12 21.3c6.93 0 9.5-4.86 9.5-9.36 0-.62-.07-1.1-.15-1.84z"
            />
          </svg>
          Sign in with Google
        </a>

        <div className="flex items-center gap-3 my-5">
          <div className="h-px flex-1 bg-ops-border" />
          <span className="text-[11px] uppercase tracking-wider text-ops-text-muted">or</span>
          <div className="h-px flex-1 bg-ops-border" />
        </div>

        <form onSubmit={submit} className="space-y-3">
          <input
            type="email"
            required
            autoComplete="username"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2.5 rounded-lg bg-ops-bg border border-ops-border text-sm text-ops-text placeholder:text-ops-text-muted focus:outline-none focus:border-brand-blue-500"
          />
          <input
            type="password"
            required
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3 py-2.5 rounded-lg bg-ops-bg border border-ops-border text-sm text-ops-text placeholder:text-ops-text-muted focus:outline-none focus:border-brand-blue-500"
          />
          {formError && (
            <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
              {formError}
            </div>
          )}
          <button
            type="submit"
            disabled={busy}
            className="w-full px-4 py-2.5 rounded-lg border border-ops-border text-sm font-medium text-ops-text hover:border-brand-blue-500 disabled:opacity-60 transition-colors"
          >
            {busy ? "Signing in…" : "Sign in with password"}
          </button>
        </form>
      </div>
    </div>
  );
}
