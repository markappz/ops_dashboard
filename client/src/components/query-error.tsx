/**
 * Shared error-state pattern for /api/ops/* React Query calls.
 *
 * The convention across this dashboard is that endpoints either:
 *   - 200 with the data shape they document
 *   - 4xx/5xx with `{error: string}` or `{error, detail}` in the body
 *
 * Most page-level useQuery calls silently fall through to "empty"
 * when the body has an `error` key, masking failures behind blank
 * UI. This helper detects that case and surfaces it loudly.
 */
import { ReactNode } from "react";

interface ErrorResponse {
  error?: string;
  detail?: unknown;
}

/**
 * `hasApiError(data)` — returns true when a useQuery succeeded HTTP-wise
 * (status 200, fetch didn't throw) but the body itself is an error envelope.
 *
 * Use:
 *   if (hasApiError(data)) return <QueryError context="Members list" data={data} />;
 */
export function hasApiError(data: unknown): data is ErrorResponse {
  if (!data || typeof data !== "object") return false;
  return typeof (data as ErrorResponse).error === "string";
}

interface QueryErrorProps {
  context: string;
  data?: unknown;
  error?: Error | null;
  hint?: ReactNode;
  onRetry?: () => void;
}

export function QueryError({ context, data, error, hint, onRetry }: QueryErrorProps) {
  const apiError = hasApiError(data) ? (data as ErrorResponse).error : null;
  const message = apiError || error?.message || "Unknown error";

  return (
    <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-5">
      <div className="text-sm font-medium text-red-300 mb-1">{context} failed</div>
      <div className="text-xs text-red-200/80 mb-3">{message}</div>
      {hint && <div className="text-xs text-red-300/70 mb-3">{hint}</div>}
      {onRetry && (
        <button
          onClick={onRetry}
          className="text-xs text-red-300 hover:text-red-200 underline"
        >
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * Inline variant for cards/tabs nested inside a larger surface.
 * Smaller padding, no border-radius assumption.
 */
export function InlineError({ context, data, error }: Omit<QueryErrorProps, "hint" | "onRetry">) {
  const apiError = hasApiError(data) ? (data as ErrorResponse).error : null;
  const message = apiError || error?.message || "Unknown error";
  return (
    <div className="bg-red-500/10 border border-red-500/30 rounded px-3 py-2 text-xs text-red-300">
      <span className="font-medium">{context} failed:</span> {message}
    </div>
  );
}
