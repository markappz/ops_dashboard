import { Route, Switch, Redirect } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { OpsLayout } from "./components/layout/ops-layout";
import { Component, type ReactNode } from "react";
import CommandCenter from "./pages/command-center";
import Members from "./pages/members";
import MemberDetail from "./pages/member-detail";
import Orders from "./pages/orders";
import Labs from "./pages/labs";
import Supplements from "./pages/supplements";
import SupplementsDetail from "./pages/supplements-detail";
import LabsEdit from "./pages/labs-edit";
import LabsPanelEdit from "./pages/labs-panel-edit";
import LabsBuilder from "./pages/labs-builder";
import Marketing from "./pages/marketing";
import Integrations from "./pages/integrations";
import Email from "./pages/email";
import EmailSend from "./pages/email-send";
import EmailCompose from "./pages/email-compose";
import EmailProfiles from "./pages/email-profiles";
import Projects from "./pages/projects";
import Chat from "./pages/chat";
import ContentLibrary from "./pages/content-library";
import Tickets from "./pages/tickets";
import ReportsEmail from "./pages/reports-email";
import ReportsTraffic from "./pages/reports-traffic";
import ReportsConversions from "./pages/reports-conversions";
import ReportsSales from "./pages/reports-sales";
import ReportsAds from "./pages/reports-ads";
import ReportsDmarc from "./pages/reports-dmarc";
import Content, { CompanyContent } from "./pages/content";
import CompanyPages from "./pages/company-pages";
import RealPeptidesOverview from "./pages/realpeptides-overview";
import Settings from "./pages/settings";
import Leads from "./pages/leads";
import Login from "./pages/login";
import PeptideuOverview from "./pages/peptideu-overview";
import PeptideuMembers from "./pages/peptideu-members";
import PeptideuRequests from "./pages/peptideu-requests";
import PeptideuModeration from "./pages/peptideu-moderation";
import PeptideuDrawing from "./pages/peptideu-drawing";
import PeptideuCurriculum from "./pages/peptideu-curriculum";
import PeptideuEngagement from "./pages/peptideu-engagement";
import PeptideuQuestions from "./pages/peptideu-questions";
import PeptideuFeatures from "./pages/peptideu-features";
import PeptideuAp from "./pages/peptideu-ap";
import PeptideuLibrary from "./pages/peptideu-library";
import PawgenOrders from "./pages/pawgen-orders";
import PawgenOverview from "./pages/pawgen-overview";
import { CompanyTraffic, CompanySeo } from "./pages/company-google";
import CompanyIntegrations from "./pages/company-integrations";
import RealPeptidesPaid from "./pages/realpeptides-paid";
import RealPeptidesAffiliates from "./pages/realpeptides-affiliates";
import { SubTabs } from "./components/sub-tabs";
import { PawgenMarketing, PawgenLeads } from "./pages/pawgen-growth";
import { PeptideuEmail, PawgenEmail } from "./pages/brand-email";
import RealPeptidesLeads from "./pages/realpeptides-leads";
import RealPeptidesMarketing from "./pages/realpeptides-marketing";
import RealPeptidesCoa from "./pages/realpeptides-coa";
import RealPeptidesInventory from "./pages/realpeptides-inventory";
import RealPeptidesOrders from "./pages/realpeptides-orders";
import RealPeptidesEmail from "./pages/realpeptides-email";
import TasksBoard from "./pages/tasks-board";
import RealPeptidesWholesale from "./pages/realpeptides-wholesale";

const RP = { company: "realpeptides", label: "Real Peptides", domain: "realpeptides.co" } as const;

