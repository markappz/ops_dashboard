import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";
import { ModalPortal } from "../components/modal-portal";

interface ProfileSummary {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone_number: string | null;
  location: { city?: string; region?: string; country?: string } | null;
  created: string | null;
  updated: string | null;
  last_event_date: string | null;
  subscriptions: any;
}

interface ProfileDetail extends ProfileSummary {
  properties: Record<string, unknown>;
  predictive_analytics: any;
  klaviyo_url: string;
  lists: Array<{ id: string; name: string; created: string | null }>;
  events: Array<{
    id: string;
    datetime: string;
    metric: string;
    campaign_name: string | null;
    flow_id: string | null;
    value: number;
  }>;
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || isNaN(ms)) return "?";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function emailSubscriptionStatus(subs: any): {
  label: string;
  tone: "ok" | "warn" | "bad" | "muted";
} {
  const email = subs?.email?.marketing;
  if (!email) return { label: "—", tone: "muted" };
  const consent = email.consent ?? "?";
  const sup = email.suppression?.length > 0;
  if (sup) return { label: "Suppressed", tone: "bad" };
  if (consent === "SUBSCRIBED") return { label: "Subscribed", tone: "ok" };
  if (consent === "UNSUBSCRIBED") return { label: "Unsubscribed", tone: "warn" };
  if (consent === "NEVER_SUBSCRIBED") return { label: "Never subscribed", tone: "muted" };
  return { label: consent, tone: "muted" };
}

