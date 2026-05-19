import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { CrextioLayout } from "@/components/crextio-layout";
import { BugReportButton } from "@/components/bug-report-button";
import AuthPage from "@/pages/auth";
import ResetPasswordPage from "@/pages/reset-password";
import { useAuth } from "@/hooks/use-auth";
import { Loader2 } from "lucide-react";

import Dashboard from "@/pages/dashboard";
import Subscribers from "@/pages/subscribers";
import Segments from "@/pages/segments";
import SegmentNew from "@/pages/segment-new";
import SegmentEdit from "@/pages/segment-edit";
import MTAs from "@/pages/mtas";
import MtaNew from "@/pages/mta-new";
import MtaEdit from "@/pages/mta-edit";
import Campaigns from "@/pages/campaigns";
import CampaignNew from "@/pages/campaign-new";
import CampaignEdit from "@/pages/campaign-edit";
import CampaignDetail from "@/pages/campaign-detail";
import Import from "@/pages/import";
import Export from "@/pages/export";
import Analytics from "@/pages/analytics";
import Headers from "@/pages/headers";
import ApiDocs from "@/pages/api-docs";
import ErrorLogs from "@/pages/error-logs";
import TestMetrics from "@/pages/test-metrics";
import Warmup from "@/pages/warmup";
import Automation from "@/pages/automation";
import AdvancedAnalytics from "@/pages/advanced-analytics";
import DatabaseHealth from "@/pages/database-health";
import SystemMetrics from "@/pages/system-metrics";
import CampaignQueue from "@/pages/campaign-queue";
import AdminPressureQueue from "@/pages/admin-pressure-queue";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/subscribers" component={Subscribers} />
      <Route path="/segments" component={Segments} />
      <Route path="/segments/new" component={SegmentNew} />
      <Route path="/segments/:id" component={SegmentEdit} />
      <Route path="/mtas" component={MTAs} />
      <Route path="/mtas/new" component={MtaNew} />
      <Route path="/mtas/:id/edit" component={MtaEdit} />
      <Route path="/campaigns" component={Campaigns} />
      <Route path="/campaigns/new" component={CampaignNew} />
      <Route path="/campaigns/:id/edit" component={CampaignEdit} />
      <Route path="/campaigns/:id/queue" component={CampaignQueue} />
      <Route path="/campaigns/:id" component={CampaignDetail} />
      <Route path="/admin/pressure-queue" component={AdminPressureQueue} />
      <Route path="/import" component={Import} />
      <Route path="/export" component={Export} />
      <Route path="/analytics" component={Analytics} />
      <Route path="/analytics/:id" component={Analytics} />
      <Route path="/headers" component={Headers} />
      <Route path="/api-docs" component={ApiDocs} />
      <Route path="/error-logs" component={ErrorLogs} />
      <Route path="/test-metrics" component={TestMetrics} />
      <Route path="/warmup" component={Warmup} />
      <Route path="/automation" component={Automation} />
      <Route path="/advanced-analytics" component={AdvancedAnalytics} />
      <Route path="/database-health" component={DatabaseHealth} />
      <Route path="/system-metrics" component={SystemMetrics} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AuthenticatedApp() {
  return (
    <>
      <CrextioLayout>
        <Router />
      </CrextioLayout>
      <BugReportButton />
    </>
  );
}

function AppContent() {
  const { isLoading, isAuthenticated } = useAuth();
  const [location] = useLocation();

  if (location.startsWith("/reset-password")) {
    return <ResetPasswordPage />;
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen" data-testid="loading-spinner">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <AuthPage />;
  }

  return <AuthenticatedApp />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <AppContent />
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
