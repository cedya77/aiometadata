import type { ComponentType } from "react";
import type { YearAccent } from "./JellyfinYearShared";
import type { YearModel } from "./yearModel";
import TimeChapter from "./JellyfinYearTime";

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
];
