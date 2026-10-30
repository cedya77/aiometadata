import { MARK_KINDS, type Tracker } from './types';
import { animeList, animeToken } from './animeList';

const load = () => require('../anilistTracker');

export const anilist: Tracker = {
  id: 'anilist',
  name: 'AniList',
  color: '#152232',
  animeOnly: true,
  datedHistory: false,
  marks: { from: [], to: MARK_KINDS },
  batch: 10,
  pace: () => ({ perSecond: 1 }),
  ...animeList('anilist', 'AniList', load, async (media) => {
    const found = await load().resolveAniListId(media);
    return found ? { id: Number(found.anilistId), episode: found.episode } : null;
  }),
  async writeMark(what, entry, side, userUUID) {
    const token = await animeToken('anilist', 'AniList', load, side, userUUID);
    const done = what === 'ratings' ? await load().setScore(entry.ids.anilist, Math.round((entry.rating ?? 0) * 10), token)
      : what === 'dropped' ? await load().setDropped(entry.ids.anilist, token)
        : await load().setPlanning(entry.ids.anilist, true, token);
    return done ? 'sent' : 'failed';
  },
};
