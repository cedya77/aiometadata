import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronRight, Loader2, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import {
  usePosterCacheStats,
  usePurgePosterCache,
  useUpdateSetting,
} from "@/hooks/useDashboardQueries";
import {
  applyChange,
  buildPolicyRules,
  describeDays,
  inheritedPolicy,
  isValidDomain,
  normalizeDomain,
  pendingChanges,
  rowProblem,
  rowsFromRules,
  type FlatSetting,
  type PolicyContext,
  type PolicyFormState,
  type PolicyMode,
  type PolicyRow,
  type ProviderPolicyRule,
  type TtlPolicy,
} from "@/lib/providerPolicyRules";
import { IMAGE_TYPE_LABELS } from "@/lib/imageClassLabels";

const POLICY_LABELS: Record<TtlPolicy, string> = {
  default: "Default",
  infer: "Follow source",
  custom: "Custom",
  bypass: "Never store",
};

// Nothing is stored in proxy mode, so "never store" would name the wrong thing.
const PROXY_POLICY_LABELS: Record<TtlPolicy, string> = { ...POLICY_LABELS, bypass: "Never cache" };

/** What each policy does, stated rather than measured off the cache. */
function explain(mode: PolicyMode, policy: TtlPolicy, ttl: string, flat: string | null): string {
  if (mode === "proxy") {
    switch (policy) {
      case "default":
        return flat
          ? `Served with a max-age of ${flat} — the lifetime set above.`
          : "Served with the lifetime set above.";
      case "infer":
        return "Passes the provider's own Cache-Control through, capped at the lifetime above.";
      case "custom":
        return ttl.trim()
          ? `Every image from this provider is served with a max-age of ${ttl.trim()}, whatever its own headers say.`
          : "Enter a duration — 30s, 15m, 12h, 30d, 2w or 1y.";
      case "bypass":
        return "Served with no-store — no CDN or player keeps a copy, and conditional requests are not revalidated.";
    }
  }

  switch (policy) {
    case "default":
      return flat
        ? `Kept ${flat} — the validity set above.`
        : "Kept for the validity set above.";
    case "infer":
      return "Follows the Cache-Control this source sends with each image. Where it promises nothing "
        + "usable the flat validity still applies, and a source asking not to be cached at all is served "
        + "without being stored.";
    case "custom":
      return ttl.trim()
        ? `Every image from this provider is kept ${ttl.trim()}, whatever its own headers say.`
        : "Enter a duration — 30s, 15m, 12h, 30d, 2w or 1y.";
    case "bypass":
      return "Served straight through and never stored. Anything already cached for this provider stays "
        + "on disk until it is purged.";
  }
}

