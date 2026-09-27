"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type CSSProperties } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Boxes,
  ChevronUp,
  CircleHelp,
  Code2,
  House,
  KeyRound,
  LogOut,
  Plus,
  Search,
  Settings2,
  UserRound,
  Video,
  X,
  type LucideIcon,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { WorkspaceProvider, useWorkspace } from "./workspace-provider";
import type { Account, AuthConfig } from "@/lib/auth-types";
import { logout } from "@/lib/auth-client";

const navigation: {
  title: string;
  href: string;
  icon: LucideIcon;
  group: string;
}[] = [
  { title: "Overview", href: "/overview", icon: House, group: "Workspace" },
  { title: "Analyze", href: "/analyze", icon: Video, group: "Workspace" },
  { title: "Models", href: "/models", icon: Boxes, group: "Workspace" },
  { title: "API keys", href: "/access", icon: KeyRound, group: "Developers" },
  {
    title: "Documentation",
    href: "/reference",
    icon: BookOpen,
    group: "Developers",
  },
];
const allPages = [
  ...navigation,
  { title: "Settings", href: "/settings", icon: Settings2, group: "Workspace" },
];

function AppSidebar({
  openSearch,
  openProfile,
}: {
  openSearch: () => void;
  openProfile: () => void;
}) {
  const path = usePathname();
  const { user } = useWorkspace();
  const [logoutError, setLogoutError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const { setOpenMobile, isMobile } = useSidebar();
  const closeNavigation = () => setOpenMobile(false);
  return (
    <Sidebar
      variant="inset"
      className="app-sidebar"
      aria-label="Workspace sidebar"
    >
      <SidebarHeader className="brand-header">
        <Link
          href="/overview"
          className="workspace-brand"
          onClick={closeNavigation}
        >
          <img src="/tayra-logo.svg" alt="" className="workspace-mark" />
          <span>Tayra Labs</span>
        </Link>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={openSearch}
                aria-label="Search workspace"
                aria-keyshortcuts="Meta+K Control+K"
                className="text-muted-foreground"
              >
                <Search />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Search workspace <kbd className="ml-2 opacity-60">⌘ K</kbd>
            </TooltipContent>
          </Tooltip>
          {isMobile && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close navigation"
              onClick={closeNavigation}
            >
              <X />
            </Button>
          )}
        </div>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Main navigation">
          {["Workspace", "Developers"].map((group) => (
            <SidebarGroup key={group}>
              <SidebarGroupLabel>{group}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {navigation
                    .filter((item) => item.group === group)
                    .map(({ title, href, icon: Icon }) => (
                      <SidebarMenuItem key={href}>
                        <SidebarMenuButton
                          asChild
                          isActive={path === href}
                          tooltip={title}
                        >
                          <Link
                            href={href}
                            onClick={closeNavigation}
                            aria-current={path === href ? "page" : undefined}
                          >
                            <Icon />
                            <span>{title}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={path === "/settings"}>
              <Link
                href="/settings"
                onClick={closeNavigation}
                aria-current={path === "/settings" ? "page" : undefined}
              >
                <Settings2 />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarSeparator className="mx-0" />
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="profile-trigger"
                  aria-label="Open profile menu"
                >
                  <Avatar className="size-8 rounded-lg">
                    <AvatarFallback className="rounded-lg border border-border bg-secondary">
                      {user.display_name.trim().slice(0, 1).toUpperCase() ||
                        user.email.slice(0, 1).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="flex-1 truncate">
                    {user.display_name || user.email}
                  </span>
                  <ChevronUp className="size-4 text-muted-foreground" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side={isMobile ? "top" : "right"}
                align="end"
                sideOffset={10}
                className="w-56"
              >
                <DropdownMenuLabel className="truncate">
                  {user.email}
                </DropdownMenuLabel>
                <DropdownMenuItem onSelect={openProfile}>
                  <UserRound />
                  Profile
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/settings" onClick={closeNavigation}>
                    <Settings2 />
                    Workspace settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/reference" onClick={closeNavigation}>
                    <CircleHelp />
                    Help & documentation
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={loggingOut}
                  onSelect={() => {
                    setLoggingOut(true);
                    void logout().catch(() => {
                      setLogoutError("Could not sign out. Please try again.");
                      setLoggingOut(false);
                    });
                  }}
                >
                  <LogOut />
                  {loggingOut ? "Signing out…" : "Log out"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
        {logoutError && (
          <p role="alert" className="text-xs text-destructive px-2">
            {logoutError}
          </p>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { user } = useWorkspace();
  const path = usePathname();
  const router = useRouter();
  const { setOpenMobile } = useSidebar();
  const [command, setCommand] = useState(false);
  const [profile, setProfile] = useState(false);
  const current = allPages.find((item) => item.href === path);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setOpenMobile(false);
        setCommand((open) => !open);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [setOpenMobile]);
  function go(href: string) {
    setCommand(false);
    setOpenMobile(false);
    router.push(href);
  }
  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <AppSidebar
        openSearch={() => {
          setOpenMobile(false);
          setCommand(true);
        }}
        openProfile={() => {
          setOpenMobile(false);
          setProfile(true);
        }}
      />
      <SidebarInset className="product-surface">
        <header className="product-header">
          <SidebarTrigger
            aria-label="Toggle navigation"
            className="text-muted-foreground"
          />
          <h1>{current?.title ?? "Overview"}</h1>
          <div className="header-actions">
            {path === "/overview" ? (
              <Button size="sm" variant="outline" asChild>
                <Link href="/analyze">
                  <Plus />
                  New analysis
                </Link>
              </Button>
            ) : path === "/analyze" ? (
              <Button size="sm" variant="ghost" asChild>
                <Link href="/reference">
                  <Code2 />
                  View API
                </Link>
              </Button>
            ) : (
              path !== "/reference" && (
                <Button size="sm" variant="ghost" asChild>
                  <Link href="/reference">
                    Docs
                    <ArrowUpRight />
                  </Link>
                </Button>
              )
            )}
          </div>
        </header>
        <div id="main-content" tabIndex={-1} className="product-content">
          {children}
        </div>
      </SidebarInset>
      <CommandDialog
        open={command}
        onOpenChange={setCommand}
        title="Search workspace"
        description="Search pages. Use the arrow keys and Enter to navigate."
      >
        <CommandInput
          placeholder="Search workspace…"
          aria-label="Search pages"
        />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          {["Workspace", "Developers"].map((group) => (
            <CommandGroup heading={group} key={group}>
              {allPages
                .filter((item) => item.group === group)
                .map(({ title, href, icon: Icon }) => (
                  <CommandItem
                    key={href}
                    value={title}
                    onSelect={() => go(href)}
                  >
                    <Icon />
                    <span>{title}</span>
                  </CommandItem>
                ))}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>
      <Dialog open={profile} onOpenChange={setProfile}>
        <DialogContent className="sm:max-w-sm">
          <DialogTitle>Profile</DialogTitle>
          <DialogDescription>
            {user.display_name || "Your account"}
            <br />
            {user.email}
          </DialogDescription>
          <Button
            variant="outline"
            onClick={() => {
              setProfile(false);
              go("/settings");
            }}
          >
            Manage account
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
export function WorkspaceShell({
  children,
  user,
  authConfig,
}: {
  children: React.ReactNode;
  user: Account;
  authConfig: AuthConfig;
}) {
  return (
    <WorkspaceProvider user={user} authConfig={authConfig} key={user.id}>
      <SidebarProvider
        className="product-root"
        style={{ "--sidebar-width": "244px" } as CSSProperties}
      >
        <Shell>{children}</Shell>
      </SidebarProvider>
    </WorkspaceProvider>
  );
}
