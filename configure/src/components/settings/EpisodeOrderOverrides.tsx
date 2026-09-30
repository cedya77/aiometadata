import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, Trash2, Upload } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfig } from "@/contexts/ConfigContext";

interface SeriesOrders {
  tvdbId: string;
  name: string;
  year?: string;
  orders: { type: string; name: string }[];
}

const ORDER_LABELS: Record<string, string> = {
  default: "Aired Order (Default)",
  official: "Aired Order",
  dvd: "DVD Order",
  absolute: "Absolute Order",
  alternate: "Alternate Order",
  regional: "Regional Order",
  alttwo: "Alternate Order 2",
};

const seriesCache = new Map<string, Promise<SeriesOrders | null>>();
const IMPORT_LANES = 4;
const IMPORT_EXAMPLE = JSON.stringify(
  [
    { tvdbId: "81797", name: "One Piece", order: "absolute" },
    { tvdbId: "73871", name: "Futurama", order: "dvd" },
  ],
  null,
  2,
);

function withoutShow(
  map: Record<string, string>,
  showKey: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(map).filter(
      ([key]) => key !== showKey && key.startsWith("tvdb:"),
    ),
  );
}

function withShow(
  map: Record<string, string>,
  series: SeriesOrders,
  order: string,
): Record<string, string> {
  return {
    ...withoutShow(map, `tvdb:${series.tvdbId}`),
    [`tvdb:${series.tvdbId}`]: order,
  };
}

const displayName = (series: SeriesOrders) =>
  series.year ? `${series.name} (${series.year})` : series.name;

