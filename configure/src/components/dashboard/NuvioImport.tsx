import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Loader2, Lock } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { libraryFile, nuvioMessage, profileKey, readProfile, readProfiles, signIn, signOut, type NuvioProfileInfo, type NuvioProfileRows } from "@/lib/nuvioAccount";
import { sessionKeeper } from "@/lib/stremioAccount";

type ProfileRead = { status: "reading" | "done" | "failed"; rows?: NuvioProfileRows; error?: string };

const primary = "flex h-9 items-center gap-2 rounded-full bg-blue-500/90 px-4 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50";
const secondary = "h-9 rounded-full px-4 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50";

const isEmpty = (rows: NuvioProfileRows) => !rows.library.length && !rows.watched.length && !rows.progress.length;
const itemsOf = (rows: NuvioProfileRows) => rows.library.length + rows.watched.length + rows.progress.length;

export default function NuvioImport({ open, onOpenChange, onLibrary }: { open: boolean; onOpenChange: (open: boolean) => void; onLibrary: (file: File) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<NuvioProfileInfo[] | null>(null);
  const [ticked, setTicked] = useState<Record<number, boolean>>({});
  const [reads, setReads] = useState<Record<number, ProfileRead>>({});
  const token = useRef<string | null>(null);
  const [sessions] = useState(() => sessionKeeper(signOut));

  const forget = useCallback(() => {
    sessions.endAll();
    token.current = null;
    setPassword("");
    setProfiles(null);
    setTicked({});
    setReads({});
    setError(null);
    setBusy(false);
  }, [sessions]);

  useEffect(() => {
    if (!open) forget();
  }, [open, forget]);

  useEffect(() => () => sessions.endAll(), [sessions]);

  const finish = (parts: Array<{ profile: NuvioProfileInfo; rows: NuvioProfileRows }>) => {
    onLibrary(libraryFile(parts.map(({ profile, rows }) => ({ key: profileKey(profile), name: profile.name, ...rows }))));
    sessions.endAll();
    onOpenChange(false);
  };

  const start = async (event: FormEvent) => {
    event.preventDefault();
    const mine = sessions.current();
    setBusy(true);
    setError(null);
    try {
      const key = await signIn(email.trim(), password);
      if (!sessions.keep(key, mine)) return;
      token.current = key;
      const found = await readProfiles(key);
      if (sessions.current() !== mine) return;
      if (found.length === 1) {
        const [only] = found;
        const rows = await readProfile(key, only.index);
        if (sessions.current() !== mine) return;
        if (isEmpty(rows)) {
          setError("This Nuvio account has no watch history.");
          return;
        }
        if (rows.watched.length || rows.progress.length) {
          finish([{ profile: only, rows }]);
          return;
        }
        setProfiles([only]);
        setTicked({ [only.index]: true });
        setReads({ [only.index]: { status: "done", rows } });
        return;
      }
      setProfiles(found);
      setTicked(Object.fromEntries(found.map((profile) => [profile.index, profile.listed || profile.index === 1])));
    } catch (failure) {
      if (sessions.current() === mine) setError(nuvioMessage(failure));
    } finally {
      if (sessions.current() === mine) setBusy(false);
    }
  };

  const readOne = async (profile: NuvioProfileInfo, mine: number) => {
    setReads((held) => ({ ...held, [profile.index]: { status: "reading" } }));
    try {
      const rows = await readProfile(token.current!, profile.index);
      if (sessions.current() === mine) setReads((held) => ({ ...held, [profile.index]: { status: "done", rows } }));
    } catch (failure) {
      if (sessions.current() === mine) setReads((held) => ({ ...held, [profile.index]: { status: "failed", error: nuvioMessage(failure) } }));
    }
  };

  const readAll = async () => {
    const mine = sessions.current();
    setBusy(true);
    const queue = (profiles ?? []).filter((profile) => ticked[profile.index] && reads[profile.index]?.status !== "done");
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await readOne(next, mine);
    };
    await Promise.all([worker(), worker()]);
    if (sessions.current() === mine) setBusy(false);
  };

  const chosen = (profiles ?? []).filter((profile) => ticked[profile.index]);
  const ready = chosen.length > 0 && chosen.every((profile) => reads[profile.index]?.status === "done");
  const carry = () => finish(chosen.map((profile) => ({ profile, rows: reads[profile.index].rows! })));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import from Nuvio</DialogTitle>
          <DialogDescription>{profiles ? "Pick the profiles to import." : "Your password goes straight to Nuvio, never to this server."}</DialogDescription>
        </DialogHeader>

        {!profiles ? (
          <form onSubmit={(event) => void start(event)} className="space-y-3">
            <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" autoComplete="email" disabled={busy} />
            <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" autoComplete="current-password" disabled={busy} />
            {error && <p className="text-xs text-amber-200">{error}</p>}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button type="button" onClick={() => onOpenChange(false)} className={secondary}>Cancel</button>
              <button type="submit" disabled={busy || !email.trim() || !password} className={primary}>
                {busy && <Loader2 className="size-3.5 animate-spin" />} Sign in
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="divide-y divide-white/[0.06] overflow-hidden rounded-xl ring-1 ring-inset ring-white/10">
              {profiles.map((profile) => {
                const read = reads[profile.index];
                const counts = profile.counts;
                return (
                  <label key={profile.index} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={Boolean(ticked[profile.index])}
                      disabled={busy}
                      onChange={(event) => setTicked((held) => ({ ...held, [profile.index]: event.target.checked }))}
                      className="size-4 shrink-0 accent-blue-500"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate">{profile.name}</span>
                        {profile.hasPin && <Lock className="size-3.5 shrink-0 text-muted-foreground" />}
                      </span>
                      {counts && (
                        <span className="block text-xs text-muted-foreground">
                          {counts.library.toLocaleString()} saved · {counts.watched.toLocaleString()} watched · {counts.progress.toLocaleString()} in progress
                        </span>
                      )}
                      {!profile.listed && profile.index !== 1 && <span className="block text-xs text-muted-foreground">No longer in Nuvio's profile list</span>}
                    </span>
                    <span className="w-full text-right text-xs sm:w-auto">
                      {read?.status === "reading" && <Loader2 className="ml-auto size-3.5 animate-spin text-muted-foreground" />}
                      {read?.status === "done" && read.rows && <span className="flex items-center justify-end gap-1 text-muted-foreground"><Check className="size-3.5 text-blue-400" />{itemsOf(read.rows).toLocaleString()} items</span>}
                      {read?.status === "failed" && <span className="text-amber-200">{read.error}</span>}
                    </span>
                    {read?.status === "done" && read.rows && !read.rows.watched.length && !read.rows.progress.length && (
                      <span className="w-full text-xs text-amber-200">Nothing watched here. If this profile tracks with Trakt or Simkl, import from there instead.</span>
                    )}
                  </label>
                );
              })}
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button type="button" onClick={() => onOpenChange(false)} className={secondary}>Cancel</button>
              {ready ? (
                <button type="button" onClick={carry} className={primary}>Continue</button>
              ) : (
                <button type="button" onClick={() => void readAll()} disabled={busy || chosen.length === 0} className={primary}>
                  {busy && <Loader2 className="size-3.5 animate-spin" />} Read history
                </button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
