import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Check, Copy, Download } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Kind = "movie" | "show" | "season" | "episode";

type Field = {
  name: string;
  value: "string" | "number";
  need: "required" | "one of" | "optional";
  on: Kind[];
  about: ReactNode;
  hint?: ReactNode;
};

const ALL: Kind[] = ["movie", "show", "season", "episode"];

const IDENTIFY: Field[] = [
  {
    name: "type",
    value: "string",
    need: "required",
    on: ALL,
    about: "What the row is about.",
    hint: <>One of <Code>movie</Code>, <Code>show</Code>, <Code>season</Code> or <Code>episode</Code>.</>,
  },
  {
    name: "imdb_id",
    value: "string",
    need: "one of",
    on: ALL,
    about: "The IMDb id, like tt0133093.",
    hint: "On a season or episode row, it is the show's id.",
  },
  {
    name: "tmdb_id",
    value: "number",
    need: "one of",
    on: ALL,
    about: "The TMDB id.",
    hint: "On a season or episode row, it is the show's id.",
  },
  {
    name: "tvdb_id",
    value: "number",
    need: "one of",
    on: ["show", "season", "episode"],
    about: "The TVDB id of the show.",
  },
  {
    name: "title",
    value: "string",
    need: "one of",
    on: ALL,
    about: "The name, for rows without an id. It is matched on LumiereDB, then TMDB.",
    hint: <>Add <Code>year</Code> for a sure match. When two titles share a name and year, you pick the right one before anything is written.</>,
  },
  {
    name: "year",
    value: "number",
    need: "optional",
    on: ALL,
    about: "The release year, or the year a show first aired.",
  },
  {
    name: "season",
    value: "number",
    need: "required",
    on: ["season", "episode"],
    about: "The season number, as TMDB numbers it.",
  },
  {
    name: "episode",
    value: "number",
    need: "required",
    on: ["episode"],
    about: "The episode number within the season.",
  },
];

const ACTIONS: Field[] = [
  {
    name: "watched_at",
    value: "string",
    need: "optional",
    on: ["movie", "episode"],
    about: "When it was watched. Each row is one viewing, so a rewatch is another row.",
    hint: <>Use <Code>unknown</Code> when the date is lost.</>,
  },
  {
    name: "position_seconds",
    value: "number",
    need: "optional",
    on: ["movie", "episode"],
    about: "Where it was stopped, for Continue Watching.",
    hint: <>Or give <Code>progress</Code> instead when the app only knows how far in it was.</>,
  },
  {
    name: "progress",
    value: "number",
    need: "optional",
    on: ["movie", "episode"],
    about: "How far in it was stopped, as a percentage between 0 and 100.",
  },
  {
    name: "runtime_seconds",
    value: "number",
    need: "optional",
    on: ["movie", "episode"],
    about: "The full length. Read with a position or progress.",
    hint: "Left out, the runtime is read from this server's metadata.",
  },
  {
    name: "paused_at",
    value: "string",
    need: "optional",
    on: ["movie", "episode"],
    about: "When it was stopped, so a newer position here is not replaced by an older one.",
  },
  {
    name: "rating",
    value: "number",
    need: "optional",
    on: ALL,
    about: "A whole number from 1 to 10.",
  },
  {
    name: "rated_at",
    value: "string",
    need: "optional",
    on: ALL,
    about: "When it was rated.",
    hint: <>Read only with a <Code>rating</Code>.</>,
  },
  {
    name: "watchlisted_at",
    value: "string",
    need: "optional",
    on: ["movie", "show"],
    about: "When it went on the watchlist.",
    hint: <>Use <Code>unknown</Code> when the date is lost.</>,
  },
  {
    name: "dropped_at",
    value: "string",
    need: "optional",
    on: ["show"],
    about: "When the show was dropped.",
  },
];

const SAMPLE = [
  { type: "movie", imdb_id: "tt0133093", watched_at: "2024-05-01T20:15:00Z", rating: 9, rated_at: "2024-05-01T22:30:00Z" },
  { type: "movie", title: "Past Lives", year: 2023, watchlisted_at: "2024-06-02" },
  { type: "episode", tmdb_id: 1396, season: 1, episode: 1, watched_at: "unknown" },
  { type: "episode", tmdb_id: 1396, season: 1, episode: 2, position_seconds: 1260, runtime_seconds: 2820, paused_at: "2024-05-03T21:40:00Z" },
  { type: "movie", imdb_id: "tt0816692", progress: 42.5, paused_at: "2024-05-04" },
  { type: "show", tvdb_id: 121361, rating: 10, rated_at: "2024-07-10" },
  { type: "show", title: "Lost", year: 2004, dropped_at: "2023-11-20" },
];

const COLUMNS = [...IDENTIFY, ...ACTIONS].map((field) => field.name);

const SAMPLE_JSON = `${JSON.stringify(SAMPLE, null, 2)}\n`;

const SAMPLE_CSV = `${COLUMNS.join(",")}\n${SAMPLE.map((row) => COLUMNS.map((column) => String((row as Record<string, unknown>)[column] ?? "")).join(",")).join("\n")}\n`;

