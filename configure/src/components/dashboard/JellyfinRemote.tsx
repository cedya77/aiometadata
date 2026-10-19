import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Cast, Check, Globe, ImageOff, Loader2, Monitor, MonitorPlay, Play, Smartphone, SquareArrowOutUpRight, Tv } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useJellyfinDevices, useJellyfinOpenOn, type DashboardTab, type JellyfinDevice } from "@/hooks/useDashboardQueries";
import { useRemembered } from "./jellyfinUtils";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export interface RemoteTarget {
  itemId: string;
  itemType: "Episode" | "Movie" | "Series";
  itemName: string;
  heading: string;
  sub: string | null;
  still: string | null;
}

type Mode = "play" | "open";

function DeviceIcon({ device }: { device: JellyfinDevice }) {
  const text = `${device.client} ${device.device}`;
  const Icon = /\btv\b|android ?tv|tizen|webos|roku|fire ?tv|shield|living room/i.test(text) ? Tv
    : /iphone|ipad|ios|android|mobile|phone|swiftfin|findroid/i.test(text) ? Smartphone
    : /chrome|firefox|safari|edge|opera|browser/i.test(text) ? Globe
    : /windows|macos|mac os|linux|desktop|mpv|theater/i.test(text) ? Monitor
    : MonitorPlay;
  return <Icon className="size-5" />;
}

function known(device: JellyfinDevice): boolean {
  return device.client !== "Unknown";
}

