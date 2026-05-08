'use client';

import {
  Calendar,
  Home,
  Inbox,
  Layers,
  ListChecks,
  Package,
  Search,
  Settings,
  Shield,
  StickyNote,
  Users,
  Wrench,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ThemeToggle } from '@/components/ThemeToggle';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from '@/components/ui/sidebar';

type BadgeKey = 'inbox';
type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badgeKey?: BadgeKey;
};

const PRIMARY: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: Home },
  { href: '/items', label: 'Items', icon: Package },
  { href: '/systems', label: 'Systems', icon: Layers },
  { href: '/vendors', label: 'Vendors', icon: Users },
  { href: '/service', label: 'Service', icon: Wrench },
  { href: '/inbox', label: 'Inbox', icon: Inbox, badgeKey: 'inbox' },
  { href: '/reminders', label: 'Reminders', icon: Calendar },
  { href: '/checklists', label: 'Checklists', icon: ListChecks },
  { href: '/notes', label: 'Notes', icon: StickyNote },
  { href: '/search', label: 'Search', icon: Search },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppSidebar({
  user,
  badges,
}: {
  user: { name?: string | null; role?: string | null };
  badges?: Partial<Record<BadgeKey, number>>;
}) {
  const pathname = usePathname();
  const isAdmin = user.role === 'ADMIN';

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link href="/dashboard" className="flex items-center gap-2 px-2 py-1.5 font-semibold">
          <span className="text-base">House Manager</span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {PRIMARY.map((item) => {
                const badgeCount = item.badgeKey ? badges?.[item.badgeKey] : undefined;
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      render={<Link href={item.href} />}
                      isActive={isActive(pathname, item.href)}
                      tooltip={item.label}
                    >
                      <item.icon className="h-4 w-4" />
                      <span>{item.label}</span>
                      {badgeCount !== undefined && badgeCount > 0 && (
                        <span
                          role="status"
                          aria-label={`${badgeCount} untriaged`}
                          className="ml-auto rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                        >
                          {badgeCount > 99 ? '99+' : badgeCount}
                        </span>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/settings" />}
                  isActive={isActive(pathname, '/settings')}
                  tooltip="Settings"
                >
                  <Settings className="h-4 w-4" />
                  <span>Settings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {isAdmin && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={<Link href="/admin" />}
                    isActive={isActive(pathname, '/admin')}
                    tooltip="Admin"
                  >
                    <Shield className="h-4 w-4" />
                    <span>Admin</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <ThemeToggle />
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          Signed in as {user.name ?? 'user'}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
