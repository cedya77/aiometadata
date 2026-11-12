import { Face } from '@/components/users/Face';
import { useConfig } from '@/contexts/ConfigContext';
import type { CardService } from '@/contexts/config';
import { CARD_SERVICES, connectedServices, householdPeople, mainConnectedServices, pinInvalid, showsAlsoKnownAs } from '@/lib/cardAccounts';

const SHOWN_TRACKERS = 4;

interface Row {
  key: string;
  name: string;
  avatar?: string;
  main: boolean;
  badges: string[];
  trackers: CardService[];
  sharesYours: boolean;
}

function Trackers({ services, sharesYours }: { services: CardService[]; sharesYours: boolean }) {
  if (sharesYours) return <span className="text-xs text-muted-foreground">Shares yours</span>;
  if (!services.length) return <span className="text-xs text-muted-foreground">No trackers</span>;
  const extra = services.length - SHOWN_TRACKERS;
  return (
    <span className="flex items-center gap-1">
      {services.slice(0, SHOWN_TRACKERS).map((service) => (
        <img key={service} src={CARD_SERVICES[service].icon} alt={CARD_SERVICES[service].label} title={CARD_SERVICES[service].label} className="h-4 w-4 rounded-sm object-contain" />
      ))}
      {extra > 0 ? <span className="text-xs text-muted-foreground">+{extra}</span> : null}
    </span>
  );
}


export function PeopleList() {
  const { config, auth } = useConfig();
  const users = config.jellyfinUsers ?? [];
  const several = users.length > 0;
  const handoff = showsAlsoKnownAs(config, users);

  const badgesFor = ({ pin, tags, streamUrl, handoffNames, main }: { pin?: string; tags?: string[]; streamUrl?: string; handoffNames?: string[]; main: boolean }) => {
    const badges: string[] = [];
    if (pinInvalid(pin)) badges.push('PIN incomplete');
    else if (pin) badges.push('PIN');
    if (tags?.length) badges.push(`${tags.length} catalog tag${tags.length === 1 ? '' : 's'}`);
    if (!main && streamUrl?.trim()) badges.push('Own stream addon');
    if (handoff && handoffNames?.length) badges.push(`Also known as ${handoffNames.join(', ')}`);
    return badges;
  };

  const rows: Row[] = householdPeople(config, auth.userUUID ?? '').map(({ key, name, avatar, main, user }): Row => ({
    key,
    name,
    avatar,
    main,
    badges: user
      ? badgesFor({ pin: user.pin, tags: user.tags, streamUrl: user.streamUrl, handoffNames: user.handoffNames, main: false })
      : badgesFor({ pin: config.jellyfinUserPin, tags: config.jellyfinUserTags, handoffNames: config.jellyfinUserHandoffNames, main: true }),
    trackers: user ? connectedServices(user) : mainConnectedServices(config),
    sharesYours: user?.trackers === true,
  }));

  return (
    <section id="jellyfin-people" aria-labelledby="jellyfin-people-title" className="space-y-3 border-t pt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h3 id="jellyfin-people-title" className="text-[15px] font-semibold">People</h3>
          <p className="text-sm text-muted-foreground">Who can sign in to the Jellyfin apps. Change them in People.</p>
        </div>
      </div>

      <ul className="divide-y overflow-hidden rounded-lg border bg-card">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-3 px-4 py-3">
              <span className="relative shrink-0 p-0.5">
                <Face name={row.name} avatar={row.avatar} className="h-9 w-9 border-0 text-sm" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                <span className="min-w-0 truncate text-sm font-medium sm:max-w-[12rem]">
                  {row.name}
                  {row.main && row.name !== 'You' ? <span className="font-normal text-muted-foreground"> (you)</span> : null}
                </span>
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                  {row.badges.map((badge) => (
                    <span key={badge} className="max-w-full truncate rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">{badge}</span>
                  ))}
                </span>
                <Trackers services={row.trackers} sharesYours={row.sharesYours} />
              </span>
          </li>
        ))}
      </ul>

      {!several ? (
        <p className="text-sm text-muted-foreground">Just you so far. Add someone with Add person in step 2, or in People, and their app can sign in as them.</p>
      ) : null}
    </section>
  );
}
