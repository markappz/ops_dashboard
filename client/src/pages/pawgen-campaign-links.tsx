import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { PageHero } from "../components/page-hero";
import { ui } from "./coa/api";

/**
 * Campaign link builder for pawgen (Michael via Paul, 2026-10-01: "he needs utms for pawgen,
 * just like we set up for the guides"). pawgen's first-touch capture (lib/attribution.ts on the
 * site) reads utm_source / utm_medium / utm_campaign on the FIRST page a visitor hits and stamps
 * them on every lead (ref_*) and order - but a bare pawgen.com link from a DM or bio arrives
 * with no referrer at all, which is why social signups read "direct / untagged". These links fix
 * that at the source.
 */
const DESTINATIONS = [
  { key: "home", label: "Home (guide + 10% capture)", base: "https://pawgen.com/" },
  { key: "k9-offer", label: "K9-REPAIR offer page", base: "https://pawgen.com/k9-offer" },
  { key: "products", label: "Products", base: "https://pawgen.com/products" },
  { key: "dosing-guide", label: "Dosing guide", base: "https://pawgen.com/dosing-guide" },
  { key: "blog", label: "Blog", base: "https://pawgen.com/blog" },
];

const PLATFORMS = ["instagram", "facebook", "x", "tiktok", "youtube", "dm"];

const MEDIUMS = [
  { value: "social", label: "Social (organic posts)" },
  { value: "dm", label: "DM (direct messages)" },
  { value: "bio", label: "Bio link" },
  { value: "paid_social", label: "Paid social (boosted / ads)" },
  { value: "email", label: "Email" },
];

function buildLink(base: string, source: string, medium: string, campaign: string, content: string): string {
  const u = new URL(base);
  u.searchParams.set("utm_source", source);
  u.searchParams.set("utm_medium", medium);
  u.searchParams.set("utm_campaign", campaign.trim() || "social");
  if (content.trim()) u.searchParams.set("utm_content", content.trim());
  return u.toString();
}

export default function PawgenCampaignLinks() {
  const [source, setSource] = useState("instagram");
  const [medium, setMedium] = useState("social");
  const [campaign, setCampaign] = useState("social");
  const [content, setContent] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

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
        eyebrow="pawgen · Marketing"
        title="Campaign links"
        subtitle="Tagged pawgen links for the social team. Pick platform and type, name the campaign, then copy a link per destination. Signups and orders from these links show their source on Email ▸ Leads and the campaign bars here on Marketing."
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
          <span className="mb-1 block text-ops-text-muted">Campaign (utm_campaign)</span>
          <input value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="e.g. bromantane-wave, jake-paul" className={ui.input} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-ops-text-muted">Who / which post (utm_content)</span>
          <input value={content} onChange={(e) => setContent(e.target.value)} placeholder="optional" className={ui.input} />
        </label>
      </div>

      <div className="space-y-2">
        {DESTINATIONS.map((d) => {
          const link = buildLink(d.base, source, medium, campaign, content);
          return (
            <div key={d.key} className="flex flex-wrap items-center gap-3 rounded-2xl border border-ops-border bg-ops-surface p-4 shadow-card">
              <div className="min-w-[210px]">
                <div className="font-semibold text-ops-text">{d.label}</div>
                <div className="text-[11px] text-ops-text-muted">{d.base.replace("https://", "")}</div>
              </div>
              <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className={`flex-1 min-w-[240px] ${ui.input} font-mono text-xs`} />
              <button type="button" onClick={() => copy(link, d.key)} className={ui.primary}>
                {copied === d.key ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
              </button>
            </div>
          );
        })}
      </div>

      <div className="mt-6 rounded-2xl border border-ops-border bg-ops-surface p-4 text-sm text-ops-text-muted shadow-card">
        <p className="mb-2 font-semibold text-ops-text">Why DM signups read &ldquo;direct / untagged&rdquo; today</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>In-app browsers (IG, FB, X DMs) strip the referrer, so a bare pawgen.com link carries nothing to attribute.</li>
          <li>These links put the source IN the URL — the site stamps it <b>first-touch</b> on the visitor and keeps it on every lead and order, even if they come back directly later.</li>
          <li><b>utm_source</b> = platform · <b>utm_medium</b> = how it was shared · <b>utm_campaign</b> = the push (e.g. bromantane-wave) · <b>utm_content</b> = whose post.</li>
          <li>Results land on <b>Email ▸ Leads</b> (first-touch + campaign bars) and <b>Marketing</b> (revenue by source/campaign). Google Analytics reads the same tags.</li>
        </ul>
      </div>
    </div>
  );
}
