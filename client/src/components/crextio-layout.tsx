import { ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Bell,
  Settings,
  LogOut,
  HelpCircle,
  Sun,
  Moon,
  Monitor,
  MoreHorizontal,
  Send,
  Menu,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/components/theme-provider";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface NavItem {
  title: string;
  url: string;
}

const PRIMARY_NAV: NavItem[] = [
  { title: "Dashboard", url: "/" },
  { title: "Campaigns", url: "/campaigns" },
  { title: "Subscribers", url: "/subscribers" },
  { title: "Segments", url: "/segments" },
  { title: "Analytics", url: "/analytics" },
  { title: "MTAs", url: "/mtas" },
  { title: "Automation", url: "/automation" },
];

const OVERFLOW_NAV: NavItem[] = [
  { title: "Import", url: "/import" },
  { title: "Export", url: "/export" },
  { title: "Email Headers", url: "/headers" },
  { title: "Advanced Analytics", url: "/advanced-analytics" },
  { title: "Test Metrics", url: "/test-metrics" },
  { title: "IP Warmup", url: "/warmup" },
  { title: "Database Health", url: "/database-health" },
  { title: "System Metrics", url: "/system-metrics" },
  { title: "Pressure Queue", url: "/admin/pressure-queue" },
  { title: "Error Logs", url: "/error-logs" },
  { title: "API Docs", url: "/api-docs" },
];

function isActive(location: string, url: string): boolean {
  if (url === "/") return location === "/";
  return location === url || location.startsWith(url + "/");
}

function navTestId(title: string): string {
  return `link-nav-${title.toLowerCase().replace(/\s+/g, "-")}`;
}

