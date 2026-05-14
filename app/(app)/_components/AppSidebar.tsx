'use client';

import {
  Calendar,
  Home,
  Inbox,
  Layers,
  ListChecks,
  MessageCircleQuestionMark,
  Package,
  Repeat,
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
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from '@/components/ui/sidebar';
import { Wordmark } from '@/components/Wordmark';

type BadgeKey = 'inbox';
type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badgeKey?: BadgeKey;
};

// Sidebar nav grouped by intent so the user's mental model maps cleanly to
// the menu: orientation (where am I?) → inventory (what do I own?) →
// workflows (what needs doing?) → history & search (what happened?).
// Group titles use the brand's mono micro-label treatment (uppercase + tracked)
// — the one exception to the lowercase rule. Nav labels themselves stay
// lowercase per the voice guidelines.
type NavGroup = { title?: string; items: NavItem[] };
const NAV_GROUPS: NavGroup[] = [
  {
    items: [{ href: '/dashboard', label: 'dashboard', icon: Home }],
  },
  {
    title: 'inventory',
    items: [
      { href: '/items', label: 'items', icon: Package },
      { href: '/systems', label: 'systems', icon: Layers },
      { href: '/vendors', label: 'vendors', icon: Users },
    ],
  },
  {
    title: 'workflows',
    items: [
      { href: '/inbox', label: 'inbox', icon: Inbox, badgeKey: 'inbox' },
      { href: '/ask', label: 'ask', icon: MessageCircleQuestionMark },
      { href: '/reminders', label: 'reminders', icon: Calendar },
      { href: '/chores', label: 'chores', icon: Repeat },
      { href: '/checklists', label: 'checklists', icon: ListChecks },
    ],
  },
  {
    title: 'history',
    items: [
      { href: '/service', label: 'service', icon: Wrench },
      { href: '/notes', label: 'notes', icon: StickyNote },
      { href: '/search', label: 'search', icon: Search },
    ],
  },
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
        <Link href="/dashboard" className="flex items-center px-2 py-1.5 text-base">
          <Wordmark />
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {NAV_GROUPS.map((group, idx) => (
          <SidebarGroup key={group.items[0]?.href ?? idx}>
            {group.title && (
              <SidebarGroupLabel className="label-mono">{group.title}</SidebarGroupLabel>
            )}
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
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
        ))}

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/settings" />}
                  isActive={isActive(pathname, '/settings')}
                  tooltip="settings"
                >
                  <Settings className="h-4 w-4" />
                  <span>settings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {isAdmin && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={<Link href="/admin" />}
                    isActive={isActive(pathname, '/admin')}
                    tooltip="admin"
                  >
                    <Shield className="h-4 w-4" />
                    <span>admin</span>
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
          signed in as {user.name ?? 'user'}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