export default function EmailProfiles() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Per-email push state. Keys: email (lowercase). Values: 'pending' | 'ok' | 'error:<msg>'.
  const [pushState, setPushState] = useState<Record<string, string>>({});

  const pushOne = async (email: string, fitscriptUserId: string) => {
    const key = email.toLowerCase();
    setPushState((s) => ({ ...s, [key]: "pending" }));
    try {
      const r = await fetch("/api/ops/klaviyo/profiles/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, fitscriptUserId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setPushState((s) => ({ ...s, [key]: `error:${j.error || `HTTP ${r.status}`}` }));
        return;
      }
      setPushState((s) => ({ ...s, [key]: j.already_existed ? "ok:existed" : "ok:created" }));
      // After ~1s, refetch search results so the user moves from "RDS-only"
      // into the main Klaviyo profiles table.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["klaviyo-profile-search", debouncedQuery] });
      }, 1200);
    } catch (e: any) {
      setPushState((s) => ({ ...s, [key]: `error:${e.message}` }));
    }
  };

  const pushAll = async (users: Array<{ email: string; fitscript_user_id: string }>) => {
    const pending = users.filter((u) => !pushState[u.email.toLowerCase()]?.startsWith("ok"));
    if (pending.length === 0) return;
    if (pending.length > 1 && !confirm(`Push ${pending.length} users to Klaviyo? Each becomes a new Klaviyo profile and starts receiving marketing email per the active flows.`)) return;
    for (const u of pending) {
      await pushOne(u.email, u.fitscript_user_id);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const { data: searchData, isFetching } = useQuery<{
    profiles: ProfileSummary[];
    rds_only_users?: Array<{
      email: string;
      fitscript_user_id: string;
      first_name: string | null;
      last_name: string | null;
      created_at: string | null;
    }>;
    mode?: string;
    rds_matched?: number;
  }>({
    queryKey: ["klaviyo-profile-search", debouncedQuery],
    queryFn: () =>
      fetch(`/api/ops/klaviyo/profiles/search?q=${encodeURIComponent(debouncedQuery)}`).then((r) =>
        r.json(),
      ),
    enabled: debouncedQuery.length >= 3,
    staleTime: 1000 * 30,
  });

  const profiles = searchData?.profiles ?? [];
  const rdsOnly = searchData?.rds_only_users ?? [];

  return (
    <div>
      <PageHero
        eyebrow="Growth"
        title="Klaviyo profiles"
        subtitle="Search any subscriber by email. Inspect engagement, list memberships, and suppress / unsuppress directly."
      />

      <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card p-4 sm:p-5 mb-5">
        <label className="block text-[11px] font-semibold text-ops-text-muted uppercase tracking-wider mb-1.5">
          Search by email
        </label>
        <div className="flex gap-2 items-center">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="paulclotar@gmail.com or partial 'paul'"
            className="flex-1 bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-brand-blue-500"
            autoFocus
          />
          {query.length > 0 && query.length < 3 && (
            <span className="text-[11px] text-ops-text-subtle">3+ chars</span>
          )}
          {isFetching && <span className="text-[11px] text-ops-text-subtle">searching…</span>}
        </div>
      </div>

      {debouncedQuery.length >= 3 && (
        <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card overflow-hidden mb-5">
          <div className="px-4 py-3 border-b border-ops-border flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ops-text">
              {profiles.length} Klaviyo profile{profiles.length === 1 ? "" : "s"}
            </h3>
            {profiles.length === 25 && (
              <span className="text-[11px] text-ops-text-subtle">showing first 25 — refine search to narrow</span>
            )}
          </div>
          {profiles.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-ops-text-muted">
              No Klaviyo profiles match "{debouncedQuery}".
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-ops-text-muted border-b border-ops-border">
                    <th className="px-4 py-2 font-semibold">Email</th>
                    <th className="px-4 py-2 font-semibold">Name</th>
                    <th className="px-4 py-2 font-semibold">Status</th>
                    <th className="px-4 py-2 font-semibold">Last activity</th>
                    <th className="px-4 py-2 font-semibold w-0"></th>
                  </tr>
                </thead>
                <tbody>
                  {profiles.map((p) => {
                    const status = emailSubscriptionStatus(p.subscriptions);
                    const toneClass =
                      status.tone === "ok"
                        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                        : status.tone === "warn"
                          ? "bg-amber-500/10 text-amber-400 border-amber-500/30"
                          : status.tone === "bad"
                            ? "bg-red-500/10 text-red-400 border-red-500/30"
                            : "bg-ops-bg text-ops-text-muted border-ops-border";
                    return (
                      <tr
                        key={p.id}
                        className="border-b border-ops-border last:border-b-0 hover:bg-ops-surface-hover cursor-pointer transition-colors"
                        onClick={() => setSelectedId(p.id)}
                      >
                        <td className="px-4 py-3 text-ops-text">{p.email || "—"}</td>
                        <td className="px-4 py-3 text-ops-text-muted">
                          {[p.first_name, p.last_name].filter(Boolean).join(" ") || "—"}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded border ${toneClass}`}>
                            {status.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-ops-text-muted text-xs">
                          {fmtRelative(p.last_event_date)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedId(p.id);
                            }}
                            className="text-[11px] text-brand-blue-500 hover:text-brand-blue-600 font-semibold"
                          >
                            View →
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {debouncedQuery.length >= 3 && rdsOnly.length > 0 && (
        <div className="bg-ops-surface border border-amber-500/30 rounded-xl shadow-card overflow-hidden mb-5">
          <div className="px-4 py-3 border-b border-ops-border bg-amber-500/5 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-amber-400">
                {rdsOnly.length} FitScript user{rdsOnly.length === 1 ? "" : "s"} not yet in Klaviyo
              </h3>
              <p className="text-[11px] text-ops-text-subtle">
                exists in RDS, no Klaviyo profile — won't receive marketing email
              </p>
            </div>
            {rdsOnly.length > 1 && (
              <button
                onClick={() => pushAll(rdsOnly)}
                className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/40 text-amber-400 hover:bg-amber-500/25"
              >
                Push all to Klaviyo
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-ops-text-muted border-b border-ops-border">
                  <th className="px-4 py-2 font-semibold">Email</th>
                  <th className="px-4 py-2 font-semibold">Name</th>
                  <th className="px-4 py-2 font-semibold">FitScript signup</th>
                  <th className="px-4 py-2 font-semibold w-0"></th>
                </tr>
              </thead>
              <tbody>
                {rdsOnly.map((u) => {
                  const state = pushState[u.email.toLowerCase()];
                  return (
                    <tr key={u.fitscript_user_id} className="border-b border-ops-border last:border-b-0">
                      <td className="px-4 py-3 text-ops-text">{u.email}</td>
                      <td className="px-4 py-3 text-ops-text-muted">
                        {[u.first_name, u.last_name].filter(Boolean).join(" ") || "—"}
                      </td>
                      <td className="px-4 py-3 text-ops-text-muted text-xs">
                        {fmtRelative(u.created_at)}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {state === "pending" ? (
                          <span className="text-[11px] text-ops-text-subtle">Pushing…</span>
                        ) : state === "ok:created" ? (
                          <span className="text-[11px] text-emerald-400 font-semibold">✓ Created</span>
                        ) : state === "ok:existed" ? (
                          <span className="text-[11px] text-brand-blue-400 font-semibold">✓ Already in Klaviyo</span>
                        ) : state?.startsWith("error:") ? (
                          <span className="text-[11px] text-red-400" title={state.slice(6)}>✗ Failed</span>
                        ) : (
                          <button
                            onClick={() => pushOne(u.email, u.fitscript_user_id)}
                            className="text-[11px] font-semibold px-3 py-1 rounded bg-amber-500/15 border border-amber-500/40 text-amber-400 hover:bg-amber-500/25"
                          >
                            Push to Klaviyo
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!debouncedQuery && (
        <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card p-8 text-center">
          <div className="text-sm text-ops-text-muted">
            Type 3 or more characters to search Klaviyo profiles.
          </div>
        </div>
      )}

      {selectedId && (
        <ProfileDetailDrawer
          id={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function ProfileDetailDrawer({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const { data, isLoading, refetch } = useQuery<ProfileDetail>({
    queryKey: ["klaviyo-profile-detail", id],
    queryFn: () => fetch(`/api/ops/klaviyo/profiles/${id}`).then((r) => r.json()),
  });
  const [actionPending, setActionPending] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const status = useMemo(() => emailSubscriptionStatus(data?.subscriptions), [data]);
  const isSuppressed = status.label === "Suppressed";

  const doAction = async (action: "suppress" | "unsuppress") => {
    const verb = action === "suppress" ? "suppress" : "unsuppress";
    if (!confirm(`Are you sure you want to ${verb} ${data?.email}?`)) return;
    setActionPending(true);
    setActionMsg(null);
    try {
      const r = await fetch(`/api/ops/klaviyo/profiles/${id}/${action}`, {
        method: "POST",
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setActionMsg({ tone: "bad", text: j.error || `HTTP ${r.status}` });
      } else {
        setActionMsg({
          tone: "ok",
          text: `Queued ${verb} job in Klaviyo. Status updates within seconds.`,
        });
        setTimeout(() => refetch(), 3000);
      }
    } catch (e: any) {
      setActionMsg({ tone: "bad", text: e.message });
    } finally {
      setActionPending(false);
    }
  };

  return (
    <ModalPortal onClose={onClose}>
      <div
        className="bg-ops-surface border border-ops-border rounded-xl shadow-2xl w-full max-w-3xl max-h-[calc(100vh-2rem)] overflow-y-auto my-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-ops-border flex items-center justify-between sticky top-0 bg-ops-surface z-10">
          <h2 className="text-base font-bold text-ops-text">Profile detail</h2>
          <button
            onClick={onClose}
            className="text-ops-text-muted hover:text-ops-text text-xl leading-none"
          >
            ×
          </button>
        </div>

        {isLoading ? (
          <div className="px-5 py-12 text-center text-sm text-ops-text-muted">Loading…</div>
        ) : !data ? (
          <div className="px-5 py-12 text-center text-sm text-red-400">Failed to load profile.</div>
        ) : (
          <div className="px-5 py-4 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
              <div>
                <div className="text-lg font-bold text-ops-text">
                  {[data.first_name, data.last_name].filter(Boolean).join(" ") || "(no name)"}
                </div>
                <div className="text-sm text-ops-text-muted">{data.email}</div>
                <div className="text-[11px] text-ops-text-subtle mt-1">
                  Klaviyo ID: <span className="font-mono">{data.id}</span> · created {fmtRelative(data.created)}
                </div>
              </div>
              <div className="flex flex-col items-start sm:items-end gap-2">
                <span
                  className={`text-[10px] font-semibold px-2 py-0.5 rounded border ${
                    status.tone === "ok"
                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                      : status.tone === "warn"
                        ? "bg-amber-500/10 text-amber-400 border-amber-500/30"
                        : status.tone === "bad"
                          ? "bg-red-500/10 text-red-400 border-red-500/30"
                          : "bg-ops-bg text-ops-text-muted border-ops-border"
                  }`}
                >
                  {status.label}
                </span>
                <a
                  href={data.klaviyo_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-brand-blue-500 hover:text-brand-blue-600"
                >
                  Open in Klaviyo ↗
                </a>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <Cell label="Phone" value={data.phone_number || "—"} />
              <Cell
                label="Location"
                value={
                  data.location
                    ? [data.location.city, data.location.region, data.location.country]
                        .filter(Boolean)
                        .join(", ") || "—"
                    : "—"
                }
              />
              <Cell label="Last event" value={fmtRelative(data.last_event_date)} />
            </div>

            <div className="flex flex-wrap gap-2">
              {!isSuppressed ? (
                <button
                  onClick={() => doAction("suppress")}
                  disabled={actionPending}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-red-500/10 border border-red-500/40 text-red-400 hover:bg-red-500/20 disabled:opacity-50"
                >
                  {actionPending ? "Working…" : "Suppress"}
                </button>
              ) : (
                <button
                  onClick={() => doAction("unsuppress")}
                  disabled={actionPending}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-500/10 border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-50"
                >
                  {actionPending ? "Working…" : "Unsuppress"}
                </button>
              )}
            </div>

            {actionMsg && (
              <div
                className={`px-3 py-2 rounded-lg text-xs ${
                  actionMsg.tone === "ok"
                    ? "bg-brand-blue-500/10 text-brand-blue-500 border border-brand-blue-400/30"
                    : "bg-red-500/10 text-red-400 border border-red-500/30"
                }`}
              >
                {actionMsg.text}
              </div>
            )}

            <Section title={`Lists (${data.lists.length})`}>
              {data.lists.length === 0 ? (
                <div className="text-xs text-ops-text-muted">Not on any lists.</div>
              ) : (
                <ul className="space-y-1">
                  {data.lists.map((l) => (
                    <li key={l.id} className="text-xs flex items-baseline justify-between">
                      <span className="text-ops-text">{l.name}</span>
                      <span className="text-[10px] text-ops-text-subtle">added {fmtRelative(l.created)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title={`Recent events (${data.events.length})`}>
              {data.events.length === 0 ? (
                <div className="text-xs text-ops-text-muted">No recent events.</div>
              ) : (
                <ul className="space-y-1.5 max-h-80 overflow-y-auto">
                  {data.events.map((e) => (
                    <li key={e.id} className="text-xs flex items-baseline gap-2 border-b border-ops-border/40 pb-1.5 last:border-b-0">
                      <span className="text-[10px] text-ops-text-subtle min-w-[5rem]">
                        {fmtRelative(e.datetime)}
                      </span>
                      <span className="text-ops-text font-medium">{e.metric}</span>
                      {e.campaign_name && (
                        <span className="text-ops-text-muted truncate">· {e.campaign_name}</span>
                      )}
                      {e.value > 0 && (
                        <span className="text-emerald-400 ml-auto">${e.value.toFixed(2)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <TagsSection profileId={id} initialTags={Array.isArray((data.properties as any)?.tags) ? (data.properties as any).tags : []} onChanged={() => refetch()} />

            {Object.keys(data.properties || {}).length > 0 && (
              <Section title="Custom properties (raw)">
                <pre className="text-[10px] font-mono text-ops-text-muted bg-ops-bg border border-ops-border rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                  {JSON.stringify(data.properties, null, 2)}
                </pre>
              </Section>
            )}
          </div>
        )}
      </div>
    </ModalPortal>
  );
}

function TagsSection({
  profileId,
  initialTags,
  onChanged,
}: {
  profileId: string;
  initialTags: string[];
  onChanged: () => void;
}) {
  const [tags, setTags] = useState<string[]>(initialTags);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  // Re-seed when parent profile data changes (e.g. refetch after add/remove)
  const initialJoin = initialTags.join("\x00");
  useMemo(() => {
    setTags(initialTags);
  }, [initialJoin]);

  const persist = async (next: string[]) => {
    setSaving(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/ops/klaviyo/profiles/${profileId}/tags`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tags: next }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setMsg({ tone: "bad", text: j.error || `HTTP ${r.status}` });
        return false;
      }
      setTags(j.tags ?? next);
      onChanged();
      return true;
    } catch (e: any) {
      setMsg({ tone: "bad", text: e.message });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const addTag = async () => {
    const t = input.trim().toLowerCase();
    if (!t) return;
    if (tags.includes(t)) {
      setInput("");
      return;
    }
    if (!/^[a-z0-9_-][a-z0-9_-\s]{0,49}$/.test(t)) {
      setMsg({ tone: "bad", text: "Tag must be a-z 0-9 _ - (max 50 chars)" });
      return;
    }
    const next = [...tags, t].slice(0, 30);
    setInput("");
    await persist(next);
  };

  const removeTag = async (t: string) => {
    await persist(tags.filter((x) => x !== t));
  };

  return (
    <Section title="Tags">
      <div className="flex flex-wrap gap-1.5 mb-2">
        {tags.length === 0 ? (
          <span className="text-[11px] text-ops-text-subtle italic">No tags yet</span>
        ) : (
          tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 text-[11px] font-medium bg-brand-blue-500/15 text-brand-blue-400 border border-brand-blue-400/30 rounded px-2 py-0.5">
              {t}
              <button
                onClick={() => removeTag(t)}
                disabled={saving}
                className="hover:text-red-400 disabled:opacity-50"
                title="Remove tag"
              >
                ✕
              </button>
            </span>
          ))
        )}
      </div>
      <div className="flex gap-1.5">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
          placeholder="add a tag (e.g. vip, beta, churn-risk)"
          disabled={saving || tags.length >= 30}
          className="flex-1 bg-ops-bg border border-ops-border rounded px-2 py-1 text-[11px] text-ops-text focus:outline-none focus:border-brand-blue-500"
        />
        <button
          onClick={addTag}
          disabled={saving || !input.trim()}
          className="text-[11px] font-semibold px-3 py-1 rounded bg-brand-blue-500/15 border border-brand-blue-400/40 text-brand-blue-500 hover:bg-brand-blue-500/25 disabled:opacity-40"
        >
          {saving ? "…" : "Add"}
        </button>
      </div>
      {msg && (
        <div className={`mt-1.5 text-[10px] ${msg.tone === "ok" ? "text-brand-blue-500" : "text-red-400"}`}>
          {msg.text}
        </div>
      )}
    </Section>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ops-bg border border-ops-border rounded-lg px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-ops-text-subtle mb-0.5">{label}</div>
      <div className="text-ops-text">{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-ops-bg border border-ops-border rounded-lg p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ops-text-muted mb-2">
        {title}
      </div>
      {children}
    </div>
  );
}