/** "Logos and Backgrounds", from the class names the backend reports. */
function listClasses(classes: string[]): string {
  const labels = classes.map((imageClass) => IMAGE_TYPE_LABELS[imageClass] || imageClass);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

export function ImageCachePolicyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // The query the Image Cache card already runs, so opening this costs nothing.
  const statsQuery = usePosterCacheStats({ activeTab: "operations" });
  const updateSetting = useUpdateSetting();
  const purgeMutation = usePurgePosterCache();

  const [rows, setRows] = useState<PolicyRow[]>([]);
  const [infer, setInfer] = useState(false);
  const [flatDays, setFlatDays] = useState("");
  const [baseline, setBaseline] = useState<PolicyFormState | null>(null);
  const [newDomain, setNewDomain] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [purgingDomain, setPurgingDomain] = useState<string | null>(null);
  const [confirmingDomain, setConfirmingDomain] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const data = statsQuery.data as {
    known_providers?: Array<{
      domain: string;
      group: "source" | "rating";
      preset?: { policy: TtlPolicy; ttl?: string };
    }>;
    provider_policies?: ProviderPolicyRule[];
    infer_ttl?: boolean;
    ttl_days?: number;
    domain_purge?: { domain: string; running: boolean; removed: number } | null;
    builtin?: boolean;
    presets_enabled?: boolean;
    follow_upstream?: boolean;
    proxy_max_age_days?: number;
    passthrough_classes?: string[];
  } | null | undefined;

  // Absent means the built-in store answered; only the cache-off branch sets it.
  const mode: PolicyMode = data?.builtin === false ? "proxy" : "store";
  const proxy = mode === "proxy";
  const followUpstream = !!data?.follow_upstream;
  const presetsEnabled = data?.presets_enabled !== false;
  const labels = proxy ? PROXY_POLICY_LABELS : POLICY_LABELS;
  const flatSetting: FlatSetting = proxy
    ? { key: "POSTER_PROXY_MAX_AGE_DAYS", label: "the default lifetime" }
    : { key: "POSTER_CACHE_TTL_DAYS", label: "the default validity" };
  const ctx: PolicyContext = { mode, inferEnabled: infer, followUpstream, presetsEnabled };

  const saved = useMemo(() => data?.provider_policies ?? [], [data]);
  const providers = useMemo(() => data?.known_providers ?? [], [data]);
  // Grouping comes from the backend alongside the list, so the two cannot drift.
  const groupOf = useMemo(
    () => new Map(providers.map((p) => [p.domain, p.group])),
    [providers]
  );

  // Seeded once per opening, so the card's polling cannot wipe an edit in progress.
  const seeded = useRef(false);
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (seeded.current || !data) return;
    seeded.current = true;
    const inferEnabled = !!data.infer_ttl;
    // Proxy mode edits POSTER_PROXY_MAX_AGE_DAYS, whose default is 1 — seeding it
    // from the store's 30 would display, and on the next Save write, thirty times
    // the real lifetime.
    const days = proxy ? String(data.proxy_max_age_days ?? 1) : String(data.ttl_days ?? 30);

    setInfer(inferEnabled);
    setFlatDays(days);
    setRows(rowsFromRules(saved, providers, {
      mode,
      inferEnabled,
      followUpstream: !!data.follow_upstream,
      presetsEnabled: data.presets_enabled !== false,
    }));
    // What Save diffs against, so only what you actually moved is written.
    setBaseline({ flatDays: days, infer: inferEnabled, rules: saved });
    setShowHelp(false);
    setNewDomain("");
  }, [open, data, saved, providers, mode, proxy]);

  const updateRow = (domain: string, patch: Partial<PolicyRow>) => {
    setRows((current) => current.map((row) => (row.domain === domain ? { ...row, ...patch } : row)));
  };

  /** Back to whatever the row would show untouched — its preset, or the toggle. */
  const resetRow = (domain: string) =>
    setRows((current) => current.map((row) => (row.domain === domain
      ? { ...row, explicit: false, policy: inheritedPolicy(ctx, row.preset), ttl: "" }
      : row)));

  const removeRow = (domain: string) =>
    setRows((current) => current.filter((row) => row.domain !== domain));

  const addDomain = () => {
    const domain = normalizeDomain(newDomain);
    if (!domain) return;
    if (!isValidDomain(domain)) {
      toast.error("Not a domain", { description: `"${newDomain.trim()}" does not look like a hostname.` });
      return;
    }
    if (rows.some((row) => row.domain === domain)) {
      toast.info("Already listed", { description: `${domain} is already in the list below.` });
      setNewDomain("");
      return;
    }
    setRows((current) => [...current, {
      domain, builtIn: false, explicit: true, policy: "infer", ttl: "",
    }]);
    setNewDomain("");
  };

  const flatEcho = describeDays(flatDays);
  const current: PolicyFormState = { flatDays, infer, rules: buildPolicyRules(rows) };
  const changes = baseline ? pendingChanges(current, baseline, flatSetting) : [];
  const blocked = rows.some((row) => rowProblem(row) !== null) || flatEcho === null;

  const handleSave = async () => {
    setSaving(true);
    const applied: string[] = [];
    // Advanced as each write lands, so a retry after a partial failure asks only
    // for what is still outstanding and Save disables itself once nothing is.
    let landed = baseline!;

    for (const change of changes) {
      try {
        await updateSetting.mutateAsync({ key: change.key, value: change.value });
        applied.push(change.label);
        landed = applyChange(landed, change, flatSetting.key);
        setBaseline(landed);
      } catch (error: any) {
        // Stop at the first failure and say exactly how far we got — reporting
        // "Saved" having stored part of the intent would be a lie.
        setSaving(false);
        toast.error(applied.length === 0 ? "Nothing was saved" : "Partly saved", {
          description: applied.length === 0
            ? `${change.label} could not be stored: ${error?.message || "unknown error"}.`
            : `Saved ${applied.join(" and ")}, but ${change.label} did not apply: ${error?.message || "unknown error"}.`,
        });
        return;
      }
    }

    setSaving(false);
    const count = current.rules.length;
    toast.success(proxy ? "Proxy policies saved" : "Image cache policies saved", {
      description: count === 0
        ? `No per-provider rules. Every provider uses ${proxy ? "the default lifetime" : "the default validity"} above.`
        : `${count} provider rule${count === 1 ? "" : "s"} in effect, applied ${proxy ? "on the next request" : "to images already cached on their next request"}.`,
    });
    statsQuery.refetch();
    onOpenChange(false);
  };

  /**
   * Only the row actually being purged spins. The backend's own status keeps it
   * spinning across a reload or a second admin's session, since the walk outlives
   * the request that started it.
   */
  const purgingRow = (domain: string) =>
    purgingDomain === domain
    || (!!data?.domain_purge?.running && data.domain_purge.domain === domain);

  const runPurge = (domain: string) => {
    setConfirmingDomain(null);
    setPurgingDomain(domain);
    // The purge runs in the background — the response says it started, not what it
    // removed. The count arrives with the card's next stats poll.
    purgeMutation.mutate({ domain }, {
      onSuccess: () => toast.success("Purge started", {
        description: `Removing everything cached for ${domain}. On a large cache this takes a while; the Image Cache card shows the count when it finishes.`,
      }),
      onError: (error) => toast.error("Purge failed", { description: error.message }),
      onSettled: () => setPurgingDomain(null),
    });
  };

  const groups: Array<{ title: string; rows: PolicyRow[] }> = [
    { title: "Image sources", rows: rows.filter((r) => groupOf.get(r.domain) === "source") },
    { title: "Rating & overlay services", rows: rows.filter((r) => groupOf.get(r.domain) === "rating") },
    { title: "Your domains", rows: rows.filter((r) => !groupOf.has(r.domain)) },
  ];

  const renderRow = (row: PolicyRow) => {
    const problem = rowProblem(row);
    return (
      <div
        key={row.domain}
        className={`rounded-md px-2 py-1.5 ${row.explicit ? "border-l-2 border-primary/60 bg-muted/30" : "border-l-2 border-transparent"}`}
      >
        <div className="flex items-center gap-3">
          <span className="flex-1 min-w-0 truncate font-mono text-sm" title={row.domain}>
            {row.domain}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <Select
              value={row.policy}
              onValueChange={(policy) => updateRow(row.domain, { explicit: true, policy: policy as TtlPolicy })}
            >
              <SelectTrigger className="w-[150px] h-9"><SelectValue /></SelectTrigger>
              <SelectContent sheet>
                {(Object.keys(labels) as TtlPolicy[]).map((policy) => (
                  <SelectItem key={policy} value={policy}>{labels[policy]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {row.policy === "custom" && (
              <Input
                className={`w-[92px] h-9 ${problem ? "border-red-500/60" : ""}`}
                placeholder="12h"
                value={row.ttl}
                aria-label={`${proxy ? "Client lifetime" : "Cache duration"} for ${row.domain}`}
                onChange={(e) => updateRow(row.domain, { explicit: true, ttl: e.target.value })}
              />
            )}
            {row.builtIn ? (
              <Button
                variant="ghost" size="sm" className="h-9 w-9 p-0"
                aria-label={`Reset ${row.domain} to its recommended policy`}
                disabled={!row.explicit}
                onClick={() => resetRow(row.domain)}
              >
                <RotateCcw className={`h-3.5 w-3.5 ${row.explicit ? "" : "opacity-0"}`} />
              </Button>
            ) : (
              <Button
                variant="ghost" size="sm" className="h-9 w-9 p-0"
                aria-label={`Remove the rule for ${row.domain}`}
                onClick={() => removeRow(row.domain)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        {/* Only rows you actually changed explain themselves — a paragraph under
            every provider is worse than none, and what the policies mean is what
            the help toggle above is for. */}
        {row.explicit && (
          <div className="pl-1 pr-10 pt-1 space-y-1">
            <p className={`text-xs ${problem ? "text-red-500" : "text-muted-foreground"}`}>
              {problem || explain(mode, row.policy, row.ttl, flatEcho)}
            </p>
            {!proxy && row.policy === "bypass" && (
              <Button
                variant="ghost" size="sm"
                className="h-7 px-2 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                disabled={purgingRow(row.domain)}
                onClick={() => setConfirmingDomain(row.domain)}
              >
                {purgingRow(row.domain) ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <><Trash2 className="h-3.5 w-3.5 mr-1.5" />Purge them now</>
                )}
              </Button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* No inner scroll container: DialogContent already scrolls, and nesting one
          clips the focus ring on every row — `overflow-y: auto` forces the other
          axis to clip too. */}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{proxy ? "Per-provider proxy policies" : "Per-provider cache policies"}</DialogTitle>
          <DialogDescription>
            {proxy
              ? "Overrides what Cache-Control one provider's images are served with, leaving the rest alone. A domain covers its subdomains. Applies to art that passes through this addon, on the next request."
              : "Overrides how one provider's images are cached, leaving the rest alone. A domain covers its subdomains. Changes apply to images already cached, on their next request."}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border p-3 space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {proxy ? "Default lifetime" : "Default validity"}
          </p>

          <div className="flex items-center gap-3">
            <Label htmlFor="ttl-flat" className="flex-1 min-w-0 text-sm font-normal">
              {proxy ? "Client lifetime" : "Cache validity"}
            </Label>
            <Input
              id="ttl-flat"
              inputMode="decimal"
              className={`w-[84px] h-9 shrink-0 ${flatEcho === null ? "border-red-500/60" : ""}`}
              value={flatDays}
              onChange={(e) => setFlatDays(e.target.value)}
            />
            <span className={`w-[104px] shrink-0 text-xs ${flatEcho === null ? "text-red-500" : "text-muted-foreground"}`}>
              {flatEcho ?? "not a number"}
            </span>
          </div>

          {/* Not editable here. It is a server-wide setting, it is reachable from
              the settings section, and every provider listed below already has a
              policy of its own — so the only thing worth saying is that it is on.
              In proxy mode it says more than that: with FOLLOW_UPSTREAM on, no
              unruled row's displayed policy is in force, presets included. */}
          {proxy ? (followUpstream && (
            <p className="pt-3 border-t text-xs text-muted-foreground">
              <code className="font-mono">POSTER_PROXY_FOLLOW_UPSTREAM</code> is enabled — anything
              without a rule below is relayed with the provider's own{" "}
              <code className="font-mono">Cache-Control</code>, uncapped. Built-in policies do not
              apply while it is on.
            </p>
          )) : (infer && (
            <p className="pt-3 border-t text-xs text-muted-foreground">
              <code className="font-mono">POSTER_CACHE_INFER_TTL</code> is enabled — anything
              without a rule or a built-in policy defaults to Follow source.
            </p>
          ))}

          {/* The one combination where the two chains visibly disagree: a class
              this install does not store has its headers decided by the proxy
              chain, where FOLLOW_UPSTREAM outranks the presets. */}
          {!proxy && followUpstream && !!data?.passthrough_classes?.length && (
            <p className="pt-3 border-t text-xs text-muted-foreground">
              {listClasses(data.passthrough_classes)} are not stored on this install, so their
              headers follow <code className="font-mono">POSTER_PROXY_FOLLOW_UPSTREAM</code> rather
              than the policies below.
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowHelp((v) => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronRight className={`h-3.5 w-3.5 transition-transform ${showHelp ? "rotate-90" : ""}`} />
          What do these mean?
        </button>
        {showHelp && (
          <dl className="text-xs text-muted-foreground space-y-1.5 pl-5">
            {/* Answers the question a row cannot: why a provider already shows a
                policy when you never gave it one — but only where that is true.
                FOLLOW_UPSTREAM displaces the presets on the proxy path; it does
                not on the store path, where they outrank POSTER_CACHE_INFER_TTL. */}
            {presetsEnabled && !(proxy && followUpstream) && (
              <p className="pb-0.5">
                Each provider below already has a policy, measured from what it actually sends.
                Choose one yourself only where you want something different.
              </p>
            )}
            {(Object.keys(labels) as TtlPolicy[]).map((policy) => (
              <div key={policy}>
                <dt className="inline font-medium text-foreground">{labels[policy]}: </dt>
                <dd className="inline">{explain(mode, policy, "12h", flatEcho)}</dd>
              </div>
            ))}
          </dl>
        )}

        {groups.map((group) => group.rows.length > 0 && (
          <div key={group.title}>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
              {group.title}
            </p>
            <div className="space-y-0.5">{group.rows.map(renderRow)}</div>
          </div>
        ))}

        <div className="flex items-center gap-2">
          <Input
            placeholder="Add another domain…"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addDomain(); } }}
            className="h-9"
          />
          <Button variant="outline" size="sm" className="h-9 shrink-0" onClick={addDomain}>
            <Plus className="h-4 w-4 mr-1.5" />
            Add
          </Button>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="outline" size="sm" onClick={handleSave} disabled={saving || blocked || changes.length === 0}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save policies"}
          </Button>
        </DialogFooter>

        <AlertDialog
          open={confirmingDomain !== null}
          onOpenChange={(next) => { if (!next) setConfirmingDomain(null); }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove every cached image for {confirmingDomain}?</AlertDialogTitle>
              <AlertDialogDescription>
                They will not be re-cached while this provider is set to never store.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => runPurge(confirmingDomain!)}>Purge</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
