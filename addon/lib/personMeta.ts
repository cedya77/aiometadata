// https://docs.aiostreams.viren070.me/reference/addon-protocol/people/

const PERSON_ID = /^(tmdb|tvdb):(\d+)$/;

const day = (value: string | null | undefined): string | undefined => {
  const match = String(value ?? '').match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : undefined;
};

const CREDIT_FIELDS = ['id', 'type', 'name', 'poster', 'background', 'description', 'releaseInfo', 'released', 'year'];

export async function personMeta(config: any, id: string): Promise<any | null> {
  const match = id.match(PERSON_ID);
  if (!match) return null;
  const { personById, personCredits } = require('./jellyfin/people');
  const person = await personById(config, match[1], Number(match[2]));
  if (!person) return null;

  const credits: any[] = (await personCredits(config, person)).filter((meta: any) => meta._personTypes?.length);
  if (person.source === 'tmdb') credits.sort((a, b) => (b._votes || 0) - (a._votes || 0));
  const { creditCards } = require('./titleCards');
  const cards: any[] = await creditCards(config, credits);

  return {
    id,
    type: 'person',
    name: person.name,
    description: person.biography || undefined,
    poster: person.photo || undefined,
    birthday: day(person.birthday),
    deathday: day(person.deathday),
    birthPlace: person.birthplace || undefined,
    ids: {
      [match[1]]: match[2],
      [person.source]: String(person.id),
      ...(person.imdbId ? { imdb: person.imdbId } : {}),
    },
    credits: cards.map((meta) => Object.fromEntries(CREDIT_FIELDS.filter((field) => meta[field]).map((field) => [field, meta[field]]))),
  };
}
