import type { ComponentType } from "react";
import type { YearAccent } from "./JellyfinYearShared";
import type { YearModel } from "./yearModel";
import TimeChapter from "./JellyfinYearTime";
import TitlesChapter from "./JellyfinYearTitles";
import AnimeChapter from "./JellyfinYearAnime";
import PeopleChapter from "./JellyfinYearPeople";

export interface YearChapterProps {
  model: YearModel;
  number: number;
  label: string;
  accent: YearAccent;
}

export interface YearChapter {
  key: string;
  label: string;
  accent: YearAccent;
  Chapter: ComponentType<YearChapterProps>;
  shows?: (model: YearModel) => boolean;
}

export const YEAR_CHAPTERS: YearChapter[] = [
  { key: "time", label: "Time", accent: "blue", Chapter: TimeChapter },
  { key: "titles", label: "Titles", accent: "blue", Chapter: TitlesChapter, shows: (model) => model.data.titles.length > 0 },
  { key: "anime", label: "Anime", accent: "pink", Chapter: AnimeChapter, shows: (model) => model.data.totals.anime.plays > 0 },
  { key: "people", label: "People and places", accent: "blue", Chapter: PeopleChapter, shows: (model) => model.data.titles.some((title) => title.facts) },
];
