import {
  Box,
  Car,
  Droplet,
  Home,
  Leaf,
  type LucideIcon,
  Thermometer,
  WashingMachine,
  Wrench,
  Zap,
} from 'lucide-react';

// Category.icon is stored in the DB as a kebab-case string matching a Lucide
// icon name (see prisma/seed.ts). Render the actual icon component here so
// callers don't need to import lucide-react and dispatch by name.
//
// When you add a new category to the seed, add its icon name here too — the
// fallback (a generic Box) keeps the UI from breaking but signals the gap.
const ICON_MAP: Record<string, LucideIcon> = {
  'washing-machine': WashingMachine,
  thermometer: Thermometer,
  droplet: Droplet,
  zap: Zap,
  home: Home,
  car: Car,
  wrench: Wrench,
  leaf: Leaf,
  box: Box,
};

type Props = {
  name: string | null | undefined;
  className?: string;
};

export function CategoryIcon({ name, className = 'h-4 w-4' }: Props) {
  if (!name) return null;
  const Icon = ICON_MAP[name] ?? Box;
  return <Icon className={className} aria-hidden="true" />;
}
