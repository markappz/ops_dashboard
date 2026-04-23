import { Route, Switch } from "wouter";
import { OpsLayout } from "./components/layout/ops-layout";
import { Component, type ReactNode } from "react";
import CommandCenter from "./pages/command-center";
import Members from "./pages/members";
import MemberDetail from "./pages/member-detail";
import Orders from "./pages/orders";
import Tracking from "./pages/tracking";
import Marketing from "./pages/marketing";
import Integrations from "./pages/integrations";

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
            className="mt-4 px-4 py-2 bg-fitscript-green text-white rounded-lg text-sm">
            Go Home
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <OpsLayout>
      <ErrorBoundary>
        <Switch>
          <Route path="/" component={CommandCenter} />
          <Route path="/members" component={Members} />
          <Route path="/members/:id">{(params) => <MemberDetail id={params.id} />}</Route>
          <Route path="/orders" component={Orders} />
          <Route path="/tracking" component={Tracking} />
          <Route path="/marketing" component={Marketing} />
          <Route path="/integrations" component={Integrations} />
          <Route path="/settings" component={Integrations} />
          <Route>
            <div className="flex items-center justify-center h-[60vh] text-ops-text-muted">
              Coming soon
            </div>
          </Route>
        </Switch>
      </ErrorBoundary>
    </OpsLayout>
  );
}
