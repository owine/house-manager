import type { VendorRole } from '@prisma/client';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export type VendorSystemLinkRow = {
  id: string;
  systemId: string;
  freeformName: string | null;
  role: VendorRole;
  system: { id: string; name: string } | null;
};

type Props = {
  systems: VendorSystemLinkRow[];
};

const ROLE_ORDER: VendorRole[] = [
  'PURCHASE',
  'INSTALLER',
  'SERVICE',
  'WARRANTY_PROVIDER',
  'MANUFACTURER',
];

function roleLabel(role: VendorRole): string {
  switch (role) {
    case 'PURCHASE':
      return 'Purchase';
    case 'INSTALLER':
      return 'Installer';
    case 'SERVICE':
      return 'Service';
    case 'WARRANTY_PROVIDER':
      return 'Warranty';
    case 'MANUFACTURER':
      return 'Manufacturer';
    default:
      return role;
  }
}

export function VendorLinkedSystemsSection({ systems }: Props) {
  const grouped = new Map<VendorRole, VendorSystemLinkRow[]>();
  for (const link of systems) {
    const arr = grouped.get(link.role) ?? [];
    arr.push(link);
    grouped.set(link.role, arr);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Linked systems ({systems.length})</CardTitle>
      </CardHeader>
      <CardContent>
        {systems.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="vendor-linked-systems-empty">
            Not linked to any systems yet.
          </p>
        ) : (
          <div className="flex flex-col gap-4" data-testid="vendor-linked-systems">
            {ROLE_ORDER.filter((r) => grouped.has(r)).map((role) => {
              const rows = grouped.get(role) ?? [];
              return (
                <section key={role} className="flex flex-col gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Systems — {roleLabel(role)}
                  </h3>
                  <ul className="flex flex-col gap-1">
                    {rows.map((row) => (
                      <li key={row.id} className="flex items-center gap-2 text-sm">
                        <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                          {role}
                        </Badge>
                        {row.system ? (
                          <Link
                            href={`/systems/${row.system.id}`}
                            className="underline-offset-2 hover:underline"
                            data-testid={`vendor-linked-system-${row.id}`}
                          >
                            {row.system.name}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">
                            {row.freeformName ?? 'Unknown system'}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default VendorLinkedSystemsSection;
