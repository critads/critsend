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
    title: "Subscribers",
    url: "/subscribers",
    icon: Users,
  },
  {
    title: "Segments",
    url: "/segments",
    icon: Filter,
  },
  {
    title: "Campaigns",
    url: "/campaigns",
    icon: Mail,
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
    <Sidebar className="border-r-0">
      <SidebarHeader className="p-5 border-b border-sidebar-border/50">
        <Link href="/">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-400 to-blue-500 shadow-lg shadow-cyan-500/20">
              <Send className="w-5 h-5 text-white" />
            </div>
            <div className="flex flex-col">
              <span className="text-lg font-bold tracking-tight text-sidebar-foreground">Critsend</span>
              <span className="text-xs text-sidebar-foreground/60">Email Marketing</span>
            </div>
          </div>
        </Link>
      </SidebarHeader>
      <SidebarContent className="px-3 py-4">
        <SidebarGroup>
          <SidebarGroupLabel className="text-sidebar-foreground/40 text-xs font-semibold uppercase tracking-wider mb-2">
            Main
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="space-y-1">
              {mainNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton 
                    asChild 
                    isActive={location === item.url}
                    className="h-10 rounded-lg transition-all duration-200"
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
          <SidebarGroupLabel className="text-sidebar-foreground/40 text-xs font-semibold uppercase tracking-wider mb-2">
            Configuration
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="space-y-1">
              {settingsNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton 
                    asChild 
                    isActive={location === item.url}
                    className="h-10 rounded-lg transition-all duration-200"
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
          <SidebarGroupLabel className="text-sidebar-foreground/40 text-xs font-semibold uppercase tracking-wider mb-2">
            Tools
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="space-y-1">
              {toolsNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton 
                    asChild 
                    isActive={location === item.url}
                    className="h-10 rounded-lg transition-all duration-200"
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
      <SidebarFooter className="p-4 border-t border-sidebar-border/50">
        <div className="flex items-center gap-2 text-xs text-sidebar-foreground/50">
          <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          <span>System Online</span>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
