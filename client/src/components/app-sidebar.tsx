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
    <Sidebar className="border-r border-sidebar-border sidebar-glow">
      <SidebarHeader className="p-4 pb-6">
        <Link href="/">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-8 h-8 rounded-md bg-primary">
              <Send className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="text-base font-semibold text-foreground">critsend</span>
          </div>
        </Link>
      </SidebarHeader>
      
      <SidebarContent className="px-3">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="space-y-0.5">
              {mainNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton 
                    asChild 
                    isActive={location === item.url}
                    className="h-9 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground data-[active=true]:font-medium"
                  >
                    <Link href={item.url} data-testid={`nav-${item.title.toLowerCase()}`}>
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
                    className="h-9 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground data-[active=true]:font-medium"
                  >
                    <Link href={item.url} data-testid={`nav-${item.title.toLowerCase()}`}>
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
      
      <SidebarFooter className="p-3 mt-auto">
        <div className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground cursor-pointer px-2 py-1.5 rounded-md hover:bg-accent transition-colors">
          <HelpCircle className="w-4 h-4" />
          <span>Help & Support</span>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
