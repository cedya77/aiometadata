import { mayBeAnime, resolveAnimeEpisode } from './animeEpisodeIds';
import { covers, episodeKind, isRecap } from './fillerData';
import type { EpisodeKind } from './fillerData';

const MARKS: Record<string, string> = { filler: '[Filler]', mixed: '[Mixed]', recap: '[Recap]' };

export async function applyAnimeFillerProjection(meta: any, config: any): Promise<void> {
  const options = config?.mal || {};
  const skipFiller = !!options.skipFiller;
  const skipMixed = skipFiller && !!options.skipMixedFiller;
  const skipRecap = !!options.skipRecap;
  const mark = !!options.allowEpisodeMarking;
  if (!Array.isArray(meta?.videos) || !meta.videos.length) return;

  try {
    if (!mayBeAnime(meta)) return;
    const verdicts = new Map<any, { kind: EpisodeKind | null; recap: boolean }>();
    for (const video of meta.videos) {
      const found = await resolveAnimeEpisode(meta, video, config).catch(() => null);
      let kind: EpisodeKind | null = null;
      let recap = false;
      if (found?.malId && covers(found.malId)) {
        kind = episodeKind(found.malId, found.episode);
        recap = isRecap(found.malId, found.episode);
      } else {
        kind = video.isFiller === true ? 'filler' : null;
        recap = video.isRecap === true;
      }
      if (kind || recap) verdicts.set(video, { kind, recap });
    }
    if (!verdicts.size) return;

    const videos: any[] = [];
    for (const video of meta.videos) {
      const verdict = verdicts.get(video);
      if (!verdict) {
        videos.push(video);
        continue;
      }
      const { kind, recap } = verdict;
      if ((skipFiller && kind === 'filler') || (skipMixed && kind === 'mixed') || (skipRecap && recap)) continue;
      const updated = { ...video, isFiller: kind === 'filler', isMixedFiller: kind === 'mixed', isRecap: recap };
      const tag = recap ? MARKS.recap : kind ? MARKS[kind] : undefined;
      if (mark && tag) {
        for (const field of ['title', 'name']) {
          if (typeof video[field] === 'string' && !video[field].startsWith(tag)) updated[field] = `${tag} ${video[field]}`;
        }
      }
      videos.push(updated);
    }
    meta.videos = videos;
  } catch {
    return;
  }
}
