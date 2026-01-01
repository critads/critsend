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
  Settings,
  HelpCircle,
} from "lucide-react";
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
    title: "Test Metrics",
    url: "/test-metrics",
    icon: FlaskConical,
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

  return (
    <Sidebar 
      className="border-r-0 sidebar-gradient"
    >
      <SidebarHeader className="p-5 border-b border-sidebar-border">
        <Link href="/">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-sidebar-accent">
              <Send className="w-5 h-5 text-sidebar-foreground" />
            </div>
            <div className="flex flex-col">
              <span className="text-lg font-bold tracking-tight text-sidebar-foreground">critsend</span>
            </div>
          </div>
        </Link>
      </SidebarHeader>
      <SidebarContent className="px-3 py-4">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="space-y-0.5">
              {mainNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton 
                    asChild 
                    isActive={location === item.url}
                    className="h-10 rounded-lg transition-all duration-200 text-sidebar-foreground/80 hover:text-sidebar-foreground hover:bg-sidebar-accent data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-foreground"
                  >
                    <Link href={item.url} data-testid={`nav-${item.title.toLowerCase()}`}>
                      <item.icon className="w-5 h-5" />
                      <span className="font-medium">{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-6">
          <SidebarGroupLabel className="text-sidebar-foreground/40 text-xs font-medium uppercase tracking-wider mb-2 px-3">
            Configuration
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="space-y-0.5">
              {settingsNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton 
                    asChild 
                    isActive={location === item.url}
                    className="h-10 rounded-lg transition-all duration-200 text-sidebar-foreground/80 hover:text-sidebar-foreground hover:bg-sidebar-accent data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-foreground"
                  >
                    <Link href={item.url} data-testid={`nav-${item.title.toLowerCase()}`}>
                      <item.icon className="w-5 h-5" />
                      <span className="font-medium">{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-6">
          <SidebarGroupLabel className="text-sidebar-foreground/40 text-xs font-medium uppercase tracking-wider mb-2 px-3">
            Tools
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="space-y-0.5">
              {toolsNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton 
                    asChild 
                    isActive={location === item.url}
                    className="h-10 rounded-lg transition-all duration-200 text-sidebar-foreground/80 hover:text-sidebar-foreground hover:bg-sidebar-accent data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-foreground"
                  >
                    <Link href={item.url} data-testid={`nav-${item.title.toLowerCase().replace(' ', '-')}`}>
                      <item.icon className="w-5 h-5" />
                      <span className="font-medium">{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4 border-t border-sidebar-border">
        <div className="flex items-center gap-2 text-xs text-sidebar-foreground/50">
          <HelpCircle className="w-4 h-4" />
          <span>Help</span>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