const NOTES: ReactNode[] = [
  <>Dates are ISO 8601, like <Code>2024-05-01T20:15:00Z</Code>. A day alone, like <Code>2024-05-01</Code>, works too, and a time with no zone is UTC.</>,
  <>One row can hold several things at once: a viewing, a rating and a watchlist date.</>,
  <>A paused position puts the title in Continue Watching. Without <Code>runtime_seconds</Code>, the length comes from this server's metadata.</>,
  <>A spreadsheet works as well: save it as CSV with these names as the header row, and leave cells empty where a field does not apply.</>,
  <>You see what will change before anything is written, with every row that could not be read and why.</>,
  <>Importing the same list again is safe. The newer state of each title wins, and a viewing already in the history is not added twice.</>,
];

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-md bg-white/[0.07] px-1.5 py-0.5 font-mono text-[0.85em] text-foreground/90">{children}</code>;
}

function highlightJson(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const token = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?)/g;
  let last = 0;
  for (const match of text.matchAll(token)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (match[1] && match[2]) out.push(<span key={at} className="text-sky-300">{match[1]}</span>, match[2]);
    else if (match[1]) out.push(<span key={at} className="text-emerald-300">{match[1]}</span>);
    else out.push(<span key={at} className="text-amber-300">{match[3]}</span>);
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function highlightCsv(text: string): ReactNode[] {
  const [header, ...rows] = text.trimEnd().split("\n");
  return [
    <span key="header" className="text-sky-300">{header}</span>,
    ...rows.map((row, index) => <span key={index}>{"\n"}{row.split(",").map((cell, at) => <span key={at}>{at ? <span className="text-muted-foreground/50">,</span> : null}<span className="text-emerald-300">{cell}</span></span>)}</span>),
  ];
}

const NEED_STYLE: Record<Field["need"], string> = {
  required: "bg-blue-500/15 text-blue-300 ring-blue-500/30",
  "one of": "bg-violet-500/15 text-violet-300 ring-violet-500/30",
  optional: "bg-white/[0.04] text-muted-foreground ring-white/10",
};

function FieldCard({ field }: { field: Field }) {
  const everywhere = field.on.length === ALL.length;
  return (
    <div className="rounded-xl bg-white/[0.03] p-3.5 ring-1 ring-inset ring-white/[0.08] transition-colors hover:bg-white/[0.045]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="font-mono text-sm font-semibold text-sky-300">{field.name}</span>
        <span className="font-mono text-xs text-muted-foreground">{field.value}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ${NEED_STYLE[field.need]}`}>{field.need}</span>
        {!everywhere && (
          <span className="ml-auto flex flex-wrap gap-1">
            {field.on.map((kind) => (
              <span key={kind} className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] text-muted-foreground">{kind}</span>
            ))}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-foreground/90">{field.about}</p>
      {field.hint && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{field.hint}</p>}
    </div>
  );
}

function Section({ title, lead, children }: { title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {lead && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{lead}</p>}
      </div>
      {children}
    </section>
  );
}

export default function HistoryImportGuide({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [format, setFormat] = useState<"json" | "csv">("json");
  const [copied, setCopied] = useState(false);
  const sample = format === "json" ? SAMPLE_JSON : SAMPLE_CSV;
  const highlighted = useMemo(() => (format === "json" ? highlightJson(SAMPLE_JSON) : highlightCsv(SAMPLE_CSV)), [format]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sample);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy the example");
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([sample], { type: format === "json" ? "application/json" : "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `watch-history-example.${format}`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import from any app</DialogTitle>
          <DialogDescription className="leading-relaxed">
            Write a watch history from any app as a JSON or CSV list, then choose it under Import, From an export file. Trakt and Letterboxd exports, and exports from this server, are read as they are.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <section className="overflow-hidden rounded-xl bg-black/30 ring-1 ring-inset ring-white/10">
            <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2">
              <div className="flex rounded-full bg-white/[0.05] p-0.5 text-xs">
                {(["json", "csv"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={format === option}
                    onClick={() => setFormat(option)}
                    className={`rounded-full px-3 py-1 font-medium uppercase transition-colors ${format === option ? "bg-white/[0.12] text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    {option}
                  </button>
                ))}
              </div>
              <span className="ml-auto flex items-center gap-1">
                <button type="button" onClick={() => void copy()} className="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground">
                  {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy"}
                </button>
                <button type="button" onClick={download} className="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground">
                  <Download className="size-3.5" /> Download
                </button>
              </span>
            </div>
            <pre className="max-h-64 overflow-auto px-4 py-3 font-mono text-[12px] leading-relaxed text-foreground/80">{highlighted}</pre>
          </section>

          <Section title="Name the title" lead={<>Every row needs a <Code>type</Code> and one of the ids or a <Code>title</Code>. An id is the surest match.</>}>
            <div className="grid gap-2">{IDENTIFY.map((field) => <FieldCard key={field.name} field={field} />)}</div>
          </Section>

          <Section title="Say what happened" lead="Give a row at least one of these. A row with a field its type cannot take is left out, and the preview says why.">
            <div className="grid gap-2">{ACTIONS.map((field) => <FieldCard key={field.name} field={field} />)}</div>
          </Section>

          <Section title="Good to know">
            <ul className="space-y-2">
              {NOTES.map((note, index) => (
                <li key={index} className="flex gap-2.5 text-sm leading-relaxed text-foreground/85">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-blue-400/80" />
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
