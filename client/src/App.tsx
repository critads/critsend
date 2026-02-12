import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import AuthPage from "@/pages/auth";
import { useAuth } from "@/hooks/use-auth";
import { Loader2 } from "lucide-react";

import Dashboard from "@/pages/dashboard";
import Subscribers from "@/pages/subscribers";
import Segments from "@/pages/segments";
import MTAs from "@/pages/mtas";
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
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/subscribers" component={Subscribers} />
      <Route path="/segments" component={Segments} />
      <Route path="/mtas" component={MTAs} />
      <Route path="/campaigns" component={Campaigns} />
      <Route path="/campaigns/new" component={CampaignNew} />
      <Route path="/campaigns/:id/edit" component={CampaignEdit} />
      <Route path="/campaigns/:id" component={CampaignDetail} />
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
      <Route component={NotFound} />
    </Switch>
  );
}

function AuthenticatedApp() {
  const sidebarStyle = {
    "--sidebar-width": "14rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <SidebarProvider style={sidebarStyle as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1 min-w-0 bg-background">
          <header className="flex items-center justify-between gap-4 h-12 px-6 bg-card border-b border-border sticky top-0 z-50">
            <SidebarTrigger data-testid="button-sidebar-toggle" className="text-muted-foreground hover:text-foreground" />
            <ThemeToggle />
          </header>
          <main className="flex-1 overflow-auto">
            <Router />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

function AppContent() {
  const { isLoading, isAuthenticated } = useAuth();

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
