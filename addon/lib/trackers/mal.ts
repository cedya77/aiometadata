import { MARK_KINDS, type Tracker } from './types';
import { animeList, animeToken } from './animeList';

const load = () => require('../malTracker');

export const mal: Tracker = {
  id: 'mal',
  name: 'MyAnimeList',
  color: '#2e51a2',
  animeOnly: true,
  marks: { from: [], to: MARK_KINDS },
  batch: 10,
  pace: () => ({ perSecond: 1 }),
  ...animeList('mal', 'MyAnimeList', load),
  async writeMark(what, entry, side, userUUID) {
    const token = await animeToken('mal', 'MyAnimeList', load, side, userUUID);
    const done = what === 'ratings' ? await load().setScore(Number(entry.ids.mal), Math.round(entry.rating ?? 0), token)
      : what === 'dropped' ? await load().setDropped(Number(entry.ids.mal), token)
        : await load().setPlanToWatch(Number(entry.ids.mal), true, token);
    return done ? 'sent' : 'failed';
  },
};
