import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function SeasonalChecklistCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Seasonal checklist</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Coming in Plan 4b — AI-generated seasonal home maintenance checklists.
        </p>
      </CardContent>
    </Card>
  );
}