// Consolidated sidebar entries (2026-09-16): each merged tab keeps its members'
// URLs and renders them behind a SubTabs bar, so deep links never break.
const subTabs = (prefix: string) => ({
  seo: [
    { path: `/${prefix}/seo`, label: "SEO" },
    { path: `/${prefix}/content`, label: "Content" },
    { path: `/${prefix}/pages`, label: "Pages" },
  ],
  marketing: [
    { path: `/${prefix}/marketing`, label: "Marketing" },
    { path: `/${prefix}/traffic`, label: "Site Traffic" },
  ],
  email: [
    { path: `/${prefix}/email`, label: "Email" },
    { path: `/${prefix}/leads`, label: "Leads" },
  ],
});
const RP_TABS = subTabs("realpeptides");
const PAWGEN_TABS = subTabs("pawgen");
const PU_SEO_TABS = subTabs("peptideu").seo;
const PU = { company: "peptideu", label: "PeptideU", domain: "peptideu.com" } as const;

interface Me {
  email: string;
  role: "admin" | "viewer";
}

/**
 * Session check. Only a real 401/403 means "signed out". A 502 from the load balancer during a
 * deploy, a dropped connection, or HTML where JSON was expected used to resolve to no session
 * and bounce an admin to the sign-in page mid-task; now those retry and keep the last known
 * session while they do.
 */
function useAdminSession() {
  return useQuery<Me | null>({
    queryKey: ["ops-auth-me"],
    queryFn: async () => {
      const r = await fetch("/api/ops/auth/me", { credentials: "include" });
      if (r.status === 401 || r.status === 403) return null;
      if (!r.ok) throw new Error(`auth check failed (${r.status})`);
      return (await r.json()) as Me;
    },
    retry: 3,
    retryDelay: (n) => Math.min(1000 * 2 ** n, 8000),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  });
}

/** Errors that mean "this tab is running a bundle the server no longer has" - a reload fixes them. */
function isStaleBundleError(e: Error): boolean {
  return /Unexpected token '<'|is not valid JSON|Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError|Loading (CSS )?chunk/i.test(`${e.name} ${e.message}`);
}

