import consola from 'consola';
import { asProfile } from '../dashboard';
import { profileKey } from '../profiles';
import { viewingTimeZone } from '../viewingHours';
import { safeTimeZone, yearPlays } from './plays';
import { timeYear } from './timed';

const logger = consola.withTag('YearReview');

export async function dashboardYear(userUUID: string, profile: string | null, year: number): Promise<any | null> {
  return asProfile(userUUID, profile, async (config) => {
    const timeZone = safeTimeZone(viewingTimeZone(config));
    const historyKey = profileKey(config);
    const started = Date.now();
    const plays = await yearPlays(userUUID, historyKey, year, timeZone);
    const folded = Date.now();
    const timed = await timeYear(userUUID, historyKey, plays, timeZone);
    const ms = { fold: folded - started, time: Date.now() - folded };
    const films = timed.titles.filter((title) => title.kind === 'movie');
    const shows = timed.titles.filter((title) => title.kind === 'series');
    const sum = (list: typeof timed.titles, pick: (title: (typeof timed.titles)[number]) => number) => list.reduce((total, title) => total + pick(title), 0);
    logger.info(`${userUUID.slice(0, 8)} ${year}: ${timed.plays.length} plays, ${timed.titles.length} titles, ${timed.counts.held} cached, ${timed.counts.built} built, ${timed.counts.missing} missing, ${ms.fold + ms.time}ms`);
    return {
      year,
      timeZone,
      ms,
      counts: timed.counts,
      totals: {
        plays: timed.plays.length,
        watchMs: timed.plays.reduce((total, play) => total + play.runtimeMs, 0),
        films: { titles: films.length, plays: sum(films, (title) => title.plays.length), watchMs: sum(films, (title) => title.watchMs) },
        shows: { titles: shows.length, plays: sum(shows, (title) => title.plays.length), watchMs: sum(shows, (title) => title.watchMs) },
        anime: { titles: timed.titles.filter((title) => title.anime).length, plays: sum(timed.titles.filter((title) => title.anime), (title) => title.plays.length) },
        rhythmPlays: timed.plays.filter((play) => !play.batch && !play.overfull).length,
      },
      titles: timed.titles.map((title) => ({
        key: title.key,
        kind: title.kind,
        name: title.facts?.name ?? null,
        anime: title.anime,
        watchMs: title.watchMs,
        facts: title.facts ? { source: title.facts.source, year: title.facts.year, genres: title.facts.genres, countries: title.facts.countries, networks: title.facts.networks, studios: title.facts.studios, language: title.facts.language, poster: title.facts.poster } : null,
        plays: title.plays.map((play) => [play.videoId, play.at, play.runtimeMs, play.runtimeSource, play.batch ? 1 : 0, play.overfull ? 1 : 0, play.spellings]),
      })),
    };
  });
}
