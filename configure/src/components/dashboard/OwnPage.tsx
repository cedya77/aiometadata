import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ChevronLeft, Lock, Loader2, Users } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { AdminContext } from "@/contexts/AdminContext";
import { navigateDashboard } from "@/lib/dashboardRoute";
import { when } from "./jellyfinUtils";
import {
  keepOwnPageToken,
  noteOwnPageChose,
  noteOwnPageFull,
  ownPageChose,
  ownPageProfiles,
  ownPageStatus,
  ownPageToken,
  ownPageUser,
  signOutOwnPage,
  startOwnPage,
  unlockOwnPage,
  type OwnPageProfile,
} from "@/lib/ownPage";
import DashboardJellyfin from "./DashboardJellyfin";

const MIN_PIN = 4;
const MAX_PIN = 12;
const INK = "text-[#f4f5f7]";
const QUIET = "text-[#aeb3bb]";
const PAGE = `min-h-screen w-full bg-[#0a0b0d] ${INK}`;
const KEY = "size-16 justify-self-center rounded-full text-[22px] font-semibold transition";
const TINTS = ["#d97a1f", "#4b83f0", "#3fa796", "#c65d9a", "#8a6fe0"];

const urlProfile = (): string | null => new URLSearchParams(window.location.search).get("profile");

function Initial({ profile, tint, size = 48 }: { profile: Pick<OwnPageProfile, "name" | "avatar">; tint: string; size?: number }) {
  const box = { width: size, height: size };
  return profile.avatar
    ? <img src={profile.avatar} alt="" style={box} className="shrink-0 rounded-full object-cover" />
    : <span aria-hidden="true" style={{ ...box, background: tint, fontSize: size * 0.42 }} className="flex shrink-0 items-center justify-center rounded-full font-extrabold text-[#0b0d12]">{profile.name.slice(0, 1).toUpperCase()}</span>;
}

