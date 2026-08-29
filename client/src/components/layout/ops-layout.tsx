import { Link, useLocation } from "wouter";
import { ReactNode, useEffect, useRef, useState } from "react";
import { useTheme } from "../../hooks/use-theme";
import { useCompany, type Company } from "../../hooks/use-company";
import logoWhite from "../../assets/fitscript-logo-white.png";
import { Dirt } from "../dirt/Dirt";

type NavItem = { path: string; label: string; icon: string };
type NavSection = { label: string; items: NavItem[] };

const COMPANY_ROOTS = new Set(["/", "/peptideu", "/pawgen", "/realpeptides"]);

const PEPTIDEU_NAV_SECTIONS: NavSection[] = [
  {
    label: "PeptideU",
    items: [
      { path: "/peptideu", label: "Overview", icon: "grid" },
      { path: "/peptideu/members", label: "Members", icon: "users" },
      { path: "/peptideu/requests", label: "Requests", icon: "file-text" },
      { path: "/peptideu/moderation", label: "Moderation", icon: "shield" },
      { path: "/peptideu/drawing", label: "Drawing", icon: "gift" },
      { path: "/peptideu/questions", label: "Questions", icon: "chat" },
      { path: "/peptideu/features", label: "Features", icon: "zap" },
      { path: "/peptideu/curriculum", label: "Curriculum", icon: "file-text" },
      { path: "/peptideu/ap", label: "AP Class", icon: "clipboard" },
      { path: "/peptideu/library", label: "Library Updates", icon: "flask" },
      { path: "/peptideu/engagement", label: "Engagement", icon: "chart" },
      { path: "/peptideu/content", label: "Content", icon: "file-text" },
      { path: "/peptideu/integrations", label: "Integrations", icon: "link" },
    ],
  },
];

const PAWGEN_NAV_SECTIONS: NavSection[] = [
  {
    label: "pawgen",
    items: [
      { path: "/pawgen", label: "Overview", icon: "grid" },
      { path: "/pawgen/orders", label: "Orders & Refunds", icon: "package" },
      { path: "/pawgen/leads", label: "Leads", icon: "funnel" },
      { path: "/pawgen/marketing", label: "Marketing", icon: "megaphone" },
      { path: "/pawgen/traffic", label: "Site Traffic", icon: "chart" },
      { path: "/pawgen/seo", label: "SEO", icon: "file-text" },
      { path: "/pawgen/content", label: "Content", icon: "file-text" },
      { path: "/pawgen/pages", label: "Pages", icon: "chart" },
      { path: "/pawgen/integrations", label: "Integrations", icon: "link" },
    ],
  },
];

const REALPEPTIDES_NAV_SECTIONS: NavSection[] = [
  {
    label: "Real Peptides",
    items: [
      { path: "/realpeptides", label: "Overview", icon: "grid" },
      { path: "/realpeptides/orders", label: "Orders", icon: "package" },
      { path: "/realpeptides/leads", label: "Leads", icon: "funnel" },
      { path: "/realpeptides/marketing", label: "Marketing", icon: "megaphone" },
      { path: "/realpeptides/traffic", label: "Site Traffic", icon: "chart" },
      { path: "/realpeptides/seo", label: "SEO", icon: "file-text" },
      { path: "/realpeptides/content", label: "Content", icon: "file-text" },
      { path: "/realpeptides/pages", label: "Pages", icon: "chart" },
      { path: "/realpeptides/coa", label: "COA Tracker", icon: "flask" },
      { path: "/realpeptides/inventory", label: "Inventory", icon: "package" },
      { path: "/realpeptides/integrations", label: "Integrations", icon: "link" },
    ],
  },
];

