import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PuLoading, PuUnavailable } from "../components/peptideu/ui";

interface Member {
  id: string;
  email: string | null;
  display_name: string | null;
  role: string;
  entitlement: string;
  points: number;
  created_at: string;
  error?: string;
}

const ROLES = ["member", "coach", "moderator", "admin", "owner"];

function RoleBadge({ role }: { role: string }) {
  const staff = role !== "member";
  return (
    <span
      className={`text-[10px] font-mono uppercase tracking-wide px-2 py-0.5 rounded ${
        staff ? "bg-[#5C7FFF]/15 text-[#5C7FFF]" : "bg-ops-bg text-ops-text-muted"
      }`}
    >
      {role}
    </span>
  );
}

export default function PeptideuMembers() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const key = ["/api/ops/peptideu/members", q];
  const { data, isLoading, error } = useQuery<Member[]>({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/ops/peptideu/members?q=${encodeURIComponent(q)}`);
      return r.json();
    },
  });

  const flash = (ok: boolean, msg: string) => {
    setToast({ ok, msg });
    setTimeout(() => setToast(null), 3500);
  };

  const act = async (url: string, body: object, label: string) => {
    setBusy(url);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error === "read_only" ? "Read-only account — ask an admin" : d.error);
      await qc.invalidateQueries({ queryKey: ["/api/ops/peptideu/members"] });
      flash(true, label);
    } catch (e: any) {
      flash(false, e.message);
    } finally {
      setBusy(null);
    }
  };

  if (isLoading) return <PuLoading />;
  if ((data as any)?.error) return <PuUnavailable message={(data as any).error} />;
  if (error) return <PuUnavailable message="Failed to load members" />;
  const members = Array.isArray(data) ? data : [];

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-1 text-xs font-mono uppercase tracking-widest text-[#5C7FFF]">PeptideU · Members</div>
      <h1 className="text-2xl font-semibold text-ops-text">Members</h1>
      <p className="text-sm text-ops-text-muted mt-1">
        Search, comp premium, and assign roles — no SQL needed. Newest first when the search is empty.
      </p>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by email or name…"
        className="mt-5 w-full bg-ops-surface border border-ops-border rounded-lg px-4 py-2.5 text-sm text-ops-text placeholder:text-ops-text-muted focus:outline-none focus:border-[#5C7FFF]"
      />

      {toast && (
        <div
          className={`mt-3 text-sm rounded-lg px-4 py-2 ${
            toast.ok ? "bg-fitscript-green/15 text-fitscript-green" : "bg-red-500/15 text-red-400"
          }`}
        >
          {toast.msg}
        </div>
      )}

      <div className="mt-4 bg-ops-surface border border-ops-border rounded-xl overflow-hidden shadow-card">
        {members.length === 0 ? (
          <div className="p-8 text-center text-ops-text-muted text-sm">No members match that search.</div>
        ) : (
          members.map((m, i) => {
            const premium = m.entitlement === "premium";
            return (
              <div
                key={m.id}
                className={`flex flex-wrap items-center gap-3 p-4 ${i > 0 ? "border-t border-ops-border" : ""}`}
              >
                <div className="flex-1 min-w-[200px]">
                  <div className="text-sm font-medium text-ops-text">{m.display_name || m.email || "—"}</div>
                  <div className="text-xs text-ops-text-muted font-mono">{m.email}</div>
                </div>

                <RoleBadge role={m.role} />

                <span
                  className={`text-[10px] font-mono uppercase tracking-wide px-2 py-0.5 rounded ${
                    premium ? "bg-fitscript-green/15 text-fitscript-green" : "bg-ops-bg text-ops-text-muted"
                  }`}
                >
                  {m.entitlement}
                </span>

                <span className="text-xs text-ops-text-muted font-mono tabular-nums w-16 text-right">
                  {m.points ?? 0} pts
                </span>

                {/* actions */}
                <button
                  disabled={!!busy}
                  onClick={() =>
                    act(
                      `/api/ops/peptideu/members/${m.id}/entitlement`,
                      { entitlement: premium ? "free" : "premium" },
                      premium ? "Premium removed" : "Comped premium",
                    )
                  }
                  className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors ${
                    premium
                      ? "border-ops-border text-ops-text-muted hover:bg-ops-bg"
                      : "border-fitscript-green/40 text-fitscript-green hover:bg-fitscript-green/10"
                  } disabled:opacity-50`}
                >
                  {premium ? "Remove premium" : "Comp premium"}
                </button>

                <select
                  value={m.role}
                  disabled={!!busy}
                  onChange={(e) => act(`/api/ops/peptideu/members/${m.id}/role`, { role: e.target.value }, `Role → ${e.target.value}`)}
                  className="text-xs bg-ops-bg border border-ops-border rounded-lg px-2 py-1.5 text-ops-text focus:outline-none focus:border-[#5C7FFF] disabled:opacity-50 capitalize"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
