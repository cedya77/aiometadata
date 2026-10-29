import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Loader2, Lock } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { libraryFile, openProfile, readAccount, readLibrary, sessionKeeper, signIn, stremioMessage, type StremioProfileInfo } from "@/lib/stremioAccount";

type ProfileRead = { status: "reading" | "done" | "failed"; items?: unknown[]; error?: string };

const primary = "flex h-9 items-center gap-2 rounded-full bg-blue-500/90 px-4 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50";
const secondary = "h-9 rounded-full px-4 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50";

export default function StremioImport({ open, onOpenChange, onLibrary }: { open: boolean; onOpenChange: (open: boolean) => void; onLibrary: (file: File) => void }) {
  const [useKey, setUseKey] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<StremioProfileInfo[] | null>(null);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [pins, setPins] = useState<Record<string, string>>({});
  const [reads, setReads] = useState<Record<string, ProfileRead>>({});
  const accountKey = useRef<string | null>(null);
  const profileKeys = useRef<Record<string, string>>({});
  const [sessions] = useState(() => sessionKeeper());

  const forget = useCallback(() => {
    sessions.endAll();
    accountKey.current = null;
    profileKeys.current = {};
    setPassword("");
    setPasted("");
    setPins({});
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

  const finish = (parts: Array<{ key: string; name: string; items: unknown[] }>) => {
    onLibrary(libraryFile(parts));
    onOpenChange(false);
  };

  const included = (profile: StremioProfileInfo) => Boolean(ticked[profile.id]) && (!profile.hasPin || Boolean(pins[profile.id]?.trim()));

  const start = async (event: FormEvent) => {
    event.preventDefault();
    const mine = sessions.current();
    setBusy(true);
    setError(null);
    try {
      let key: string;
      if (useKey) key = pasted.trim();
      else {
        key = await signIn(email.trim(), password);
        if (!sessions.keep(key, mine)) return;
      }
      accountKey.current = key;
      const account = await readAccount(key);
      if (sessions.current() !== mine) return;
      if (account.profiles.length === 1) {
        const [only] = account.profiles;
        const items = await readLibrary(key);
        if (sessions.current() !== mine) return;
        if (!items.length) {
          setError("This Stremio library is empty.");
          return;
        }
        finish([{ key: only.main ? "" : only.id, name: only.name, items }]);
        return;
      }
      setProfiles(account.profiles);
      setTicked(Object.fromEntries(account.profiles.map((profile) => [profile.id, true])));
    } catch (failure) {
      if (sessions.current() === mine) setError(stremioMessage(failure));
    } finally {
      if (sessions.current() === mine) setBusy(false);
    }
  };

  const readOne = async (profile: StremioProfileInfo, mine: number) => {
    setReads((held) => ({ ...held, [profile.id]: { status: "reading" } }));
    try {
      let key = profile.main ? accountKey.current! : profileKeys.current[profile.id];
      if (!key) {
        key = await openProfile(accountKey.current!, profile.id, profile.hasPin ? pins[profile.id].trim() : "");
        if (!sessions.keep(key, mine)) return;
        profileKeys.current[profile.id] = key;
      }
      const items = await readLibrary(key);
      if (sessions.current() === mine) setReads((held) => ({ ...held, [profile.id]: { status: "done", items } }));
    } catch (failure) {
      if (sessions.current() === mine) setReads((held) => ({ ...held, [profile.id]: { status: "failed", error: stremioMessage(failure) } }));
    }
  };

  const readAll = async () => {
    const mine = sessions.current();
    setBusy(true);
    await Promise.all((profiles ?? []).filter((profile) => included(profile) && reads[profile.id]?.status !== "done").map((profile) => readOne(profile, mine)));
    if (sessions.current() === mine) setBusy(false);
  };

  const chosen = (profiles ?? []).filter(included);
  const ready = chosen.length > 0 && chosen.every((profile) => reads[profile.id]?.status === "done");
  const carry = () => finish(chosen.map((profile) => ({ key: profile.main ? "" : profile.id, name: profile.name, items: reads[profile.id].items ?? [] })));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import from Stremio</DialogTitle>
          <DialogDescription>
            {profiles ? "Pick the profiles to import. A locked profile is read once its PIN is in." : "Your sign-in goes straight to Stremio and is never sent to this server."}
          </DialogDescription>
        </DialogHeader>

        {!profiles ? (
          <form onSubmit={(event) => void start(event)} className="space-y-3">
            {useKey ? (
              <div className="space-y-1.5">
                <Input value={pasted} onChange={(event) => setPasted(event.target.value)} placeholder="Auth key" autoComplete="off" spellCheck={false} disabled={busy} />
                <p className="text-xs text-muted-foreground">Find it on web.stremio.com: it signs in this browser, and the key is in its stored profile.</p>
              </div>
            ) : (
              <>
                <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" autoComplete="email" disabled={busy} />
                <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" autoComplete="current-password" disabled={busy} />
              </>
            )}
            <button type="button" onClick={() => { setUseKey(!useKey); setError(null); }} disabled={busy} className="text-xs text-blue-400 hover:underline disabled:opacity-50">
              {useKey ? "Use email and password instead" : "Use an auth key instead"}
            </button>
            {error && <p className="text-xs text-amber-200">{error}</p>}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button type="button" onClick={() => onOpenChange(false)} className={secondary}>Cancel</button>
              <button type="submit" disabled={busy || (useKey ? !pasted.trim() : !email.trim() || !password)} className={primary}>
                {busy && <Loader2 className="size-3.5 animate-spin" />} Sign in
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="divide-y divide-white/[0.06] overflow-hidden rounded-xl ring-1 ring-inset ring-white/10">
              {profiles.map((profile) => {
                const read = reads[profile.id];
                return (
                  <label key={profile.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={Boolean(ticked[profile.id])}
                      disabled={busy}
                      onChange={(event) => setTicked((held) => ({ ...held, [profile.id]: event.target.checked }))}
                      className="size-4 shrink-0 accent-blue-500"
                    />
                    <span className="min-w-0 flex-1 truncate">{profile.name}</span>
                    {profile.hasPin && read?.status !== "done" && (
                      <span className="flex items-center gap-1.5">
                        <Lock className="size-3.5 text-muted-foreground" />
                        <Input
                          type="password"
                          inputMode="numeric"
                          value={pins[profile.id] ?? ""}
                          onChange={(event) => {
                            const pin = event.target.value;
                            setPins((held) => ({ ...held, [profile.id]: pin }));
                            if (read?.status === "failed") setReads((held) => { const next = { ...held }; delete next[profile.id]; return next; });
                          }}
                          placeholder="PIN"
                          autoComplete="off"
                          disabled={busy}
                          className="h-8 w-20"
                        />
                      </span>
                    )}
                    <span className="w-full text-right text-xs sm:w-auto">
                      {read?.status === "reading" && <Loader2 className="ml-auto size-3.5 animate-spin text-muted-foreground" />}
                      {read?.status === "done" && <span className="flex items-center justify-end gap-1 text-muted-foreground"><Check className="size-3.5 text-blue-400" />{(read.items?.length ?? 0).toLocaleString()} items</span>}
                      {read?.status === "failed" && <span className="text-amber-200">{read.error}</span>}
                    </span>
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
                  {busy && <Loader2 className="size-3.5 animate-spin" />} Read libraries
                </button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
