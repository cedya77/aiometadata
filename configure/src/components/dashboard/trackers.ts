import { useMemo } from "react";
import { useTrackerInfo, type TrackerInfo, type TrackerMark } from "@/hooks/useDashboardQueries";

export interface Trackers {
  list: TrackerInfo[];
  of: (id: string) => TrackerInfo | undefined;
  name: (id: string) => string;
  animeOnly: (id: string) => boolean;
  copiesFrom: (id: string, what: "watches" | TrackerMark) => boolean;
  copiesTo: (id: string, what: "watches" | TrackerMark) => boolean;
}

export function useTrackers(): Trackers {
  const { data } = useTrackerInfo();
  return useMemo(() => {
    const list = data ?? [];
    const byId = new Map(list.map((tracker) => [tracker.id, tracker]));
    return {
      list,
      of: (id) => byId.get(id),
      name: (id) => byId.get(id)?.name ?? id,
      animeOnly: (id) => byId.get(id)?.animeOnly === true,
      copiesFrom: (id, what) => (what === "watches" ? byId.get(id)?.datedHistory === true : byId.get(id)?.marks.from.includes(what) === true),
      copiesTo: (id, what) => (what === "watches" ? byId.has(id) : byId.get(id)?.marks.to.includes(what) === true),
    };
  }, [data]);
}