export default function RemoteSheet({ userUUID, profile, profileName, target, at, activeTab, onClose }: {
  userUUID: string;
  profile: string | null;
  profileName: string;
  target: RemoteTarget;
  at: { x: number; y: number };
  activeTab: DashboardTab;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState(at);
  const [mode, setMode] = useRemembered<Mode>("jellyfin.remote.mode", "play");
  const [last, setLast] = useRemembered<string | null>("jellyfin.remote.device", null);
  const [sending, setSending] = useState<string | null>(null);
  const [stillFailed, setStillFailed] = useState(false);
  const { data, isLoading, refetch } = useJellyfinDevices(userUUID, profile, true, { activeTab });
  const openOn = useJellyfinOpenOn();

  const devices = (data?.devices ?? []).filter(known).sort((a, b) => Number(b.deviceId === last) - Number(a.deviceId === last) || a.client.localeCompare(b.client));
  const silent = (data?.devices ?? []).length - devices.length;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPlace({ x: Math.max(8, Math.min(at.x, window.innerWidth - width - 8)), y: at.y + height + 8 > window.innerHeight ? Math.max(8, at.y - height - 8) : at.y });
  }, [at, devices.length, isLoading]);

  useEffect(() => {
    const away = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const send = async (device: JellyfinDevice) => {
    setSending(device.deviceId);
    try {
      const reached = await openOn(userUUID, profile, device.deviceId, { itemId: target.itemId, itemType: target.itemType, itemName: target.itemName, play: mode === "play" });
      if (!reached) {
        toast.error(`${device.client} on ${device.device} just went away`);
        void refetch();
        return;
      }
      setLast(device.deviceId);
      toast.success(mode === "play" ? `Playing on ${device.client} · ${device.device}` : `Opened on ${device.client} · ${device.device}`);
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not reach the device");
    } finally {
      setSending(null);
    }
  };

  const still = stillFailed ? null : target.still;
  const segment = (value: Mode, label: string, icon: React.ReactNode) => (
    <button type="button" onClick={() => setMode(value)} aria-pressed={mode === value} className={cx("flex h-full flex-1 items-center justify-center gap-1.5 rounded-full text-[13px] font-semibold transition-colors [&_svg]:size-3.5", mode === value ? "bg-white text-black shadow" : "text-muted-foreground hover:text-foreground")}>
      {icon} {label}
    </button>
  );

  return createPortal(
    <div ref={ref} role="dialog" aria-label={mode === "play" ? "Play on" : "Open on"} onClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()} style={{ left: place.x, top: place.y }} className="fixed z-[120] w-[22rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-2xl bg-popover/95 shadow-2xl shadow-black/60 ring-1 ring-white/10 backdrop-blur-xl animate-fade-in">
      <div className="flex items-center gap-3 p-3">
        <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-md bg-white/5 ring-1 ring-inset ring-white/10">
          {still ? <img src={still} alt="" onError={() => setStillFailed(true)} className="h-full w-full object-cover" /> : <span className="flex h-full w-full items-center justify-center"><ImageOff className="size-5 text-muted-foreground/60" /></span>}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{mode === "play" ? "Play on" : "Open on"}</p>
          <p className="line-clamp-2 text-sm font-semibold leading-snug">{target.heading}</p>
          {target.sub && <p className="truncate text-xs text-muted-foreground">{target.sub}</p>}
        </div>
      </div>

      <div className="px-3">
        <div className="flex h-9 items-center gap-1 rounded-full bg-white/[0.07] p-1 ring-1 ring-inset ring-white/10">
          {segment("play", "Play", <Play className="fill-current" />)}
          {segment("open", "Show page", <SquareArrowOutUpRight />)}
        </div>
      </div>

      <div className="mt-2 max-h-[min(22rem,50vh)] overflow-y-auto p-1.5 pt-1">
        {isLoading && !data ? (
          [0, 1].map((n) => (
            <div key={n} className="flex items-center gap-3 px-2 py-2"><Skeleton className="size-10 rounded-xl" /><div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-28" /><Skeleton className="h-3 w-20" /></div></div>
          ))
        ) : devices.length === 0 && !silent ? (
          <div className="flex flex-col items-center gap-2 px-6 pb-5 pt-4 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-white/[0.07] ring-1 ring-white/10"><Cast className="size-5 text-muted-foreground" /></span>
            <p className="text-sm font-semibold">Nothing connected</p>
            <p className="text-xs leading-relaxed text-muted-foreground">Open Pelagica or another Jellyfin app signed in as <span className="font-medium text-foreground">{profileName}</span> and it shows up here.</p>
          </div>
        ) : (
          devices.map((device) => {
            const able = mode === "play" ? device.canPlay : device.canOpen;
            const why = mode === "play" ? "Can't play from here" : "Can't open pages from here";
            return (
              <button key={device.deviceId} type="button" disabled={!able || sending !== null} onClick={() => void send(device)} className={cx("group flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors", able ? "hover:bg-white/10" : "cursor-not-allowed opacity-45")}>
                <span className="relative flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.07] text-foreground/90 ring-1 ring-inset ring-white/10">
                  <DeviceIcon device={device} />
                  {able && <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full bg-emerald-400 ring-2 ring-popover" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{device.client}</span>
                  <span className="block truncate text-xs text-muted-foreground">{able ? device.device : why}</span>
                </span>
                {sending === device.deviceId
                  ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                  : device.deviceId === last && able
                    ? <Check className="size-4 shrink-0 text-blue-400" strokeWidth={3} />
                    : able && (mode === "play"
                      ? <Play className="size-4 shrink-0 fill-current text-foreground/0 transition-colors group-hover:text-foreground/70" />
                      : <SquareArrowOutUpRight className="size-4 shrink-0 text-foreground/0 transition-colors group-hover:text-foreground/70" />)}
              </button>
            );
          })
        )}
        {silent > 0 && !(isLoading && !data) && (
          <p className="px-2 pb-1.5 pt-2 text-xs leading-relaxed text-muted-foreground">
            {silent === 1 ? "1 more app is" : `${silent} more apps are`} connected but {silent === 1 ? "hasn't" : "haven't"} said what {silent === 1 ? "it" : "they"} can do. Reopening {silent === 1 ? "it" : "them"} usually helps.
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
