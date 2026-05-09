import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { CostRollupOutput } from '@/lib/systems/cost-rollup';

type Props = { rollup: CostRollupOutput };

function formatCurrency(value: { toNumber: () => number }) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value.toNumber());
}

export function CostRollup({ rollup }: Props) {
  if (!rollup.hasAnyData) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Total cost</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Add purchase prices on components or an install cost on the system to see a rollup.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Total cost</CardTitle>
      </CardHeader>
      <CardContent>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className="text-2xl font-semibold cursor-help"
                  data-testid="system-cost-total"
                >
                  {formatCurrency(rollup.total)}
                </span>
              }
            />
            <TooltipContent>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between gap-4">
                  <span>Components subtotal</span>
                  <span className="font-mono">{formatCurrency(rollup.componentsSubtotal)}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span>Install cost</span>
                  <span className="font-mono">{formatCurrency(rollup.installCost)}</span>
                </div>
                <div className="flex justify-between gap-4 border-t pt-1">
                  <span>Total</span>
                  <span className="font-mono">{formatCurrency(rollup.total)}</span>
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <p className="mt-1 text-xs text-muted-foreground">
          {formatCurrency(rollup.componentsSubtotal)} components +{' '}
          {formatCurrency(rollup.installCost)} install
        </p>
      </CardContent>
    </Card>
  );
}
