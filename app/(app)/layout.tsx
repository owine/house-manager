import { ServiceWorkerRegistrar } from '@/components/notifications/ServiceWorkerRegistrar';
import { SearchBar } from '@/components/search/SearchBar';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { requireUser } from '@/lib/auth-guard';
import { APP_GIT_SHA } from '@/lib/git-sha';
import { countUntriagedInbox } from '@/lib/incoming-email/queries';
import { AppSidebar } from './_components/AppSidebar';

// This redirect is UX, not the auth boundary. Next renders the layout and its
// page segments in parallel, so a page's queries run (and its RSC payload is
// serialized) even when this redirect fires. Every page and generateMetadata
// under `app/(app)/` gates itself with requireUser()/requireAdmin() from
// `lib/auth-guard.ts`; `tests/unit/app-auth-gate.test.ts` enforces it.
// middleware.ts was deleted (Auth.js v5 JWE-vs-database-session
// incompatibility), and a page created outside this group is still public.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireUser();
  // Fail-soft: a stale schema or DB blip shouldn't take the whole sidebar down.
  let inboxCount = 0;
  try {
    inboxCount = await countUntriagedInbox();
  } catch {
    inboxCount = 0;
  }
  return (
    <SidebarProvider>
      <AppSidebar
        user={{
          name: session.user.name,
          role: (session.user as { role?: string | null }).role,
        }}
        badges={{ inbox: inboxCount }}
      />
      <SidebarInset>
        <header className="flex h-14 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <div className="flex-1">
            <SearchBar />
          </div>
        </header>
        <main className="flex-1 p-4 sm:p-6">{children}</main>
        <footer className="border-t px-4 py-3 text-xs text-muted-foreground sm:px-6">
          {APP_GIT_SHA}
        </footer>
      </SidebarInset>
      <Toaster />
      <ServiceWorkerRegistrar />
    </SidebarProvider>
  );
}
