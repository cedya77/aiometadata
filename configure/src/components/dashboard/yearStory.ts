import type { ComponentType } from "react";
import { artAt } from "./art";
import { AnimeSlide, FaceSlide, IntroSlide, MapSlide, OutroSlide, RhythmSlide, TopShowSlide, type StorySlideProps } from "./JellyfinYearStorySlides";
import { yearPlaces } from "./yearPlaces";
import { rankedAnime, topShowOf, wallPosters, yearBackdrop, yearTime, type YearModel } from "./yearModel";

export interface StorySlide {
  key: string;
  label: string;
  Slide: ComponentType<StorySlideProps>;
  shows?: (model: YearModel) => boolean;
  /** Art worth fetching while the slide before it plays. */
  art?: (model: YearModel) => Array<string | null>;
}

const RHYTHM_MIN_PLAYS = 20;

export const YEAR_STORY: StorySlide[] = [
  { key: "intro", label: "Your year", Slide: IntroSlide, art: (model) => [...wallPosters(model, 36), artAt(yearBackdrop(model), "w1280", 1280)] },
  {
    key: "show",
    label: "Your number one show",
    Slide: TopShowSlide,
    shows: (model) => !!topShowOf(model),
    art: (model) => {
      const show = topShowOf(model);
      return [artAt(show?.facts?.background ?? show?.facts?.poster, "w1280", 1280), artAt(show?.facts?.logo, "w500", 500)];
    },
  },
  { key: "rhythm", label: "Your rhythm", Slide: RhythmSlide, shows: (model) => yearTime(model).rhythm >= RHYTHM_MIN_PLAYS },
  { key: "anime", label: "Your anime year", Slide: AnimeSlide, shows: (model) => !!model.data.anime?.entries.length, art: (model) => rankedAnime(model).slice(0, 5).map((entry) => entry.image) },
  {
    key: "face",
    label: "The face of your year",
    Slide: FaceSlide,
    shows: (model) => !!model.data.people?.cast.length,
    art: (model) => {
      const face = model.data.people?.cast[0];
      return [artAt(face?.photo, "h632", 632), ...(face?.shown ?? []).slice(0, 3).map((title) => artAt(title.poster, "w185", 185))];
    },
  },
  { key: "map", label: "Your map", Slide: MapSlide, shows: (model) => yearPlaces(model.data.titles).ranked.length > 0 || new Set(model.data.titles.map((title) => title.facts?.year).filter(Boolean)).size > 1 },
  { key: "outro", label: "That was your year", Slide: OutroSlide },
];
