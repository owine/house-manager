'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type Tab = {
  value: string;
  label: string;
  content: React.ReactNode;
};

type Props = {
  header: React.ReactNode;
  meta?: React.ReactNode;
  tabs: Tab[];
  defaultTab?: string;
};

export function DetailPageShell({ header, meta, tabs, defaultTab }: Props) {
  return (
    <div className="mx-auto max-w-7xl">
      {header}
      <div className="grid gap-6 md:grid-cols-3">
        <div className="min-w-0 md:col-span-2">
          <Tabs defaultValue={defaultTab ?? tabs[0]?.value}>
            <TabsList>
              {tabs.map((t) => (
                <TabsTrigger key={t.value} value={t.value}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {tabs.map((t) => (
              <TabsContent key={t.value} value={t.value}>
                {t.content}
              </TabsContent>
            ))}
          </Tabs>
        </div>
        {meta && <aside className="md:col-span-1">{meta}</aside>}
      </div>
    </div>
  );
}