function reloadOnceForStaleBundle(): boolean {
  try {
    const key = "ops-stale-reload";
    const last = Number(sessionStorage.getItem(key) || 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(key, String(Date.now()));
  } catch { /* storage unavailable - still reload */ }
  window.location.reload();
  return true;
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; details: boolean }> {
  state = { error: null as Error | null, details: false };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) {
    // Most crashes here happen in the minute after a deploy: the tab's bundle asks the new task
    // for something it answers differently (or the old task is still draining). One reload
    // picks up the current shell; the guard stops a reload loop if the crash is real.
    if (isStaleBundleError(error)) reloadOnceForStaleBundle();
  }
  render() {
    if (this.state.error) {
      const stale = isStaleBundleError(this.state.error);
      return (
        <div className="mx-auto max-w-xl p-8">
          <h2 className="mb-2 text-lg font-bold text-ops-text">{stale ? "The dashboard was just updated" : "This page hit an error"}</h2>
          <p className="text-sm text-ops-text-muted">
            {stale ? "Reload to pick up the new version." : "Reload the page. If it keeps happening, send the details below to Paul."}
          </p>
          <div className="mt-4 flex gap-2">
            <button onClick={() => window.location.reload()} className="rounded-lg bg-fitscript-green px-4 py-2 text-sm font-semibold text-white">Reload</button>
            <button onClick={() => { this.setState({ error: null, details: false }); window.location.href = "/"; }} className="rounded-lg border border-ops-border px-4 py-2 text-sm text-ops-text-muted">Go home</button>
            {!stale && <button onClick={() => this.setState({ details: !this.state.details })} className="rounded-lg px-3 py-2 text-sm text-ops-text-muted">{this.state.details ? "Hide details" : "Details"}</button>}
          </div>
          {this.state.details && (
            <pre className="mt-4 max-h-64 overflow-auto rounded-lg bg-ops-surface p-4 text-[11px] text-ops-text-muted">{this.state.error.message}{"\n"}{this.state.error.stack}</pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const { data: me, isLoading, isError, refetch } = useAdminSession();

  if (isError && !me) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-ops-bg text-sm text-ops-text-muted">
        <div>Can't reach the ops server right now. It usually comes back within a minute after a deploy.</div>
        <button onClick={() => refetch()} className="rounded-lg border border-ops-border px-3 py-1.5 text-ops-text">Try again</button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ops-bg text-ops-text-muted text-sm">
        Loading…
      </div>
    );
  }

  if (!me) {
    return <Login />;
  }

  return (
    <OpsLayout adminEmail={me.email} role={me.role}>
      <ErrorBoundary>
        <Switch>
          <Route path="/" component={CommandCenter} />

          {/* Customers */}
          <Route path="/leads" component={Leads} />
          <Route path="/members" component={Members} />
          <Route path="/members/:id">{(params) => <MemberDetail id={params.id} />}</Route>
          <Route path="/orders" component={Orders} />
          <Route path="/labs" component={Labs} />
          <Route path="/supplements" component={Supplements} />
          <Route path="/supplements/:id">{(params) => <SupplementsDetail id={params.id} />}</Route>
          <Route path="/labs/builder" component={LabsBuilder} />
          <Route path="/labs/mapping/:id">{(params) => <LabsEdit id={params.id} />}</Route>
          <Route path="/labs/panel/:slug">{(params) => <LabsPanelEdit slug={params.slug} />}</Route>

          {/* Growth */}
          <Route path="/marketing" component={Marketing} />
          <Route path="/content" component={Content} />
          <Route path="/pages">{() => <CompanyPages company="fitscript" label="FitScript" />}</Route>
          <Route path="/email" component={Email} />
          <Route path="/email/send" component={EmailSend} />
          <Route path="/email/compose" component={EmailCompose} />
          <Route path="/email/profiles" component={EmailProfiles} />

          {/* Reports */}
          <Route path="/reports/email" component={ReportsEmail} />
          <Route path="/reports/traffic" component={ReportsTraffic} />
          <Route path="/reports/conversions" component={ReportsConversions} />
          <Route path="/reports/sales" component={ReportsSales} />
          <Route path="/reports/ads" component={ReportsAds} />
          <Route path="/reports/dmarc" component={ReportsDmarc} />

          {/* Workspace */}
          <Route path="/projects" component={Projects} />
          <Route path="/chat" component={Chat} />
          <Route path="/content-library" component={ContentLibrary} />
          <Route path="/tickets" component={Tickets} />

          {/* System */}
          <Route path="/integrations" component={Integrations} />
          <Route path="/settings" component={Settings} />

          {/* PeptideU */}
          <Route path="/peptideu" component={PeptideuOverview} />
          <Route path="/peptideu/email" component={PeptideuEmail} />
          <Route path="/peptideu/members" component={PeptideuMembers} />
          <Route path="/peptideu/requests" component={PeptideuRequests} />
          <Route path="/peptideu/moderation" component={PeptideuModeration} />
          <Route path="/peptideu/drawing" component={PeptideuDrawing} />
          <Route path="/peptideu/questions" component={PeptideuQuestions} />
          <Route path="/peptideu/features" component={PeptideuFeatures} />
          <Route path="/peptideu/curriculum" component={PeptideuCurriculum} />
          <Route path="/peptideu/ap" component={PeptideuAp} />
          <Route path="/peptideu/library" component={PeptideuLibrary} />
          <Route path="/peptideu/engagement" component={PeptideuEngagement} />

          {/* pawgen */}
          <Route path="/pawgen" component={PawgenOverview} />
          <Route path="/pawgen/email">{() => <><SubTabs tabs={PAWGEN_TABS.email} /><PawgenEmail /></>}</Route>
          <Route path="/pawgen/orders" component={PawgenOrders} />
          <Route path="/pawgen/leads">{() => <><SubTabs tabs={PAWGEN_TABS.email} /><PawgenLeads /></>}</Route>
          <Route path="/pawgen/marketing">{() => <><SubTabs tabs={PAWGEN_TABS.marketing} /><PawgenMarketing /></>}</Route>
          <Route path="/pawgen/traffic">{() => <><SubTabs tabs={PAWGEN_TABS.marketing} /><CompanyTraffic company="pawgen" label="pawgen" domain="pawgen.com" /></>}</Route>
          <Route path="/pawgen/pages">{() => <><SubTabs tabs={PAWGEN_TABS.seo} /><CompanyPages company="pawgen" label="pawgen" /></>}</Route>
          <Route path="/pawgen/content">{() => <><SubTabs tabs={PAWGEN_TABS.seo} /><CompanyContent company="pawgen" label="pawgen" /></>}</Route>
          <Route path="/pawgen/seo">{() => <><SubTabs tabs={PAWGEN_TABS.seo} /><CompanySeo company="pawgen" label="pawgen" domain="pawgen.com" /></>}</Route>
          <Route path="/pawgen/integrations">{() => <CompanyIntegrations company="pawgen" label="pawgen" />}</Route>
          <Route path="/peptideu/traffic">{() => <CompanyTraffic {...PU} />}</Route>
          <Route path="/peptideu/seo">{() => <><SubTabs tabs={PU_SEO_TABS} /><CompanySeo {...PU} /></>}</Route>
          <Route path="/peptideu/pages">{() => <><SubTabs tabs={PU_SEO_TABS} /><CompanyPages company="peptideu" label="PeptideU" /></>}</Route>
          <Route path="/peptideu/content">{() => <><SubTabs tabs={PU_SEO_TABS} /><CompanyContent company="peptideu" label="PeptideU" /></>}</Route>
          <Route path="/peptideu/integrations">{() => <CompanyIntegrations company="peptideu" label="PeptideU" />}</Route>

          {/* Real Peptides — no Overview/Orders tab: WooCommerce isn't readable yet, and an
              overview with no revenue on it would just be a page of dashes. */}
          <Route path="/realpeptides" component={RealPeptidesOverview} />
          <Route path="/realpeptides/orders" component={RealPeptidesOrders} />
          <Route path="/realpeptides/tasks" component={TasksBoard} />
          <Route path="/realpeptides/email">{() => <><SubTabs tabs={RP_TABS.email} /><RealPeptidesEmail /></>}</Route>
          <Route path="/realpeptides/wholesale" component={RealPeptidesWholesale} />
          <Route path="/realpeptides/leads">{() => <><SubTabs tabs={RP_TABS.email} /><RealPeptidesLeads /></>}</Route>
          <Route path="/realpeptides/marketing">{() => <><SubTabs tabs={RP_TABS.marketing} /><RealPeptidesMarketing /></>}</Route>
          <Route path="/realpeptides/traffic">{() => <><SubTabs tabs={RP_TABS.marketing} /><CompanyTraffic {...RP} /></>}</Route>
          <Route path="/realpeptides/paid" component={RealPeptidesPaid} />
          <Route path="/realpeptides/affiliates" component={RealPeptidesAffiliates} />
          <Route path="/realpeptides/pages">{() => <><SubTabs tabs={RP_TABS.seo} /><CompanyPages company="realpeptides" label="Real Peptides" /></>}</Route>
          <Route path="/realpeptides/content">{() => <><SubTabs tabs={RP_TABS.seo} /><CompanyContent company="realpeptides" label="Real Peptides" /></>}</Route>
          <Route path="/realpeptides/seo">{() => <><SubTabs tabs={RP_TABS.seo} /><CompanySeo {...RP} /></>}</Route>
          <Route path="/realpeptides/coa" component={RealPeptidesCoa} />
          <Route path="/realpeptides/inventory" component={RealPeptidesInventory} />
          <Route path="/realpeptides/integrations">{() => <CompanyIntegrations company="realpeptides" label="Real Peptides" />}</Route>

          {/* Legacy redirects — Tracking absorbed into Marketing, Admin Log into Settings, Creative + Clinical hidden */}
          <Route path="/tracking"><Redirect to="/marketing" /></Route>
          <Route path="/admin-actions"><Redirect to="/settings" /></Route>
          <Route path="/creative"><Redirect to="/" /></Route>
          <Route path="/clinical"><Redirect to="/" /></Route>

          <Route>
            <div className="flex items-center justify-center h-[60vh] text-ops-text-muted">
              Not found
            </div>
          </Route>
        </Switch>
      </ErrorBoundary>
    </OpsLayout>
  );
}