const NAV_SECTIONS: NavSection[] = [
  {
    label: "Overview",
    items: [{ path: "/", label: "Command Center", icon: "grid" }],
  },
  {
    label: "Customers",
    items: [
      { path: "/leads", label: "Leads", icon: "funnel" },
      { path: "/members", label: "Members", icon: "users" },
      { path: "/orders", label: "Orders", icon: "package" },
      { path: "/labs", label: "Labs", icon: "flask" },
      { path: "/supplements", label: "Supplements", icon: "pill" },
    ],
  },
  {
    label: "Growth",
    items: [
      { path: "/marketing", label: "Marketing", icon: "megaphone" },
      { path: "/content", label: "Content & SEO", icon: "file-text" },
      { path: "/pages", label: "Pages", icon: "chart" },
      { path: "/email", label: "Email", icon: "mail" },
    ],
  },
  {
    label: "Reports",
    items: [
      { path: "/reports/traffic", label: "Site Traffic", icon: "chart" },
      { path: "/reports/conversions", label: "Conversions", icon: "funnel" },
      { path: "/reports/email", label: "Email", icon: "mail" },
      { path: "/reports/sales", label: "Sales", icon: "dollar" },
      { path: "/reports/ads", label: "Ads & Attribution", icon: "megaphone" },
      { path: "/reports/dmarc", label: "DMARC", icon: "mail" },
    ],
  },
  {
    label: "Workspace",
    items: [
      { path: "/chat", label: "Chat", icon: "chat" },
      { path: "/projects", label: "Projects", icon: "clipboard" },
      { path: "/tickets", label: "Tech Tickets", icon: "bug" },
      { path: "/content-library", label: "Content Library", icon: "folder" },
    ],
  },
  {
    label: "System",
    items: [
      { path: "/integrations", label: "Integrations", icon: "link" },
      { path: "/settings", label: "Settings", icon: "settings" },
    ],
  },
];

const ICONS: Record<string, ReactNode> = {
  shield: <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M9 12.75L11.25 15 15 9.75M21 12c0 5.591-3.824 10.29-9 11.622C6.824 22.29 3 17.591 3 12V5.25a.75.75 0 01.53-.717 11.209 11.209 0 007.877-3.08.75.75 0 011.185 0 11.209 11.209 0 007.877 3.08.75.75 0 01.531.717V12z" /></svg>,
  gift: <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M21 11.25v8.25a1.5 1.5 0 01-1.5 1.5H5.25a1.5 1.5 0 01-1.5-1.5v-8.25M12 4.875A2.625 2.625 0 109.375 7.5H12m0-2.625V7.5m0-2.625A2.625 2.625 0 1114.625 7.5H12m0 0V21m-8.625-9.75h18c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125h-18c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" /></svg>,
  grid: <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" /></svg>,
  users: <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" /></svg>,
  megaphone: <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 110-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.657.38c-.551.318-1.26.117-1.527-.461a20.845 20.845 0 01-1.44-4.282m3.102.069a18.03 18.03 0 01-.59-4.59c0-1.586.205-3.124.59-4.59m0 9.18a23.848 23.848 0 018.835 2.535M10.34 6.66a23.847 23.847 0 008.835-2.535m0 0A23.74 23.74 0 0018.795 3m.38 1.125a23.91 23.91 0 011.014 5.395m-1.014 8.855c-.118.38-.245.754-.38 1.125m.38-1.125a23.91 23.91 0 001.014-5.395m0-3.46c.495.413.811 1.035.811 1.73 0 .695-.316 1.317-.811 1.73m0-3.46a24.347 24.347 0 010 3.46" /></svg>,
  mail: <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" /></svg>,
  "file-text": <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>,
  package: <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" /></svg>,
  flask: <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" /></svg>,
  pill: <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M10.5 20.5 20.5 10.5a4.95 4.95 0 0 0-7-7L3.5 13.5a4.95 4.95 0 0 0 7 7ZM8.5 8.5l7 7" /></svg>,
  link: <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-3.122a4.5 4.5 0 00-1.242-7.244l-4.5-4.5a4.5 4.5 0 00-6.364 6.364L5.25 9.75" /></svg>,
  settings: <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
  funnel: <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M3 4.5h18l-7 9v6l-4 2v-8L3 4.5z" /></svg>,
  clipboard: <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>,
  chat: <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>,
  folder: <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>,
  bug: <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a7 7 0 1114 0v3a7 7 0 11-14 0v-3zM5 12L3 14m2-2L3 10m16 2l2 2m-2-2l2-2" /></svg>,
  chart: <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" /></svg>,
  dollar: <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4" /></svg>,
};

