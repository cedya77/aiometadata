// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronDown, ChevronRight, LogOut, Trash2, Loader2, Ban, ShieldCheck } from "lucide-react";
import { useAdmin } from "@/contexts/AdminContext";
import {
  useDashboardAccounts,
  useAccountConfigs,
  useRevokeAccountSessions,
  useDeleteAccount,
  useSetAccountBlocked,
  useSigninFailures,
  useClearSigninFailures,
  type AccountRow,
  type SigninFailure,
  type SigninFailureReason,
  type DashboardTab,
} from "@/hooks/useDashboardQueries";

function formatDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString();
}

const FAILURE_LABELS: Record<SigninFailureReason, string> = {
  refused: "Refused",
  blocked: "Blocked",
  "rate-limited": "Rate limited",
  "browser-mismatch": "Wrong browser",
  expired: "Expired",
  "provider-error": "Provider error",
};

function LinkedConfigs({ accountId }: { accountId: string }) {
  const { data, isLoading, isError } = useAccountConfigs(accountId);

  if (isLoading) return <p className="text-xs text-muted-foreground px-4 py-3">Loading configurations…</p>;
  if (isError) return <p className="text-xs text-red-500 px-4 py-3">Could not load configurations.</p>;

  const configs = data?.configs ?? [];
  if (configs.length === 0) {
    return <p className="text-xs text-muted-foreground px-4 py-3">No configurations saved to this account.</p>;
  }

  return (
    <div className="px-4 py-3 space-y-2">
      {configs.map((config) => (
        <div key={config.userUUID} className="flex items-center justify-between gap-3 text-xs">
          <span className="font-medium truncate">{config.label}</span>
          <span className="font-mono text-muted-foreground">{config.userUUID.slice(0, 8)}</span>
          <span className="text-muted-foreground whitespace-nowrap">linked {formatDate(config.linkedAt)}</span>
          <span className="text-muted-foreground whitespace-nowrap">opened {formatDate(config.lastOpenedAt)}</span>
        </div>
      ))}
    </div>
  );
}

function PermissionBadges({ account, mappingReadable }: { account: AccountRow; mappingReadable: boolean }) {
  if (!account.permissionsKnown) {
    return (
      <Badge variant="outline" className="text-muted-foreground font-normal">
        unknown until next sign-in
      </Badge>
    );
  }
  if (!mappingReadable) {
    return (
      <Badge variant="outline" className="text-muted-foreground font-normal">
        mapping unreadable
      </Badge>
    );
  }
  if (account.permissions === null) {
    return <Badge variant="destructive">would be refused</Badge>;
  }
  if (account.permissions.length === 0) {
    return <Badge variant="outline">no permissions</Badge>;
  }
  return (
    <>
      {account.permissions.map((permission) => (
        <Badge key={permission} variant={permission === "admin" ? "default" : "secondary"}>
          {permission}
        </Badge>
      ))}
    </>
  );
}

function GroupsPresented({ claim, groups }: { claim: string | null | undefined; groups: string[] }) {
  return (
    <p className="text-xs text-muted-foreground">
      <span className="font-mono">{claim || "groups"}</span> carried{" "}
      {groups.length > 0 ? (
        <span className="font-mono">{groups.join(", ")}</span>
      ) : (
        <span className="italic">nothing</span>
      )}
    </p>
  );
}