export function EpisodeOrderOverrides({ disabled }: { disabled?: boolean }) {
  const { config, setConfig, auth, maxEpisodeOrders } = useConfig();
  const orders = config.tvdbEpisodeOrders ?? {};
  const shows = Object.entries(orders).filter(
    ([key, value]) => key.startsWith("tvdb:") && value in ORDER_LABELS,
  );
  const atLimit = shows.length >= maxEpisodeOrders;
  const [known, setKnown] = useState<Record<string, SeriesOrders>>({});
  const [tvdbInput, setTvdbInput] = useState("");
  const [picked, setPicked] = useState<SeriesOrders | null>(null);
  const [order, setOrder] = useState("");
  const [loadingSeries, setLoadingSeries] = useState(false);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const tvdbKey = config.apiKeys?.tvdb?.trim();
  const userUUID = auth.userUUID;

  const readSeries = useCallback(
    (tvdbId: string): Promise<SeriesOrders | null> => {
      const cached = seriesCache.get(tvdbId);
      if (cached) return cached;
      const params = new URLSearchParams();
      if (tvdbKey) params.set("apikey", tvdbKey);
      if (userUUID) params.set("userUUID", userUUID);
      const request = fetch(
        `/api/tvdb/episode-orders/${encodeURIComponent(tvdbId)}?${params}`,
      )
        .then(async (response) => {
          const data = await response.json().catch(() => ({}));
          if (!response.ok)
            throw new Error(
              data?.error || `Could not read the series (${response.status})`,
            );
          return data as SeriesOrders;
        })
        .catch((err) => {
          seriesCache.delete(tvdbId);
          throw err;
        });
      seriesCache.set(tvdbId, request);
      return request;
    },
    [tvdbKey, userUUID],
  );

  const showIds = shows.map(([key]) => key.slice("tvdb:".length)).join(",");
  useEffect(() => {
    let cancelled = false;
    for (const tvdbId of showIds ? showIds.split(",") : []) {
      readSeries(tvdbId)
        .then((series) => {
          if (cancelled || !series) return;
          setKnown((prev) =>
            prev[tvdbId] ? prev : { ...prev, [tvdbId]: series },
          );
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [showIds, readSeries]);

  const lookUp = async () => {
    const tvdbId = tvdbInput.trim().replace(/^tvdb:/i, "");
    if (!/^\d+$/.test(tvdbId)) {
      setError("Enter the show's numeric TVDB id.");
      return;
    }
    setLoadingSeries(true);
    setError("");
    try {
      const series = await readSeries(tvdbId);
      if (!series) return;
      setTvdbInput("");
      setPicked(series);
      setOrder(
        series.orders?.find((o) => o.type !== "official")?.type ??
          series.orders?.[0]?.type ??
          "",
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not read the series",
      );
    } finally {
      setLoadingSeries(false);
    }
  };

  const add = () => {
    if (!picked || !order) return;
    if (atLimit && !(`tvdb:${picked.tvdbId}` in orders)) {
      setError(
        `This instance allows ${maxEpisodeOrders} shows with their own episode order. Remove one to add another.`,
      );
      return;
    }
    setConfig((prev) => ({
      ...prev,
      tvdbEpisodeOrders: withShow(prev.tvdbEpisodeOrders ?? {}, picked, order),
    }));
    setKnown((prev) => ({ ...prev, [picked.tvdbId]: picked }));
    setPicked(null);
    setOrder("");
  };

  const changeOrder = (showKey: string, next: string) =>
    setConfig((prev) => ({
      ...prev,
      tvdbEpisodeOrders: { ...(prev.tvdbEpisodeOrders ?? {}), [showKey]: next },
    }));

  const remove = (showKey: string) =>
    setConfig((prev) => ({
      ...prev,
      tvdbEpisodeOrders: withoutShow(prev.tvdbEpisodeOrders ?? {}, showKey),
    }));

  const exportList = () => {
    const list = shows.map(([showKey, showOrder]) => {
      const tvdbId = showKey.slice("tvdb:".length);
      const series = known[tvdbId];
      return {
        tvdbId,
        ...(series ? { name: displayName(series) } : {}),
        order: showOrder,
      };
    });
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(list, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "episode-orders.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  const importList = async (file: File) => {
    setImporting(true);
    setError("");
    setNotice("");
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed))
        throw new Error('expected a list of { "tvdbId", "order" } entries');
      const queue = parsed.map((entry, index) => ({ entry, index }));
      const found: { series: SeriesOrders; order: string; index: number }[] =
        [];
      const skipped: string[] = [];
      const lane = async () => {
        while (queue.length) {
          const { entry, index } = queue.shift()!;
          const tvdbId = String(entry?.tvdbId ?? "")
            .trim()
            .replace(/^tvdb:/i, "");
          const wanted = String(entry?.order ?? "").trim();
          if (!/^\d+$/.test(tvdbId) || !wanted) {
            skipped.push(
              `${entry?.tvdbId ?? "?"} (needs a tvdbId and an order)`,
            );
            continue;
          }
          try {
            const series = await readSeries(tvdbId);
            if (!series) {
              skipped.push(`${tvdbId} (not found on TVDB)`);
            } else if (!series.orders.some((o) => o.type === wanted)) {
              skipped.push(
                `${displayName(series)} (no ${ORDER_LABELS[wanted] ?? wanted})`,
              );
            } else {
              found.push({ series, order: wanted, index });
            }
          } catch {
            skipped.push(`${tvdbId} (not found on TVDB)`);
          }
        }
      };
      await Promise.all(Array.from({ length: IMPORT_LANES }, lane));
      found.sort((a, b) => a.index - b.index);
      const present = new Set(shows.map(([key]) => key));
      let slots = Math.max(0, maxEpisodeOrders - shows.length);
      const accepted: { series: SeriesOrders; order: string }[] = [];
      let overLimit = 0;
      for (const item of found) {
        const key = `tvdb:${item.series.tvdbId}`;
        if (present.has(key)) {
          accepted.push(item);
        } else if (slots > 0) {
          slots -= 1;
          present.add(key);
          accepted.push(item);
        } else {
          overLimit += 1;
        }
      }
      if (accepted.length) {
        setConfig((prev) => ({
          ...prev,
          tvdbEpisodeOrders: accepted.reduce(
            (map, { series, order: chosen }) => withShow(map, series, chosen),
            prev.tvdbEpisodeOrders ?? {},
          ),
        }));
        setKnown((prev) => ({
          ...prev,
          ...Object.fromEntries(
            accepted.map(({ series }) => [series.tvdbId, series]),
          ),
        }));
      }
      const skippedNote = skipped.length
        ? `; skipped ${skipped.length}: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", …" : ""}`
        : "";
      const limitNote = overLimit
        ? `; ${overLimit} left out, over this instance's limit of ${maxEpisodeOrders} shows`
        : "";
      setNotice(
        `Imported ${accepted.length} show${accepted.length === 1 ? "" : "s"}${limitNote}${skippedNote}.`,
      );
    } catch (err) {
      setError(
        `Could not import that file: ${err instanceof Error ? err.message : "unreadable JSON"}`,
      );
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <div className="space-y-3">
      {shows.length > 0 && (
        <ul className="divide-y rounded-md border">
          {shows.map(([showKey, showOrder]) => {
            const tvdbId = showKey.slice("tvdb:".length);
            const series = known[tvdbId];
            const name = series ? displayName(series) : `TVDB ${tvdbId}`;
            return (
              <li
                key={showKey}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span className="min-w-0 truncate">{name}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {series?.orders.length ? (
                    <Select
                      value={showOrder}
                      onValueChange={(next) => changeOrder(showKey, next)}
                      disabled={disabled}
                    >
                      <SelectTrigger
                        className="h-8 w-[170px]"
                        aria-label={`Episode order for ${name}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {series.orders.map((o) => (
                          <SelectItem key={o.type} value={o.type}>
                            {ORDER_LABELS[o.type] ?? o.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="text-muted-foreground">
                      {ORDER_LABELS[showOrder] ?? showOrder}
                    </span>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`Remove ${name}`}
                    onClick={() => remove(showKey)}
                    disabled={disabled}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {picked ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border p-3">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {picked.name}
            {picked.year ? ` (${picked.year})` : ""}
          </span>
          {picked.orders.length ? (
            <Select value={order} onValueChange={setOrder}>
              <SelectTrigger className="w-full sm:w-[200px]">
                <SelectValue placeholder="Episode order" />
              </SelectTrigger>
              <SelectContent>
                {picked.orders.map((o) => (
                  <SelectItem key={o.type} value={o.type}>
                    {ORDER_LABELS[o.type] ?? o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="text-sm text-muted-foreground">
              TVDB lists no episode orders for this show.
            </span>
          )}
          <Button type="button" size="sm" onClick={add} disabled={!order}>
            Add
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setPicked(null)}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Input
            placeholder="TVDB id of the show, e.g. 73871"
            inputMode="numeric"
            value={tvdbInput}
            onChange={(e) => setTvdbInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void lookUp();
              }
            }}
            disabled={disabled}
            autoComplete="off"
          />
          <Button
            type="button"
            onClick={() => void lookUp()}
            disabled={disabled || loadingSeries || !tvdbInput.trim() || atLimit}
          >
            {loadingSeries ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Look up"
            )}
          </Button>
        </div>
      )}
      {atLimit && (
        <p className="text-sm text-muted-foreground">
          You've reached this instance's limit of {maxEpisodeOrders} shows.
          Remove one to add another; orders of listed shows can still be
          changed.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={exportList}
          disabled={!shows.length}
        >
          <Download className="size-4" />
          Export JSON
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => fileInput.current?.click()}
          disabled={disabled || importing}
        >
          {importing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Upload className="size-4" />
          )}
          Import JSON
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {shows.length} of {maxEpisodeOrders}
        </span>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importList(file);
          }}
        />
      </div>
      <details className="text-sm text-muted-foreground">
        <summary className="cursor-pointer select-none">Import format</summary>
        <div className="mt-2 space-y-2">
          <p>
            A list of shows, each with its TVDB id and an order.{" "}
            <code>name</code> is optional and only there to make the file
            readable.
          </p>
          <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 text-xs text-foreground">
            {IMPORT_EXAMPLE}
          </pre>
          <p>
            Orders:{" "}
            {Object.keys(ORDER_LABELS).map((key, index) => (
              <span key={key}>
                {index > 0 && ", "}
                <code>{key}</code>
              </span>
            ))}
            . A show only takes an order TVDB lists for it.
          </p>
        </div>
      </details>
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
