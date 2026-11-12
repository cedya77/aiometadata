import { useRef, useState } from 'react';
import { Check, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Face } from '@/components/users/Face';
import { useConfig } from '@/contexts/ConfigContext';
import { useSave } from '@/contexts/SaveContext';
import { MAX_TAG_NAME_LENGTH } from '@/contexts/config';
import { householdPeople, newPersonId, personNameTaken } from '@/lib/cardAccounts';
import { moveRadio, radioTabIndex } from '@/lib/radioKeys';
import { cn } from '@/lib/utils';
import { emptyCode } from '@/lib/jellyfinClient';
import { CodeInput, type CodeInputHandle } from './CodeInput';

interface Approved {
  app: string;
  device?: string;
  name: string;
}

export function QuickConnectCard({ userUUID }: { userUUID: string }) {
  const { config, setConfig, auth } = useConfig();
  const { persistedConfig, requestSave, isSaving, canSave } = useSave();
  const people = householdPeople(config, userUUID);
  const several = people.length > 1;
  const [profile, setProfile] = useState('');
  const chosen = people.find((person) => person.key === profile) ?? (several ? null : people[0]);
  const unsaved = Boolean(chosen && !chosen.main && !(persistedConfig?.jellyfinUsers ?? []).some((user) => user.id === chosen.key));

  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const addPerson = () => {
    const name = newName.trim();
    if (!name) { setAdding(false); return; }
    if (personNameTaken(config, userUUID, name)) {
      toast.error('There is already a person with that name');
      return;
    }
    const id = newPersonId();
    setConfig((prev) => ({ ...prev, jellyfinUsers: [...(prev.jellyfinUsers ?? []), { id, name, tags: [] }] }));
    setProfile(id);
    setNewName('');
    setAdding(false);
  };

  const [code, setCode] = useState(emptyCode);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState<Approved | null>(null);
  const boxes = useRef<CodeInputHandle>(null);
  const card = useRef<HTMLDivElement>(null);

  const approve = async (digits = code.join('')) => {
    if (approving) return;
    if (!chosen) {
      setError('Pick who this app is for first.');
      return;
    }
    if (unsaved) {
      setError(`Save first, so the server knows ${chosen.name}.`);
      return;
    }
    if (digits.length !== 6) {
      setError('Enter the six digit code the app is showing.');
      boxes.current?.focus(code.findIndex((digit) => !digit));
      return;
    }
    const focused = Boolean(card.current?.contains(document.activeElement));
    setApproving(true);
    setError(null);
    try {
      const response = await fetch(`/api/jellyfin/${encodeURIComponent(userUUID)}/quick-connect/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: digits, password: auth.password || undefined, profile: chosen.main ? undefined : chosen.key }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || 'Could not approve the device');
      const name = result?.profile || chosen.name;
      setCode(emptyCode());
      if (several) setProfile('');
      if (focused) boxes.current?.focus(0);
      setApproved({ app: result?.app || 'App', device: result?.device || undefined, name });
      toast.success(`${result?.app || 'App'} signed in`, {
        description: result?.device ? `Approved ${result.device} as ${name}.` : undefined,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not approve the device');
      boxes.current?.focus(0);
    } finally {
      setApproving(false);
    }
  };

  return (
    <div ref={card} id="quick-connect" className="flex flex-col gap-3.5 rounded-lg border bg-card p-4">
      <div className="space-y-0.5">
        <p className="font-medium">Quick Connect</p>
        <p className="text-sm text-muted-foreground">Pick Quick Connect on the app's sign-in screen, then enter the code it shows.</p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-sm font-medium">Who's it for?</span>
        <div role="radiogroup" aria-label="Who the app signs in as" className="contents" onKeyDown={moveRadio}>
          {people.map((person, index) => (
            <button
              key={person.key}
              type="button"
              role="radio"
              aria-checked={person.key === chosen?.key}
              tabIndex={radioTabIndex(person.key === chosen?.key, index, Boolean(chosen))}
              onClick={() => setProfile(person.key)}
              className={cn(
                'flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs font-medium transition-colors',
                person.key === chosen?.key ? 'border-foreground/60 bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Face name={person.name} avatar={person.avatar} className="h-6 w-6 border-0 text-[10px]" />
              <span className="max-w-[8rem] truncate">{person.name}</span>
            </button>
          ))}
        </div>
        {adding ? (
          <span className="flex items-center gap-1">
            <Input
              autoFocus
              value={newName}
              maxLength={MAX_TAG_NAME_LENGTH}
              placeholder="Name"
              aria-label="New person's name"
              className="h-7 w-32 text-xs"
              onChange={(e) => setNewName(e.target.value)}
              onBlur={() => { if (!newName.trim()) setAdding(false); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addPerson();
                if (e.key === 'Escape') { setAdding(false); setNewName(''); }
              }}
            />
            <Button size="sm" className="h-7 px-2.5 text-xs" disabled={!newName.trim()} onMouseDown={(e) => e.preventDefault()} onClick={addPerson}>Add</Button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 rounded-full border border-dashed py-1 pl-2 pr-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add person
          </button>
        )}
      </div>

      {chosen && unsaved ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 px-3 py-2">
          <p className="text-xs text-amber-400">Save to sign apps in as {chosen.name}.</p>
          <Button size="sm" className="h-7 text-xs" disabled={!canSave || isSaving} onClick={requestSave}>
            {isSaving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </Button>
        </div>
      ) : null}

      <div className="space-y-2">
        {several && userUUID ? (
          <p className={cn('text-xs', chosen ? 'text-muted-foreground' : 'text-amber-400')}>
            {chosen ? `The code signs the app in as ${chosen.name}.` : 'Pick who this app is for, then enter its code.'}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <CodeInput
            ref={boxes}
            id="quick-connect-code"
            value={code}
            onChange={(next) => { setCode(next); setError(null); }}
            onComplete={(digits) => void approve(digits)}
            busy={approving}
            invalid={Boolean(error)}
          />
          <Button variant="outline" className="h-10 sm:h-11" disabled={approving} onClick={() => void approve()}>
            {approving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            {several && chosen ? <span className="max-w-[10rem] truncate">Approve as {chosen.name}</span> : 'Approve'}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">{error}</p>
        ) : approved ? (
          <p className="flex items-center gap-1.5 text-xs text-emerald-400">
            <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{approved.device ? `${approved.app} · ${approved.device}` : approved.app} signed in as {approved.name}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
