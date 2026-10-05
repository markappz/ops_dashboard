import { useQuery } from "@tanstack/react-query";

/**
 * Which brands send through their own in-house email engine (and what that
 * engine can do). Mirrors the server's brand-engines registry via
 * GET /api/ops/engines — the client's single source for "Review & send vs
 * Push to Resend" decisions.
 */

export interface EngineInfo {
  configured: boolean;
  label: string;
  capabilities: string[];
}

export function useEngines(): Record<string, EngineInfo> {
  const q = useQuery({
    queryKey: ["ops-engines"],
    queryFn: async () => {
      const r = await fetch("/api/ops/engines", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as Record<string, EngineInfo>;
    },
    staleTime: 10 * 60_000,
  });
  return q.data ?? {};
}

/** One brand's engine info, or null while loading / for non-engine brands. */
export function useEngine(company: string): EngineInfo | null {
  const engines = useEngines();
  return engines[company] ?? null;
}