function SigninFailures({ activeTab }: { activeTab: DashboardTab }) {
  const { data, isLoading } = useSigninFailures({ activeTab });
  const clear = useClearSigninFailures();
  const failures: SigninFailure[] = data?.failures ?? [];

  if (isLoading) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-base">Recent sign-in failures</CardTitle>
          <CardDescription>
            What the provider actually sent, for the sign-ins that were turned away.
          </CardDescription>
        </div>
        {failures.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() =>
              clear.mutate(undefined, {
                onSuccess: () => toast.success("Cleared"),
                onError: (error: Error) => toast.error("Could not clear", { description: error.message }),
              })
            }
            disabled={clear.isPending}
          >
            {clear.isPending ? <Loader2 className="animate-spin" /> : null}
            Clear
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {failures.length === 0 && (
          <p className="text-sm text-muted-foreground">No refused sign-ins recorded.</p>
        )}
        {failures.map((failure) => (
          <div key={failure.id} className="border rounded-md px-3 py-2 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={failure.reason === "provider-error" ? "destructive" : "secondary"}>
                {FAILURE_LABELS[failure.reason] ?? failure.reason}
              </Badge>
              <span className="text-sm font-medium truncate">
                {failure.username || failure.subject || failure.address || "unknown"}
              </span>
              <span className="text-xs text-muted-foreground ml-auto whitespace-nowrap">
                {formatDate(failure.at)}
              </span>
            </div>
            {failure.detail && <p className="text-xs text-muted-foreground">{failure.detail}</p>}
            {failure.groups && <GroupsPresented claim={failure.groupsClaim} groups={failure.groups} />}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default function DashboardAccounts({ activeTab }: { activeTab: DashboardTab }) {
  const { session } = useAdmin();
  const { data, isLoading, isError, refetch, isFetching } = useDashboardAccounts({ activeTab });
  const revoke = useRevokeAccountSessions();
  const remove = useDeleteAccount();
  const setBlocked = useSetAccountBlocked();
  const [expanded, setExpanded] = useState<string | null>(null);

  const accounts: AccountRow[] = data?.accounts ?? [];
  const mappingReadable = data?.mappingReadable !== false;
  const busy = revoke.isPending || remove.isPending || setBlocked.isPending;

  const confirmDelete = (account: AccountRow) => {
    const isSelf = session?.accountId === account.accountId;
    const warning = isSelf
      ? `Delete your own account (${account.username})? This signs you out immediately.`
      : `Delete the account ${account.username}?`;
    if (!window.confirm(`${warning}\n\nTheir saved configurations are unlinked but not deleted, and stay reachable by UUID and password. Deleting does not stop them signing in again — block them for that.`)) return;

    remove.mutate({ accountId: account.accountId, confirm: isSelf }, {
      onSuccess: (result: { warning?: string }) => {
        if (expanded === account.accountId) setExpanded(null);
        if (result?.warning) toast.warning(`Deleted ${account.username}`, { description: result.warning });
        else toast.success(`Deleted ${account.username}`);
      },
      onError: (error: Error) => toast.error("Could not delete this account", { description: error.message }),
    });
  };

  const confirmRevoke = (account: AccountRow) => {
    const isSelf = session?.accountId === account.accountId;
    const warning = isSelf
      ? "Revoke your own sessions? This signs you out immediately."
      : `Sign ${account.username} out of every device? They can sign straight back in unless you block them.`;
    if (!window.confirm(warning)) return;

    revoke.mutate(account.accountId, {
      onSuccess: (result: { revoked?: number }) =>
        toast.success(`Signed ${account.username} out of ${result?.revoked ?? 0} session(s)`),
      onError: (error: Error) => toast.error("Could not revoke these sessions", { description: error.message }),
    });
  };

  const toggleBlocked = (account: AccountRow) => {
    const next = !account.blocked;
    if (next && !window.confirm(`Block ${account.username}? This signs them out and refuses their next sign-in until you unblock them.`)) return;

    setBlocked.mutate({ accountId: account.accountId, blocked: next }, {
      onSuccess: (result: { warning?: string }) => {
        const title = next ? `Blocked ${account.username}` : `Unblocked ${account.username}`;
        if (result?.warning) toast.warning(title, { description: result.warning });
        else toast.success(title);
      },
      onError: (error: Error) =>
        toast.error(next ? "Could not block this account" : "Could not unblock this account", { description: error.message }),
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading accounts…
      </div>
    );
  }

  if (isError && !data) {
    return (
      <Card>
        <CardContent className="py-6 space-y-3">
          <p className="text-sm text-destructive">Couldn't load accounts — the server did not answer.</p>
          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : null}
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Accounts</CardTitle>
          <CardDescription>
            Permissions resolve from the group mapping on every request, so these are what each account holds right now.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {isError && (
            <p className="text-xs text-destructive pb-2">
              Couldn't refresh — showing the last known state.
            </p>
          )}
          {!mappingReadable && (
            <p className="text-xs text-destructive pb-2">
              The group mapping can't be read, so no sign-in is allowed and nobody's permissions can be resolved. Fix it in Settings — everyone already signed in keeps what they hold until then.
            </p>
          )}
          {accounts.length === 0 && (
            <p className="text-sm text-muted-foreground">Nobody has signed in with the identity provider yet.</p>
          )}
          {accounts.map((account) => {
            const isSelf = session?.accountId === account.accountId;
            const isOpen = expanded === account.accountId;
            return (
              <div
                key={account.accountId}
                className={`border rounded-md ${account.blocked ? "border-destructive/40 bg-destructive/[0.03]" : ""}`}
              >
                <div className="flex items-center gap-3 px-3 py-2 flex-wrap">
                  <button
                    className="text-muted-foreground"
                    onClick={() => setExpanded(isOpen ? null : account.accountId)}
                    aria-label={isOpen ? "Collapse" : "Expand"}
                  >
                    {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">{account.username}</span>
                      {isSelf && <Badge variant="outline">you</Badge>}
                      {account.blocked && <Badge variant="destructive">blocked</Badge>}
                      <PermissionBadges account={account} mappingReadable={mappingReadable} />
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{account.email || account.subject}</p>
                  </div>
                  <div className="hidden md:block text-xs text-muted-foreground truncate max-w-[180px]">{account.issuer}</div>
                  <Badge variant={account.activeSessions > 0 ? "default" : "outline"}>
                    {account.activeSessions} active
                  </Badge>
                  <div className="hidden lg:block text-xs text-muted-foreground whitespace-nowrap">
                    seen {formatDate(account.lastSeenAt)}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    onClick={() => confirmRevoke(account)}
                    disabled={busy}
                  >
                    {revoke.isPending && revoke.variables === account.accountId
                      ? <Loader2 className="animate-spin" />
                      : <LogOut />}
                    Revoke
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    onClick={() => toggleBlocked(account)}
                    disabled={busy || (isSelf && !account.blocked)}
                    title={isSelf && !account.blocked ? "You cannot block your own account" : undefined}
                  >
                    {setBlocked.isPending && setBlocked.variables?.accountId === account.accountId
                      ? <Loader2 className="animate-spin" />
                      : account.blocked ? <ShieldCheck /> : <Ban />}
                    {account.blocked ? "Unblock" : "Block"}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="shrink-0"
                    onClick={() => confirmDelete(account)}
                    disabled={busy}
                  >
                    {remove.isPending && remove.variables?.accountId === account.accountId
                      ? <Loader2 className="animate-spin" />
                      : <Trash2 />}
                    Delete
                  </Button>
                </div>
                {isOpen && (
                  <div className="border-t">
                    {account.groups && (
                      <div className="px-4 pt-3">
                        <GroupsPresented claim={data?.groupsClaim} groups={account.groups} />
                      </div>
                    )}
                    <LinkedConfigs accountId={account.accountId} />
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <SigninFailures activeTab={activeTab} />
    </div>
  );
}
