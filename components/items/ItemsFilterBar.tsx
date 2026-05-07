'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CategoryIcon } from '@/components/items/CategoryIcon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// Sentinel for the "no filter" choice. Native form submit would map empty
// string to "no value", but Base UI Select treats '' as a placeholder state,
// so we use a non-empty sentinel and translate on submit via a hidden input.
const ALL_CATEGORIES = '__all_categories__';
const ALL_LOCATIONS = '__all_locations__';

type Props = {
  q: string;
  selectedCategorySlug: string;
  selectedLocation: string;
  showArchived: boolean;
  initialView: 'cards' | 'table' | null;
  categories: Array<{ id: string; slug: string; icon: string | null; name: string }>;
  locations: string[];
};

export function ItemsFilterBar({
  q,
  selectedCategorySlug,
  selectedLocation,
  showArchived,
  initialView,
  categories,
  locations,
}: Props) {
  const [category, setCategory] = useState<string>(selectedCategorySlug || ALL_CATEGORIES);
  const [location, setLocation] = useState<string>(selectedLocation || ALL_LOCATIONS);

  const hasFilters =
    q.length > 0 || selectedCategorySlug.length > 0 || selectedLocation.length > 0 || showArchived;

  // The hidden inputs are what the form actually submits; the Selects drive
  // their values via state.
  const categoryFormValue = category === ALL_CATEGORIES ? '' : category;
  const locationFormValue = location === ALL_LOCATIONS ? '' : location;

  // items prop on Select.Root tells Base UI how to render the trigger label
  // for a given value — without it, <SelectValue /> would show the raw value.
  const categoryItems = [
    { label: 'All categories', value: ALL_CATEGORIES },
    ...categories.map((c) => ({
      label: (
        <span className="flex items-center gap-2">
          <CategoryIcon name={c.icon} />
          {c.name}
        </span>
      ),
      value: c.slug,
    })),
  ];
  const locationItems = [
    { label: 'All locations', value: ALL_LOCATIONS },
    ...locations.map((loc) => ({ label: loc, value: loc })),
  ];

  return (
    <form method="get" className="flex flex-wrap items-end gap-2">
      {initialView && <input type="hidden" name="view" value={initialView} />}
      <input type="hidden" name="category" value={categoryFormValue} />
      <input type="hidden" name="location" value={locationFormValue} />

      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="filter-q">Search</label>
        <Input id="filter-q" name="q" defaultValue={q} placeholder="Name, manufacturer, model..." />
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="filter-category">Category</label>
        <Select
          items={categoryItems}
          value={category}
          onValueChange={(v) => setCategory(v ?? ALL_CATEGORIES)}
        >
          <SelectTrigger id="filter-category" className="w-[12rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {categoryItems.map((it) => (
              <SelectItem key={it.value} value={it.value}>
                {it.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="filter-location">Location</label>
        <Select
          items={locationItems}
          value={location}
          onValueChange={(v) => setLocation(v ?? ALL_LOCATIONS)}
        >
          <SelectTrigger id="filter-location" className="w-[12rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {locationItems.map((it) => (
              <SelectItem key={it.value} value={it.value}>
                {it.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <label className="flex flex-row items-center gap-1.5 text-sm">
        <input
          type="checkbox"
          name="archived"
          value="true"
          defaultChecked={showArchived}
          className="h-4 w-4 accent-primary rounded border-input"
        />
        Show archived
      </label>

      <Button type="submit" variant="outline">
        Filter
      </Button>

      {hasFilters && (
        <Button variant="ghost" render={<Link href="/items" />}>
          Clear
        </Button>
      )}
    </form>
  );
}