export function CrextioLayout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { user } = useAuth();
  const { theme, setTheme } = useTheme();
  const { toast } = useToast();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const overflowActive = OVERFLOW_NAV.some((i) => isActive(location, i.url));

  const username = user?.username ?? "there";
  const displayName = username.charAt(0).toUpperCase() + username.slice(1);

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
    <div className="min-h-screen bg-stone-200/60 dark:bg-zinc-900 p-3 lg:p-5">
      <div
        className="max-w-[1600px] mx-auto rounded-[2rem] shadow-2xl overflow-hidden"
        style={{
          background:
            "linear-gradient(135deg, #faf6ec 0%, #f5ecd0 55%, #f0e3b8 100%)",
        }}
      >
        {/* Global top bar */}
        <div className="flex items-center justify-between gap-3 px-6 lg:px-10 pt-6 pb-4">
          <div className="flex items-center gap-2 shrink-0">
            {/* Mobile menu trigger */}
            <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
              <SheetTrigger asChild>
                <button
                  className="md:hidden p-2 rounded-full bg-white/70 border border-stone-300/40 text-stone-700 hover:bg-white"
                  aria-label="Open navigation"
                  data-testid="button-mobile-nav"
                >
                  <Menu className="h-4 w-4" />
                </button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72 p-0 bg-stone-50">
                <SheetHeader className="p-5 border-b border-stone-200">
                  <SheetTitle className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-md bg-stone-900 flex items-center justify-center">
                      <Send className="w-3.5 h-3.5 text-amber-300" />
                    </div>
                    Critsend
                  </SheetTitle>
                </SheetHeader>
                <nav className="p-3 overflow-y-auto" data-testid="nav-mobile">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-stone-500 px-3 pt-2 pb-1">
                    Main
                  </div>
                  {PRIMARY_NAV.map((item) => {
                    const active = isActive(location, item.url);
                    return (
                      <Link key={item.url} href={item.url}>
                        <div
                          onClick={() => setMobileNavOpen(false)}
                          className={
                            "px-3 py-2 rounded-lg text-sm cursor-pointer " +
                            (active
                              ? "bg-stone-900 text-white font-medium"
                              : "text-stone-700 hover:bg-stone-200")
                          }
                          data-testid={`${navTestId(item.title)}-mobile`}
                        >
                          {item.title}
                        </div>
                      </Link>
                    );
                  })}
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-stone-500 px-3 pt-4 pb-1">
                    More
                  </div>
                  {OVERFLOW_NAV.map((item) => {
                    const active = isActive(location, item.url);
                    return (
                      <Link key={item.url} href={item.url}>
                        <div
                          onClick={() => setMobileNavOpen(false)}
                          className={
                            "px-3 py-2 rounded-lg text-sm cursor-pointer " +
                            (active
                              ? "bg-stone-900 text-white font-medium"
                              : "text-stone-700 hover:bg-stone-200")
                          }
                          data-testid={`${navTestId(item.title)}-mobile`}
                        >
                          {item.title}
                        </div>
                      </Link>
                    );
                  })}
                </nav>
              </SheetContent>
            </Sheet>

            <Link href="/">
              <div
                className="flex items-center gap-2 px-3 sm:px-4 py-2 rounded-full bg-white/70 border border-stone-300/50 cursor-pointer hover:bg-white"
                data-testid="link-home-logo"
              >
                <div className="w-6 h-6 rounded-md bg-stone-900 flex items-center justify-center">
                  <Send className="w-3.5 h-3.5 text-amber-300" />
                </div>
                <span className="text-sm font-semibold text-stone-900 tracking-tight hidden sm:inline">
                  Critsend
                </span>
              </div>
            </Link>
          </div>

          {/* Nav pills */}
          <nav className="hidden md:flex items-center gap-1 px-2 py-1.5 rounded-full bg-white/60 border border-stone-300/40 text-sm overflow-hidden">
            {PRIMARY_NAV.map((item) => {
              const active = isActive(location, item.url);
              return (
                <Link key={item.url} href={item.url}>
                  <span
                    className={
                      "px-3 lg:px-4 py-1.5 rounded-full cursor-pointer whitespace-nowrap transition-colors " +
                      (active
                        ? "bg-stone-900 text-white font-medium"
                        : "text-stone-700 hover:text-stone-900 hover:bg-white/70")
                    }
                    data-testid={navTestId(item.title)}
                  >
                    {item.title}
                  </span>
                </Link>
              );
            })}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={
                    "px-2 py-1.5 rounded-full flex items-center transition-colors " +
                    (overflowActive
                      ? "bg-stone-900 text-white"
                      : "text-stone-700 hover:text-stone-900 hover:bg-white/70")
                  }
                  aria-label="More navigation"
                  data-testid="button-nav-more"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>More</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {OVERFLOW_NAV.map((item) => {
                  const active = isActive(location, item.url);
                  return (
                    <DropdownMenuItem key={item.url} asChild>
                      <Link href={item.url}>
                        <span
                          className={
                            "w-full cursor-pointer " +
                            (active ? "font-semibold text-stone-900" : "")
                          }
                          data-testid={navTestId(item.title)}
                        >
                          {item.title}
                        </span>
                      </Link>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </nav>

          <div className="flex items-center gap-2 shrink-0">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="p-2 rounded-full bg-white/70 border border-stone-300/40 text-stone-700 hover:bg-white"
                  aria-label="Theme"
                  data-testid="button-theme"
                >
                  {theme === "dark" ? (
                    <Moon className="h-4 w-4" />
                  ) : theme === "light" ? (
                    <Sun className="h-4 w-4" />
                  ) : (
                    <Monitor className="h-4 w-4" />
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem
                  onClick={() => setTheme("light")}
                  data-testid="menu-item-light"
                >
                  <Sun className="h-4 w-4 mr-2" /> Light
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setTheme("dark")}
                  data-testid="menu-item-dark"
                >
                  <Moon className="h-4 w-4 mr-2" /> Dark
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setTheme("system")}
                  data-testid="menu-item-system"
                >
                  <Monitor className="h-4 w-4 mr-2" /> System
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Link href="/system-metrics">
              <button
                className="p-2 rounded-full bg-white/70 border border-stone-300/40 text-stone-700 hover:bg-white"
                aria-label="Settings"
                data-testid="button-settings"
              >
                <Settings className="h-4 w-4" />
              </button>
            </Link>

            <Link href="/error-logs">
              <button
                className="p-2 rounded-full bg-white/70 border border-stone-300/40 text-stone-700 hover:bg-white relative"
                aria-label="Notifications"
                data-testid="button-notifications"
              >
                <Bell className="h-4 w-4" />
                <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-amber-500" />
              </button>
            </Link>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="w-9 h-9 rounded-full bg-stone-900 text-white flex items-center justify-center text-sm font-semibold hover:bg-stone-800"
                  aria-label="Account"
                  data-testid="button-account"
                >
                  {displayName.charAt(0)}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>
                  <div className="font-semibold" data-testid="text-account-name">
                    {displayName}
                  </div>
                  <div className="text-xs text-muted-foreground font-normal truncate">
                    {user?.username ?? ""}
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/system-metrics">
                    <span
                      className="w-full cursor-pointer flex items-center"
                      data-testid="menu-item-settings"
                    >
                      <Settings className="h-4 w-4 mr-2" /> Settings
                    </span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/api-docs">
                    <span
                      className="w-full cursor-pointer flex items-center"
                      data-testid="menu-item-help"
                    >
                      <HelpCircle className="h-4 w-4 mr-2" /> Help &amp; Docs
                    </span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={handleLogout}
                  data-testid="button-logout"
                  className="text-red-600 focus:text-red-700 focus:bg-red-50"
                >
                  <LogOut className="h-4 w-4 mr-2" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Page content sits inside the cream container */}
        <div className="px-2 lg:px-6 pb-6 lg:pb-10">{children}</div>
      </div>
    </div>
  );
}
