import { Route, Switch, Redirect } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { OpsLayout } from "./components/layout/ops-layout";
import { Component, type ReactNode } from "react";
import CommandCenter from "./pages/command-center";
import Members from "./pages/members";
import MemberDetail from "./pages/member-detail";
import Orders from "./pages/orders";
import Marketing from "./pages/marketing";
import Integrations from "./pages/integrations";
import Email from "./pages/email";
import EmailSend from "./pages/email-send";
import EmailCompose from "./pages/email-compose";
import EmailProfiles from "./pages/email-profiles";
import Content from "./pages/content";
import Settings from "./pages/settings";
import Leads from "./pages/leads";
import Login from "./pages/login";

interface Me {
  email: string;
}

function useAdminSession() {
  return useQuery<Me | null>({
    queryKey: ["ops-auth-me"],
    queryFn: async () => {
      const r = await fetch("/api/ops/auth/me");
      if (r.status === 401 || r.status === 403) return null;
      if (!r.ok) throw new Error("auth check failed");
      return r.json();
    },
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="p-8">
          <h2 className="text-lg font-bold text-red-400 mb-2">Something crashed</h2>
          <pre className="text-sm text-ops-text-muted bg-ops-surface p-4 rounded-lg overflow-auto">
            {this.state.error.message}{"\n"}{this.state.error.stack}
          </pre>
          <button onClick={() => { this.setState({ error: null }); window.location.href = "/"; }}
            className="mt-4 px-4 py-2 bg-brand-blue-500 text-white rounded-lg text-sm">
            Go Home
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const { data: me, isLoading } = useAdminSession();

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
    <OpsLayout adminEmail={me.email}>
      <ErrorBoundary>
        <Switch>
          <Route path="/" component={CommandCenter} />

          {/* Customers */}
          <Route path="/leads" component={Leads} />
          <Route path="/members" component={Members} />
          <Route path="/members/:id">{(params) => <MemberDetail id={params.id} />}</Route>
          <Route path="/orders" component={Orders} />

          {/* Growth */}
          <Route path="/marketing" component={Marketing} />
          <Route path="/content" component={Content} />
          <Route path="/email" component={Email} />
          <Route path="/email/send" component={EmailSend} />
          <Route path="/email/compose" component={EmailCompose} />
          <Route path="/email/profiles" component={EmailProfiles} />

          {/* System */}
          <Route path="/integrations" component={Integrations} />
          <Route path="/settings" component={Settings} />

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
