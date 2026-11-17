// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useMemo } from "react";
import { useTrackerInfo, type TrackerInfo, type TrackerMark } from "@/hooks/useDashboardQueries";

/** The copy destination that is the history on this server, not a tracker. */
export const HERE = "here";

export interface Trackers {
  list: TrackerInfo[];
  of: (id: string) => TrackerInfo | undefined;
  name: (id: string) => string;
  /** The name as it reads inside a sentence. */
  inline: (id: string) => string;
  animeOnly: (id: string) => boolean;
  copiesFrom: (id: string, what: "watches" | TrackerMark) => boolean;
  copiesTo: (id: string, what: "watches" | TrackerMark) => boolean;
}

export function useTrackers(): Trackers {
  const { data } = useTrackerInfo();
  return useMemo(() => {
    const list = data ?? [];
    const byId = new Map(list.map((tracker) => [tracker.id, tracker]));
    const name = (id: string) => (id === HERE ? "Your history here" : byId.get(id)?.name ?? id);
    return {
      list,
      of: (id) => byId.get(id),
      name,
      inline: (id) => (id === HERE ? "your history here" : name(id)),
      animeOnly: (id) => byId.get(id)?.animeOnly === true,
      copiesFrom: (id, what) => (what === "watches" ? byId.get(id)?.datedHistory === true : byId.get(id)?.marks.from.includes(what) === true),
      copiesTo: (id, what) => (id === HERE ? what === "watches" : what === "watches" ? byId.has(id) : byId.get(id)?.marks.to.includes(what) === true),
    };
  }, [data]);
}
