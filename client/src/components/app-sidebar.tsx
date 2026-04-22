import { useLocation, Link } from "wouter";
import {
  LayoutDashboard,
  Users,
  Filter,
  Server,
  Mail,
  BarChart3,
  FileCode,
  Upload,
  Download,
  Send,
  AlertCircle,
  FlaskConical,
  Flame,
  Workflow,
  Settings,
  HelpCircle,
  LogOut,
  Database,
} from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";

const mainNavItems = [
  {
    title: "Dashboard",
    url: "/",
    icon: LayoutDashboard,
  },
  {
    title: "Campaigns",
    url: "/campaigns",
    icon: Mail,
  },
  {
    title: "Subscribers",
    url: "/subscribers",
    icon: Users,
  },
  {
    title: "Segments",
    url: "/segments",
    icon: Filter,
  },
];

const settingsNavItems = [
  {
    title: "MTAs",
    url: "/mtas",
    icon: Server,
  },
  {
    title: "Email Headers",
    url: "/headers",
    icon: FileCode,
  },
  {
    title: "Analytics",
    url: "/analytics",
    icon: BarChart3,
  },
  {
    title: "Advanced Analytics",
    url: "/advanced-analytics",
    icon: BarChart3,
  },
  {
    title: "Test Metrics",
    url: "/test-metrics",
    icon: FlaskConical,
  },
  {
    title: "IP Warmup",
    url: "/warmup",
    icon: Flame,
  },
  {
    title: "Automation",
    url: "/automation",
    icon: Workflow,
  },
  {
    title: "Database Health",
    url: "/database-health",
    icon: Database,
  },
];

const toolsNavItems = [
  {
    title: "Import",
    url: "/import",
    icon: Upload,
  },
  {
    title: "Export",
    url: "/export",
    icon: Download,
  },
  {
    title: "Error Logs",
    url: "/error-logs",
    icon: AlertCircle,
  },
  {
    title: "API Docs",
    url: "/api-docs",
    icon: FileCode,
  },
];

export function AppSidebar() {
  const [location] = useLocation();
  const { toast } = useToast();

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Signed out", description: "You have been logged out." });
    } catch {
      toast({ title: "Error", description: "Logout failed", variant: "destructive" });
    }
  };

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader className="p-4 pb-6 group-data-[collapsible=icon]:p-2 group-data-[collapsible=icon]:pb-3">
        <Link href="/">
          <div className="flex items-center gap-2.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0">
            <div className="flex items-center justify-center w-8 h-8 rounded-md bg-primary shrink-0">
              <Send className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="text-base font-semibold text-foreground group-data-[collapsible=icon]:hidden">critsend</span>
          </div>
        </Link>
      </SidebarHeader>
      
      <SidebarContent className="px-3 group-data-[collapsible=icon]:px-0">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="space-y-0.5">
              {mainNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton 
                    asChild 
                    isActive={location === item.url}
                    tooltip={item.title}
                    className="h-9 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground data-[active=true]:font-medium"
                  >
                    <Link href={item.url} data-testid={`nav-${item.title.toLowerCase().replace(/\s+/g, '-')}`}>
                      <item.icon className="w-4 h-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-6">
          <SidebarGroupLabel className="text-muted-foreground/60 text-[11px] font-medium uppercase tracking-wider mb-1.5 px-2">
            Configuration
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="space-y-0.5">
              {settingsNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton 
                    asChild 
                    isActive={location === item.url}
                    tooltip={item.title}
                    className="h-9 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground data-[active=true]:font-medium"
                  >
                    <Link href={item.url} data-testid={`nav-${item.title.toLowerCase().replace(/\s+/g, '-')}`}>
                      <item.icon className="w-4 h-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-6">
          <SidebarGroupLabel className="text-muted-foreground/60 text-[11px] font-medium uppercase tracking-wider mb-1.5 px-2">
            Tools
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="space-y-0.5">
              {toolsNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton 
                    asChild 
                    isActive={location === item.url}
                    tooltip={item.title}
                    className="h-9 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground data-[active=true]:font-medium"
                  >
                    <Link href={item.url} data-testid={`nav-${item.title.toLowerCase().replace(' ', '-')}`}>
                      <item.icon className="w-4 h-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      
      <SidebarFooter className="p-3 mt-auto group-data-[collapsible=icon]:p-2">
        <SidebarMenu className="space-y-0.5">
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Help & Support"
              className="h-9 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              <HelpCircle className="w-4 h-4" />
              <span>Help & Support</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={handleLogout}
              tooltip="Sign Out"
              data-testid="button-logout"
              className="h-9 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              <LogOut className="w-4 h-4" />
              <span>Sign Out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
