import { HouseholdUsers } from '@/components/users/HouseholdUsers';

export function PeopleSettings() {
  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h2 className="text-2xl font-semibold">People</h2>
        <p className="text-muted-foreground mt-1">Everyone who watches here, each with their own catalogs, trackers and sign-in.</p>
      </div>
      <HouseholdUsers />
    </div>
  );
}