function SignIn({ userUUID, off, hours, onDone }: { userUUID: string; off: boolean; hours: number; onDone: (token: string, profiles: OwnPageProfile[]) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { status, body } = await startOwnPage(userUUID, password);
      if (status === 200) onDone(body.token, body.profiles);
      else setError(body.error ?? "That did not work, try again");
    } catch {
      setError("The server could not be reached");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className={`${PAGE} relative overflow-hidden`}>
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-[360px] bg-[radial-gradient(90%_80%_at_25%_0%,rgba(75,131,240,0.38),transparent_70%),radial-gradient(70%_70%_at_90%_10%,rgba(217,122,31,0.22),transparent_70%)]" />
      <div className="relative mx-auto flex w-full max-w-[390px] flex-col gap-[18px] px-6 pb-8 pt-[250px]">
        <div>
          <p className="text-[13px] font-medium text-[#c9cdd4]">AIOMetadata</p>
          <h1 className="mt-1.5 text-[30px] font-extrabold leading-[1.15]">Your viewing page</h1>
          <p className={`mt-2 text-sm leading-[1.45] ${QUIET}`}>{off ? "The owner of this server has not turned on personal pages." : "Your watching, shows, calendar, year and trackers."}</p>
        </div>
        {!off && (
          <form className="flex flex-col gap-[18px]" onSubmit={(event) => void submit(event)}>
            <div>
              <label htmlFor="own-page-password" className="mb-2 block text-[13px] font-medium">Configuration password</label>
              <input id="own-page-password" type="password" autoComplete="current-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} className={`h-12 w-full rounded-xl border border-white/20 bg-[#15171b] px-3.5 text-base ${INK} outline-none focus:border-[#4b83f0]`} />
            </div>
            {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
            <button type="submit" disabled={busy || !password} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#f4f5f7] text-[15px] font-semibold text-[#0a0b0d] transition disabled:opacity-60">{busy && <Loader2 className="size-4 animate-spin" />} Continue</button>
            <p className={`text-xs leading-normal ${QUIET}`}>Stays signed in on this browser for {hours} hours. Already signed in to your configuration here? This step is skipped.</p>
          </form>
        )}
      </div>
    </main>
  );
}

function Who({ profiles, onPick, onEveryone }: { profiles: OwnPageProfile[]; onPick: (profile: OwnPageProfile) => void; onEveryone: (() => void) | null }) {
  const row = "flex min-h-[72px] w-full items-center gap-3.5 rounded-2xl border border-white/[0.09] bg-white/[0.05] px-3.5 py-3 text-left transition hover:bg-white/[0.09]";
  return (
    <main className={PAGE}>
      <div className="mx-auto flex w-full max-w-[390px] flex-col gap-6 px-6 pb-6 pt-[88px]">
        <h1 className="text-[30px] font-extrabold">Who's watching?</h1>
        <div className="flex flex-col gap-2.5">
          {profiles.map((profile, index) => (
            <button key={profile.key} type="button" onClick={() => onPick(profile)} className={row}>
              <Initial profile={profile} tint={TINTS[index % TINTS.length]} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base font-semibold">{profile.name}</span>
                {profile.locked
                  ? <span className={`mt-0.5 block text-[13px] ${QUIET}`}>Needs a PIN</span>
                  : profile.activeAt && <span className={`mt-0.5 block text-[13px] ${QUIET}`}>Active {when(profile.activeAt)}</span>}
              </span>
              {profile.locked && <Lock className="size-[18px] shrink-0 text-[#c9cdd4]" aria-label="Locked" />}
            </button>
          ))}
          {onEveryone && (
            <button type="button" onClick={onEveryone} className={row}>
              <span aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center rounded-full bg-white/10"><Users className="size-5" /></span>
              <span className="block text-base font-semibold">Everyone</span>
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

function Pin({ userUUID, profile, tint, onBack, onDone }: { userUUID: string; profile: OwnPageProfile; tint: string; onBack: () => void; onDone: (token: string, profiles: OwnPageProfile[]) => void }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = useCallback(async (entered: string) => {
    setBusy(true);
    setError(null);
    try {
      const { status, body } = await unlockOwnPage(userUUID, profile.key, entered);
      if (status === 200) onDone(body.token, body.profiles);
      else {
        setPin("");
        setError(body.error ?? "That PIN did not open this profile");
      }
    } catch {
      setError("The server could not be reached");
    } finally {
      setBusy(false);
    }
  }, [userUUID, profile.key, onDone]);
  const add = (digit: string) => setPin((held) => (held.length < MAX_PIN ? held + digit : held));
  const drop = () => setPin((held) => held.slice(0, -1));
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (/^\d$/.test(event.key)) add(event.key);
      else if (event.key === "Backspace") drop();
      else if (event.key === "Enter" && pin.length >= MIN_PIN && !busy) void submit(pin);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pin, busy, submit]);
  const dots = Math.max(MIN_PIN, pin.length);
  return (
    <main className={PAGE}>
      <div className="mx-auto flex w-full max-w-[390px] flex-col items-center gap-[18px] px-6 pb-8 pt-[72px]">
        <button type="button" onClick={onBack} aria-label="Back to who's watching" className="flex size-11 items-center justify-center self-start rounded-full border border-white/[0.14]"><ChevronLeft className="size-[18px]" /></button>
        <Initial profile={profile} tint={tint} size={72} />
        <h1 className="text-2xl font-extrabold">{profile.name}</h1>
        <p className={`-mt-2.5 text-sm ${QUIET}`}>Enter this profile's PIN</p>
        <div role="status" aria-label={`${pin.length} digits entered`} className="mb-2.5 mt-1.5 flex flex-wrap justify-center gap-3.5">
          {Array.from({ length: dots }, (_, index) => <span key={index} className={`size-3.5 rounded-full ${index < pin.length ? "bg-[#f4f5f7]" : "border-2 border-[#6d727a]"}`} />)}
        </div>
        <div className="grid grid-cols-[repeat(3,76px)] gap-3">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => <button key={digit} type="button" onClick={() => add(digit)} className={`${KEY} bg-white/[0.07] hover:bg-white/[0.12]`}>{digit}</button>)}
          <button type="button" disabled={busy || pin.length < MIN_PIN} onClick={() => void submit(pin)} className="flex size-16 items-center justify-center justify-self-center rounded-full text-[13px] font-medium transition disabled:opacity-40">{busy ? <Loader2 className="size-4 animate-spin" /> : "Open"}</button>
          <button type="button" onClick={() => add("0")} className={`${KEY} bg-white/[0.07] hover:bg-white/[0.12]`}>0</button>
          <button type="button" aria-label="Delete a digit" onClick={drop} className="size-16 justify-self-center rounded-full text-[13px] font-medium">Delete</button>
        </div>
        {error
          ? <p role="alert" className="mt-2 text-center text-xs leading-normal text-red-300">{error}</p>
          : <p className={`mt-2 text-center text-xs leading-normal ${QUIET}`}>Too many wrong tries and this profile waits a few minutes.</p>}
      </div>
    </main>
  );
}

function TopBar() {
  return (
    <div className="hidden items-center justify-between border-b border-white/[0.08] px-6 py-3 md:flex">
      <span className="text-base font-bold">AIOMetadata</span>
      <button type="button" onClick={signOutOwnPage} className="rounded-full border border-white/[0.14] px-3.5 py-1.5 text-[13px] font-medium transition hover:bg-white/[0.06]">Sign out</button>
    </div>
  );
}

export default function OwnPage() {
  const userUUID = ownPageUser() ?? "";
  const [state, setState] = useState<"loading" | "off" | "signin" | "ready">("loading");
  const [profiles, setProfiles] = useState<OwnPageProfile[]>([]);
  const [asking, setAsking] = useState<OwnPageProfile | null>(null);
  const [chose, setChose] = useState(() => urlProfile() !== null || ownPageChose());
  const [hours, setHours] = useState(24);

  const take = useCallback((next: OwnPageProfile[]) => {
    noteOwnPageFull(next.every((profile) => profile.open));
    setProfiles(next);
    setState("ready");
  }, []);

  useEffect(() => {
    // A sign-in made on the configuration page arrives in the address, and leaves it at once.
    const handed = new URLSearchParams(window.location.hash.slice(1)).get("token");
    if (handed) {
      keepOwnPageToken(userUUID, handed);
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
    let live = true;
    void ownPageStatus().then(({ body }) => {
      if (live && Number(body?.hours) > 0) setHours(Number(body.hours));
    }).catch(() => undefined);
    const read = async () => {
      if (ownPageToken()) {
        const held = await ownPageProfiles(userUUID);
        if (!live) return;
        if (held.status === 200) return take(held.body.profiles);
        if (held.status === 404) return setState("off");
        keepOwnPageToken(userUUID, null);
      }
      // An account already signed in here needs no password.
      const fresh = await startOwnPage(userUUID);
      if (!live) return;
      if (fresh.status === 200) {
        keepOwnPageToken(userUUID, fresh.body.token);
        take(fresh.body.profiles);
      } else setState(fresh.status === 404 ? "off" : "signin");
    };
    read().catch(() => {
      if (live) setState("signin");
    });
    return () => {
      live = false;
    };
  }, [userUUID, take]);

  const enter = useCallback((profile: string | null) => {
    noteOwnPageChose(true);
    setChose(true);
    navigateDashboard({ tab: "jellyfin", config: userUUID, profile, page: null }, { replace: true });
  }, [userUUID]);

  const admin = useMemo(() => ({
    isAdmin: true,
    isGuest: false,
    adminKey: null,
    session: null,
    ssoEnabled: false,
    signOut: async () => signOutOwnPage(),
    login: async () => false,
    loginAsGuest: () => undefined,
    logout: signOutOwnPage,
    isLoading: false,
    adminKeyConfigured: true,
    logViewerMaxEntries: 0,
    guestModeEnabled: false,
    jellyfinEnabled: true,
  }), []);

  const tintOf = (profile: OwnPageProfile) => TINTS[Math.max(0, profiles.indexOf(profile)) % TINTS.length];
  if (state === "loading") return <main className={`${PAGE} flex items-center justify-center`}><Loader2 className={`size-6 animate-spin ${QUIET}`} /></main>;
  if (state === "off" || state === "signin") {
    return (
      <SignIn userUUID={userUUID} off={state === "off"} hours={hours} onDone={(token, next) => {
        keepOwnPageToken(userUUID, token);
        take(next);
      }} />
    );
  }
  if (asking) {
    return (
      <Pin userUUID={userUUID} profile={asking} tint={tintOf(asking)} onBack={() => setAsking(null)} onDone={(token, next) => {
        keepOwnPageToken(userUUID, token);
        take(next);
        setAsking(null);
        enter(asking.key);
      }} />
    );
  }
  const everyProfile = profiles.every((profile) => profile.open);
  const allowed = urlProfile() === null ? everyProfile : profiles.some((profile) => profile.open && profile.key === (urlProfile() === "main" ? "" : urlProfile()));
  if (profiles.length > 1 && (!chose || !allowed)) {
    return <Who profiles={profiles} onPick={(profile) => (profile.locked ? setAsking(profile) : enter(profile.key))} onEveryone={everyProfile ? () => enter(null) : null} />;
  }
  if (!allowed) {
    // One profile with a PIN: nothing to pick, only the PIN to ask.
    return <Pin userUUID={userUUID} profile={profiles[0]} tint={tintOf(profiles[0])} onBack={signOutOwnPage} onDone={(token, next) => {
      keepOwnPageToken(userUUID, token);
      take(next);
      enter(null);
    }} />;
  }
  return (
    <AdminContext.Provider value={admin}>
      <div className="dark min-h-screen w-full bg-background text-foreground">
        <TopBar />
        <DashboardJellyfin activeTab="jellyfin" />
        <Toaster />
      </div>
    </AdminContext.Provider>
  );
}
