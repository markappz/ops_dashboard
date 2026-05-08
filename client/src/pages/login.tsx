export default function Login({ error }: { error?: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-ops-bg px-4">
      <div className="w-full max-w-sm bg-ops-surface border border-ops-border rounded-2xl shadow-card p-8">
        <div className="mb-6">
          <div className="text-xs font-semibold text-fitscript-green uppercase tracking-wider mb-2">
            FitScript Ops
          </div>
          <h1 className="text-xl font-bold text-ops-text">Admin sign in</h1>
          <p className="text-sm text-ops-text-muted mt-1">
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
          className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg bg-fitscript-green hover:bg-fitscript-green/90 text-white text-sm font-medium transition-colors"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden>
            <path
              fill="currentColor"
              d="M21.35 11.1H12v3.2h5.35c-.23 1.4-1.62 4.1-5.35 4.1-3.22 0-5.85-2.66-5.85-5.95S8.78 6.5 12 6.5c1.83 0 3.06.78 3.76 1.45l2.55-2.46C16.74 3.99 14.6 3 12 3 6.93 3 2.85 7.08 2.85 12.15S6.93 21.3 12 21.3c6.93 0 9.5-4.86 9.5-9.36 0-.62-.07-1.1-.15-1.84z"
            />
          </svg>
          Sign in with Google
        </a>
      </div>
    </div>
  );
}