async function logout() {
  await fetch("/api/ops/auth/logout", { method: "POST" });
  window.location.href = "/";
}

export function OpsLayout({
  children,
  adminEmail,
  role,
}: {
  children: ReactNode;
  adminEmail?: string;
  role?: "admin" | "viewer";
}) {
  const [location, navigate] = useLocation();
  const { theme, toggle } = useTheme();
  const { company, setCompany } = useCompany();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // The displayed company follows the URL so nav + content never disagree.
  const activeCompany: Company = location.startsWith("/peptideu")
    ? "peptideu"
    : location.startsWith("/pawgen")
      ? "pawgen"
      : location.startsWith("/realpeptides")
        ? "realpeptides"
        : "fitscript";
  const sections =
    activeCompany === "peptideu"
      ? PEPTIDEU_NAV_SECTIONS
      : activeCompany === "pawgen"
        ? PAWGEN_NAV_SECTIONS
        : activeCompany === "realpeptides"
          ? REALPEPTIDES_NAV_SECTIONS
          : NAV_SECTIONS;

  // Real Peptides has no overview page (no order data to head it), so its home is Leads.
  const companyHome = (c: Company) =>
    c === "peptideu" ? "/peptideu" : c === "pawgen" ? "/pawgen" : c === "realpeptides" ? "/realpeptides/leads" : "/";

  // On first load, honor the remembered company preference.
  const didRedirect = useRef(false);
  useEffect(() => {
    if (didRedirect.current) return;
    didRedirect.current = true;
    if (company !== "fitscript" && location === "/") navigate(companyHome(company));
  }, [company, location, navigate]);

  const selectCompany = (c: Company) => {
    setCompany(c);
    navigate(companyHome(c));
  };

  // Auto-close sidebar on route change (mobile)
  useEffect(() => {
    setSidebarOpen(false);
  }, [location]);

  return (
    <div className="flex h-screen brand-wash">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="lg:hidden fixed inset-0 z-30 bg-black/40 backdrop-blur-[2px]"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar — fixed slide-out on mobile, static column on lg+ */}
      <aside className={`fixed lg:static lg:translate-x-0 inset-y-0 left-0 z-40 w-64 bg-ops-surface border-r border-ops-border flex flex-col shrink-0 transition-transform duration-200 ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`}>
        {/* Logo */}
        <div className="h-16 flex items-center px-6 border-b border-ops-border gap-2.5">
          <img
            src={logoWhite}
            alt="FITSCRIPT"
            className="h-5 w-auto"
            style={theme === "light" ? { filter: "invert(1)" } : undefined}
          />
          <span className="text-[10px] tracking-[0.14em] uppercase text-ops-text-subtle font-semibold bg-ops-accent-soft px-1.5 py-0.5 rounded">
            Ops
          </span>
        </div>

        {/* Company switcher */}
        <div className="px-4 py-3 border-b border-ops-border">
          {/* 2×2 grid, not a row — a fourth brand in a 256px sidebar wraps the labels. */}
          <div className="grid grid-cols-2 bg-ops-bg rounded-lg p-1 gap-1">
            {([
              { key: "fitscript" as Company, label: "FitScript" },
              { key: "peptideu" as Company, label: "PeptideU" },
              { key: "pawgen" as Company, label: "pawgen" },
              { key: "realpeptides" as Company, label: "Real Peptides" },
            ]).map((o) => (
              <button
                key={o.key}
                onClick={() => selectCompany(o.key)}
                className={`w-full text-xs font-semibold py-1.5 rounded-md transition-all ${
                  activeCompany === o.key
                    ? "text-white bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 shadow-[0_4px_14px_-4px_rgba(46,91,255,0.5)]"
                    : "text-ops-text-muted hover:text-ops-text"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* Nav — grouped sections */}
        <nav className="flex-1 py-3 overflow-y-auto">
          {sections.map((section) => (
            <div key={section.label} className="mb-4">
              <div className="px-6 mb-1.5 text-[10px] tracking-[0.14em] uppercase font-semibold text-ops-text-subtle">
                {section.label}
              </div>
              {section.items.map((item) => {
                // A company root must match exactly, or every child route lights it up
                // too (/pawgen was already doing that — /pawgen/orders lit Overview).
                const isHome = COMPANY_ROOTS.has(item.path);
                const isActive = isHome ? location === item.path : location.startsWith(item.path);
                return (
                  <Link key={item.path} href={item.path}>
                    <div
                      className={`mx-3 px-3 py-2 my-0.5 rounded-lg flex items-center gap-3 text-sm cursor-pointer transition-all ${
                        isActive
                          ? "text-white bg-gradient-to-r from-brand-blue-600 to-brand-blue-500 shadow-[0_4px_14px_-4px_rgba(46,91,255,0.5)]"
                          : "text-ops-text-muted hover:text-ops-text hover:bg-ops-surface-hover"
                      }`}
                    >
                      <span className={isActive ? "opacity-100" : "opacity-70"}>
                        {ICONS[item.icon]}
                      </span>
                      <span className="font-medium">{item.label}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-ops-border">
          <div className="flex items-center gap-2 text-[11px] text-ops-text-subtle">
            <div className="w-1.5 h-1.5 rounded-full bg-brand-blue-400 animate-pulse" />
            <span>Ops · v1.0 · {theme === "dark" ? "Dark" : "Light"}</span>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto">
        {/* Top Bar */}
        <header className="h-16 border-b border-ops-border flex items-center justify-between gap-3 sm:gap-6 px-4 sm:px-8 bg-ops-surface/80 backdrop-blur-md sticky top-0 z-10">
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-2 -ml-2 rounded-lg hover:bg-ops-surface-hover text-ops-text-muted hover:text-ops-text"
              aria-label="Open menu"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
            <div className="text-sm font-medium text-ops-text-muted truncate">
              <span className="hidden sm:inline">{currentSectionLabel(location)}</span>
              <span className="hidden sm:inline mx-2 text-ops-text-subtle">/</span>
              <span className="text-ops-text">{currentPageLabel(location)}</span>
            </div>
          </div>

          {/* Center: Talk Dirt command bar */}
          <DirtCommandBar />

          <div className="flex items-center gap-3 shrink-0">
            <DirtNotifications />
            <div className="hidden sm:flex items-center gap-2 text-xs text-ops-text-muted px-2.5 py-1 rounded-full bg-ops-accent-soft">
              <div className="w-1.5 h-1.5 rounded-full bg-brand-blue-400 animate-pulse" />
              Live
            </div>
            <div className="w-px h-5 bg-ops-border hidden sm:block" />
            <button
              onClick={toggle}
              className="hidden sm:block p-2 rounded-lg hover:bg-ops-surface-hover transition-colors text-ops-text-muted hover:text-ops-text"
              title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            >
              {theme === "dark" ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" /></svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" /></svg>
              )}
            </button>
            {role === "viewer" && (
              <span
                className="hidden sm:inline text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-500/15 text-amber-500 border border-amber-500/30"
                title="Read-only access — you can view everything but cannot make changes"
              >
                Read-only
              </span>
            )}
            {adminEmail && (
              <>
                <div className="w-px h-5 bg-ops-border hidden sm:block" />
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-gradient-to-br from-brand-blue-500 to-brand-blue-600 flex items-center justify-center text-white text-xs font-semibold" title={adminEmail}>
                    {adminEmail[0]?.toUpperCase() || "?"}
                  </div>
                  <span className="hidden md:inline text-xs text-ops-text-muted truncate max-w-[160px]" title={adminEmail}>
                    {adminEmail}
                  </span>
                </div>
                <button
                  onClick={logout}
                  className="text-xs text-ops-text-muted hover:text-ops-text transition-colors"
                  title="Sign out"
                >
                  Sign out
                </button>
              </>
            )}
          </div>
        </header>

        {/* Page content */}
        <div className="p-4 sm:p-6 lg:p-8">{children}</div>
      </main>

      {/* DIRT — floating launcher + ⌘K + slide-out panel */}
      <Dirt />
    </div>
  );
}

const ALL_SECTIONS = [
  ...NAV_SECTIONS,
  ...PEPTIDEU_NAV_SECTIONS,
  ...PAWGEN_NAV_SECTIONS,
  ...REALPEPTIDES_NAV_SECTIONS,
];
const isHomePath = (p: string) => COMPANY_ROOTS.has(p);

function currentSectionLabel(path: string): string {
  for (const section of ALL_SECTIONS) {
    if (
      section.items.some((i) =>
        isHomePath(i.path) ? path === i.path : path.startsWith(i.path),
      )
    ) {
      return section.label;
    }
  }
  return "Ops";
}

function currentPageLabel(path: string): string {
  for (const section of ALL_SECTIONS) {
    for (const item of section.items) {
      if (isHomePath(item.path) ? path === item.path : path.startsWith(item.path)) {
        return item.label;
      }
    }
  }
  return "—";
}

/**
 * Bell icon + dropdown of proactive DIRT notifications. Polls every 60s.
 * Badge shows unread count.
 */
interface NotifItem {
  id: string;
  kind: string;
  severity: "info" | "warn" | "critical";
  title: string;
  body: string | null;
  metadata: Record<string, unknown> | null;
  dismissed_at: string | null;
  created_at: string;
}

function DirtNotifications() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotifItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [scanning, setScanning] = useState(false);

  const load = async () => {
    try {
      const r = await fetch("/api/ops/dirt/notifications");
      if (!r.ok) return;
      const j = await r.json();
      setItems(j.notifications || []);
      setUnread(j.unread || 0);
    } catch {}
  };

  useEffect(() => {
    load();
    const i = setInterval(load, 60_000);
    return () => clearInterval(i);
  }, []);

  const dismiss = async (id: string) => {
    await fetch(`/api/ops/dirt/notifications/${id}/dismiss`, { method: "PATCH" });
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, dismissed_at: new Date().toISOString() } : n)));
    setUnread((u) => Math.max(0, u - 1));
  };

  const scanNow = async () => {
    setScanning(true);
    try {
      await fetch("/api/ops/dirt/scan", { method: "POST" });
      await load();
    } finally {
      setScanning(false);
    }
  };

  const askDirt = (n: NotifItem) => {
    window.dispatchEvent(new CustomEvent("dirt:open", { detail: { prompt: `Tell me more about: ${n.title}` } }));
    setOpen(false);
  };

  const sevColor = (s: string) => ({
    critical: "text-red-400 bg-red-500/10 border-red-500/30",
    warn: "text-amber-500 bg-amber-500/10 border-amber-500/30",
    info: "text-brand-blue-500 bg-brand-blue-500/10 border-brand-blue-500/30",
  } as Record<string, string>)[s] || "text-ops-text-muted bg-ops-bg border-ops-border";

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative w-9 h-9 rounded-full bg-ops-bg border border-ops-border hover:bg-ops-surface-hover hover:border-brand-blue-400/40 transition-colors text-ops-text-muted hover:text-ops-text flex items-center justify-center"
        title="Proactive DIRT alerts"
      >
        <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-ops-surface animate-pulse">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="fixed sm:absolute top-16 sm:top-12 inset-x-2 sm:inset-x-auto sm:right-0 z-50 sm:w-[400px] max-h-[520px] overflow-y-auto bg-ops-surface border border-ops-border rounded-xl shadow-card-lg animate-dirt-slide-down">
            <div className="px-3 py-2.5 border-b border-ops-border flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-ops-text">Alerts</div>
                <div className="text-[10.5px] text-ops-text-subtle">Auto-scan every 15min</div>
              </div>
              <button
                onClick={scanNow}
                disabled={scanning}
                className="text-[11px] text-brand-blue-500 hover:text-brand-blue-600 disabled:opacity-50 font-medium px-2 py-1 rounded hover:bg-ops-surface-hover"
              >
                {scanning ? "Scanning…" : "Scan now"}
              </button>
            </div>
            {items.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-ops-text-muted">
                No alerts. DIRT will surface anomalies here as they happen.
              </div>
            ) : (
              items.map((n) => (
                <div
                  key={n.id}
                  className={`px-3 py-2.5 border-b border-ops-border last:border-0 transition-opacity ${n.dismissed_at ? "opacity-50" : ""}`}
                >
                  <div className="flex items-start gap-2">
                    <span className={`text-[9px] tracking-wider uppercase font-bold px-1.5 py-0.5 rounded border ${sevColor(n.severity)}`}>
                      {n.severity}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-semibold text-ops-text leading-tight">{n.title}</div>
                      {n.body && <div className="text-[11.5px] text-ops-text-muted mt-1">{n.body}</div>}
                      <div className="flex items-center gap-3 mt-1.5 text-[10.5px]">
                        <span className="text-ops-text-subtle">{relativeTime(n.created_at)} · {n.kind}</span>
                        {!n.dismissed_at && (
                          <>
                            <button onClick={() => askDirt(n)} className="text-brand-blue-500 hover:text-brand-blue-600 font-medium">
                              Ask DIRT
                            </button>
                            <button onClick={() => dismiss(n.id)} className="text-ops-text-muted hover:text-ops-text">
                              Dismiss
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Top-bar command input — types into DIRT directly. Press Enter to fire,
 * or ⌘K to open the full panel from anywhere. Focus when user clicks it,
 * fades into a subtle pill state when not focused.
 */
function DirtCommandBar() {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    if (!q) return;
    window.dispatchEvent(new CustomEvent("dirt:open", { detail: { prompt: q } }));
    setValue("");
    inputRef.current?.blur();
  };

  return (
    <form onSubmit={submit} className="flex-1 max-w-xl mx-auto hidden md:flex">
      <div className={`relative w-full transition-all duration-200 ${focused ? "scale-[1.01]" : ""}`}>
        <div
          aria-hidden
          className={`absolute -inset-px rounded-full bg-gradient-to-r from-brand-blue-500/30 via-brand-blue-400/30 to-brand-blue-500/30 transition-opacity blur ${focused ? "opacity-100" : "opacity-0"}`}
        />
        <div className="relative flex items-center gap-2 px-4 h-10 rounded-full bg-ops-bg border border-ops-border focus-within:border-brand-blue-500 focus-within:ring-2 focus-within:ring-brand-blue-500/20 transition-all">
          <svg className="w-4 h-4 text-brand-blue-500 shrink-0" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2l1.91 6.09L20 10l-6.09 1.91L12 18l-1.91-6.09L4 10l6.09-1.91L12 2z" />
          </svg>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            type="text"
            placeholder="Talk dirt… (or press ⌘K)"
            className="flex-1 bg-transparent border-0 outline-none text-sm text-ops-text placeholder-ops-text-subtle"
          />
          {value ? (
            <kbd className="text-[10px] font-mono text-brand-blue-500 bg-brand-blue-500/10 border border-brand-blue-500/30 px-1.5 py-0.5 rounded">↵</kbd>
          ) : (
            <kbd className="text-[10px] font-mono text-ops-text-subtle bg-ops-surface border border-ops-border px-1.5 py-0.5 rounded">⌘K</kbd>
          )}
        </div>
      </div>
    </form>
  );
}
