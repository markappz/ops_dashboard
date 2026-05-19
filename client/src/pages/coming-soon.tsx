import { Link } from "wouter";

interface PlannedSection {
  title: string;
  description: string;
  scope: string[];
  related?: Array<{ label: string; href: string; description: string }>;
}

const SECTIONS: Record<string, PlannedSection> = {
  "/content": {
    title: "Content & SEO",
    description:
      "Where blog posts, landing pages, and SEO ops live. Powered by the existing FitScript CMS system.",
    scope: [
      "Blog editor — create, schedule, and publish to fitscript.me/blog",
      "Location pages — auto-generate city-specific landing pages for SEO",
      "Topic spreadsheet — Clomark master prompt v4 content pipeline",
      "Search Console + GA4 surfaces — already wired in google-auth.ts",
      "Per-post engagement: views, organic source, conversion attribution",
    ],
    related: [
      {
        label: "Marketing",
        href: "/marketing",
        description: "Channel attribution and funnel — closest live surface today.",
      },
      {
        label: "Integrations",
        href: "/integrations",
        description: "Manage the Google Search Console / GA4 connection.",
      },
    ],
  },
  "/creative": {
    title: "Creative",
    description:
      "Centralized creative library. Generate product images, manage brand assets, and serve them to FitScript pages.",
    scope: [
      "Flux/Replicate image generation — already integrated for product photos",
      "Brand asset library — logos, hero shots, lifestyle photography",
      "Ad creative variants — track which images drive the highest CTR per channel",
      "Real customer image rotation (per project_fitscript_real_images memory)",
      "Image compliance check — no brand names on product imagery",
    ],
    related: [
      {
        label: "Marketing",
        href: "/marketing",
        description: "Channel performance — once Creative ships, link CTR back to creative variants.",
      },
    ],
  },
  "/clinical": {
    title: "Clinical",
    description:
      "Clinical operations: provider management, prescription pipeline, lab order ops, and the clinical-extraction work from Chris.",
    scope: [
      "Provider dashboard — active providers, license states, consultation queue",
      "Rx pipeline — pending / approved / shipped status across all Rx products",
      "Lab order operations — Junction pipeline status, USPS validation queue",
      "Clinical-extraction reviews — Chris's 6mo of practitioner Claude work",
      "Personalized-baseline modifiers — single-kidney, statin, athlete adjustments",
    ],
    related: [
      {
        label: "Orders",
        href: "/orders",
        description: "Current lab order log — clinical ops will deepen this surface.",
      },
      {
        label: "Members",
        href: "/members",
        description: "Per-member lab orders and clinical data live here today.",
      },
    ],
  },
};

export function ComingSoon({ path }: { path: keyof typeof SECTIONS | string }) {
  const section = SECTIONS[path];
  if (!section) {
    return (
      <div className="flex items-center justify-center h-[60vh] text-ops-text-muted">
        Coming soon
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-8">
        <div className="inline-block text-xs font-medium uppercase tracking-wider text-amber-300 bg-amber-500/10 border border-amber-500/30 px-2.5 py-0.5 rounded mb-3">
          Planned
        </div>
        <h1 className="text-2xl font-bold text-ops-text">{section.title}</h1>
        <p className="text-sm text-ops-text-muted mt-2">{section.description}</p>
      </div>

      <div className="bg-ops-surface border border-ops-border rounded-xl p-6 shadow-card mb-6">
        <h3 className="text-xs font-medium uppercase tracking-wider text-ops-text-muted mb-4">
          Planned scope
        </h3>
        <ul className="space-y-2">
          {section.scope.map((item, i) => (
            <li key={i} className="flex gap-3 text-sm text-ops-text">
              <span className="text-fitscript-green shrink-0">•</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>

      {section.related && section.related.length > 0 && (
        <div className="bg-ops-surface border border-ops-border rounded-xl p-6 shadow-card">
          <h3 className="text-xs font-medium uppercase tracking-wider text-ops-text-muted mb-4">
            Where to go in the meantime
          </h3>
          <div className="space-y-3">
            {section.related.map((r) => (
              <Link key={r.href} href={r.href}>
                <div className="flex items-start gap-3 p-3 -m-3 rounded-lg hover:bg-ops-surface-hover cursor-pointer transition-colors">
                  <div className="flex-1">
                    <div className="text-sm font-medium text-ops-text">{r.label} →</div>
                    <div className="text-xs text-ops-text-muted mt-0.5">{r.description}</div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ContentComingSoon() {
  return <ComingSoon path="/content" />;
}

export function CreativeComingSoon() {
  return <ComingSoon path="/creative" />;
}

export function ClinicalComingSoon() {
  return <ComingSoon path="/clinical" />;
}
