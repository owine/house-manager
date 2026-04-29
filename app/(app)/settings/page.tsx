import { HouseProfileForm } from '@/components/house-profile/HouseProfileForm';
import { ThemeToggle } from '@/components/ThemeToggle';
import { getHouseProfile } from '@/lib/house-profile/queries';
import type { HouseProfileInput } from '@/lib/house-profile/schema';

export default async function SettingsPage() {
  const profile = await getHouseProfile();

  const defaultValues: HouseProfileInput = {
    location: profile?.location ?? '',
    climateZone: profile?.climateZone ?? '',
    propertyType: (profile?.propertyType as HouseProfileInput['propertyType']) ?? undefined,
  };

  return (
    <div>
      <h1>Settings</h1>
      <h2 style={{ fontSize: '1rem', margin: '1rem 0 0.5rem' }}>Theme</h2>
      <ThemeToggle />
      <h2 style={{ fontSize: '1rem', margin: '1.5rem 0 0.5rem' }}>House profile</h2>
      <HouseProfileForm defaultValues={defaultValues} />
    </div>
  );
}
