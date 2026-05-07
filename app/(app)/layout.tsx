import { redirect } from 'next/navigation';
import { ServiceWorkerRegistrar } from '@/components/notifications/ServiceWorkerRegistrar';
import { SearchBar } from '@/components/search/SearchBar';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { auth } from '@/lib/auth';
import { APP_GIT_SHA, APP_VERSION } from '@/lib/version';
import { AppSidebar } from './_components/AppSidebar';

// SOLE AUTH GATE for the application. middleware.ts was deleted in Task 12 to
// avoid an Auth.js v5 JWE-vs-database-session incompatibility, so authenticated
// pages must live under this route group `app/(app)/` to inherit the redirect
// below. New protected routes belong here — putting them at the top level (e.g.
// `app/items/`) ships them publicly. If we add more protected groups, switch
// the session strategy to JWT and re-introduce middleware.ts.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect('/api/auth/signin');
  return (
    <SidebarProvider>
      <AppSidebar
        user={{
          name: session.user.name,
          role: (session.user as { role?: string | null }).role,
        }}
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
          v{APP_VERSION} · {APP_GIT_SHA}
        </footer>
      </SidebarInset>
      <Toaster />
      <ServiceWorkerRegistrar />
    </SidebarProvider>
  );
}
