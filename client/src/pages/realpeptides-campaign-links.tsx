import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { PageHero } from "../components/page-hero";
import { ui } from "./coa/api";

/**
 * Campaign link builder for the guide funnels (Paul, 2026-09-29). Michael's socials, and any
 * other source, get a UTM-tagged link per guide so /api/optin captures the source first-touch and
 * the site's channel classifier (analyticsChannels.ts) buckets them on Marketing ▸ Traffic.
 *
 * THE ONE LOAD-BEARING RULE: utm_medium=social is what routes a visitor into the "Social" channel
 * (paid_social/cpc still read as "Paid ads"). utm_source splits Social by platform, utm_campaign
 * by guide. Everything here is static — no API — so it can never break a fetch.
 */
// ❗ Links go to each site's /optin SQUEEZE page, never the root (Paul, 2026-10-01): the root
// SERVES the guide itself — a root link gives the guide away with no email captured.
const GUIDES = [
  { key: "fat-loss-bible", label: "Fat Loss Bible", base: "https://www.fatlossbible.co/optin" },
  { key: "hair-growth", label: "Hair Growth Protocol", base: "https://www.hairgrowthprotocol.com/optin" },
  { key: "peptide-101", label: "Peptide 101", base: "https://www.peptide101guide.com/optin" },
  { key: "sexual-health", label: "Sexual Health Guide", base: "https://sexualhealthguide.com/optin" },
];

const PLATFORMS = ["instagram", "tiktok", "youtube", "facebook", "x"];

// utm_medium options: the routing convention the site classifier reads.
const MEDIUMS = [
  { value: "social", label: "Social (organic — Michael's posts)", channel: "Social" },
  { value: "paid_social", label: "Paid social (boosted / Meta ads)", channel: "Paid ads" },
  { value: "email", label: "Email", channel: "Email" },
];

function buildLink(base: string, source: string, medium: string, campaign: string, content: string): string {
  const u = new URL(base);
  u.searchParams.set("utm_source", source);
  u.searchParams.set("utm_medium", medium);
  u.searchParams.set("utm_campaign", campaign);
  if (content.trim()) u.searchParams.set("utm_content", content.trim());
  return u.toString();
}

export default function RealPeptidesCampaignLinks() {
  const [source, setSource] = useState("instagram");
  const [medium, setMedium] = useState("social");
  const [content, setContent] = useState("michael");
  const [copied, setCopied] = useState<string | null>(null);

  const channel = MEDIUMS.find((m) => m.value === medium)?.channel ?? "Campaign (UTM)";

  async function copy(link: string, key: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      /* clipboard blocked — the field is selectable as a fallback */
    }
  }

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides · Marketing"
        title="Campaign links"
        subtitle="Tagged links for the guide funnels. Pick who's posting and where, then copy the link for each guide. Traffic shows up on Marketing ▸ Site Traffic under the channel below."
      />

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-4">
        <label className="text-sm">
          <span className="mb-1 block text-ops-text-muted">Platform (utm_source)</span>
          <select value={source} onChange={(e) => setSource(e.target.value)} className={ui.input}>
            {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-ops-text-muted">Type (utm_medium)</span>
          <select value={medium} onChange={(e) => setMedium(e.target.value)} className={ui.input}>
            {MEDIUMS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-ops-text-muted">Who / which post (utm_content)</span>
          <input value={content} onChange={(e) => setContent(e.target.value)} placeholder="michael" className={ui.input} />
        </label>
        <div className="flex flex-col justify-end text-sm">
          <span className="mb-1 block text-ops-text-muted">Shows up as</span>
          <span className="rounded-lg border border-ops-border bg-ops-bg px-3 py-2 font-semibold text-fitscript-green">{channel}</span>
        </div>
      </div>

      <div className="space-y-2">
        {GUIDES.map((g) => {
          const link = buildLink(g.base, source, medium, g.key, content);
          return (
            <div key={g.key} className="flex flex-wrap items-center gap-3 rounded-2xl border border-ops-border bg-ops-surface p-4 shadow-card">
              <div className="min-w-[150px]">
                <div className="font-semibold text-ops-text">{g.label}</div>
                <div className="text-[11px] text-ops-text-muted">utm_campaign={g.key}</div>
              </div>
              <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className={`flex-1 min-w-[240px] ${ui.input} font-mono text-xs`} />
              <button type="button" onClick={() => copy(link, g.key)} className={ui.primary}>
                {copied === g.key ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
              </button>
            </div>
          );
        })}
      </div>

      <div className="mt-6 rounded-2xl border border-ops-border bg-ops-surface p-4 text-sm text-ops-text-muted shadow-card">
        <p className="mb-2 font-semibold text-ops-text">How the tracking reads these</p>
        <ul className="list-disc space-y-1 pl-5">
          <li><b>utm_medium=social</b> is what puts a visitor in the <b>Social</b> channel — keep it exactly for Michael's organic posts.</li>
          <li><b>Paid social</b> (boosted posts, Meta ads) uses <b>paid_social</b> → counts as <b>Paid ads</b>, kept separate from organic.</li>
          <li><b>utm_source</b> splits Social by platform (Instagram vs TikTok…); <b>utm_content</b> tells whose post it was (e.g. michael).</li>
          <li>Attribution is <b>first-touch</b>: a lead is credited to the source that first brought them, even if they return later another way.</li>
          <li>Numbers land on <b>Marketing ▸ Site Traffic</b> and the per-order source tag once the visitor opts in or buys.</li>
        </ul>
      </div>
    </div>
  );
}
