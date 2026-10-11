import { useCallback, useEffect, useMemo, useState } from "react";
import { useConfig } from "@/contexts/ConfigContext";
import { useSave } from "@/contexts/SaveContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Cloud, Download, ExternalLink, Loader2, RotateCcw, Save, Unlink, Upload } from "lucide-react";
import { toast } from "sonner";

interface BackupStatus {
  configured: boolean;
  connected: boolean;
  enabled: boolean;
  retentionLimit: number;
  lastBackupAt: number | null;
  nextBackupAt: number | null;
  lastBackupFailed: boolean;
}

interface DriveBackupFile {
  id: string;
  name: string;
  createdTime: string;
}

interface ApiAuth {
  userUUID: string | null;
  password: string | null;
}

interface PortableBackup {
  formatVersion: number;
  userUUID: string;
  config: Record<string, unknown>;
  jellyfinState?: Record<string, unknown> | null;
}

async function requestBackupApi<T extends object = Record<string, unknown>>(
  path: string,
  auth: ApiAuth,
  fields: Record<string, unknown> = {}
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userUUID: auth.userUUID, password: auth.password, ...fields }),
  });
  const text = await response.text();
  let result: unknown = {};
  if (text) {
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error("The server returned an invalid response");
    }
  }
  if (!response.ok) {
    const message = typeof result === "object" && result !== null && !Array.isArray(result)
      ? (result as { error?: unknown }).error
      : null;
    throw new Error(typeof message === "string" ? message : `Request failed (${response.status})`);
  }
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("The server returned an invalid response");
  }
  return result as T;
}

function formatBackupDate(value: string | number | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

export function GoogleDriveBackupSettings() {
  const { auth, setAuth, setConfig } = useConfig();
  const { isDirty, markConfigPersisted } = useSave();
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [backups, setBackups] = useState<DriveBackupFile[]>([]);
  const [retentionLimit, setRetentionLimit] = useState("10");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<DriveBackupFile | null>(null);
  const [portableBackup, setPortableBackup] = useState<PortableBackup | null>(null);
  const [portableRestoreOpen, setPortableRestoreOpen] = useState(false);
  const [recoveryUUID, setRecoveryUUID] = useState<string | null>(null);
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryPasswordConfirm, setRecoveryPasswordConfirm] = useState("");
  const [recoveryAddonPassword, setRecoveryAddonPassword] = useState("");
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  const userUUID = auth.authenticated ? auth.userUUID : null;
  const requestAuth = useMemo(
    () => ({ userUUID, password: auth.password }),
    [userUUID, auth.password]
  );

  const refresh = useCallback(async () => {
    if (!userUUID) {
      setStatus(null);
      setBackups([]);
      return;
    }
    setLoading(true);
    try {
      const backupStatus = await requestBackupApi<BackupStatus>("/api/google-drive-backup/status", requestAuth);
      setStatus(backupStatus);
      setRetentionLimit(String(backupStatus.retentionLimit || 10));
      if (backupStatus.connected) {
        const list = await requestBackupApi<{ backups: DriveBackupFile[] }>("/api/google-drive-backup/list", requestAuth);
        setBackups(Array.isArray(list.backups) ? list.backups : []);
      } else {
        setBackups([]);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load Google Drive backup settings");
    } finally {
      setLoading(false);
    }
  }, [requestAuth, userUUID]);

  useEffect(() => {
    setStatus(null);
    setBackups([]);
    setRetentionLimit("10");
    void refresh();
  }, [refresh]);

  const connect = async () => {
    const popup = window.open("about:blank", "_blank", "width=600,height=700");
    if (!popup) {
      toast.error("Allow pop-ups to connect Google Drive");
      return;
    }

    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== popup ||
        event.data?.type !== "aiometadata-google-drive-backup"
      ) return;
      window.removeEventListener("message", onMessage);
      if (event.data.success) {
        toast.success("Google Drive connected. Daily backups are enabled.");
        void refresh();
      } else {
        toast.error(event.data.message || "Google Drive connection failed");
      }
    };
    window.addEventListener("message", onMessage);

    try {
      const result = await requestBackupApi<{ authorizationUrl: string }>("/api/google-drive-backup/authorize", requestAuth);
      const authorizationUrl = new URL(String(result.authorizationUrl));
      if (authorizationUrl.origin !== "https://accounts.google.com") {
        throw new Error("The server returned an invalid Google authorization URL");
      }
      popup.location.href = authorizationUrl.toString();
    } catch (error) {
      window.removeEventListener("message", onMessage);
      popup.close();
      toast.error(error instanceof Error ? error.message : "Could not start Google Drive authorization");
    }
  };

  const saveSettings = async (enabled: boolean, limit = Number(retentionLimit)) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_147_483_647) {
      toast.error("Enter a positive whole-number backup limit");
      return;
    }
    setBusy(true);
    try {
      await requestBackupApi("/api/google-drive-backup/settings", requestAuth, {
        enabled,
        retentionLimit: limit,
      });
      toast.success("Google Drive backup settings saved");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save backup settings");
    } finally {
      setBusy(false);
    }
  };

  const backupNow = async () => {
    setBusy(true);
    try {
      await requestBackupApi("/api/google-drive-backup/run", requestAuth);
      toast.success("Configuration backed up to Google Drive");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Google Drive backup failed");
    } finally {
      setBusy(false);
    }
  };

  const downloadPortableBackup = async (backup: DriveBackupFile) => {
    setBusy(true);
    try {
      const result = await requestBackupApi<{ backup: PortableBackup }>(
        "/api/google-drive-backup/export-file",
        requestAuth,
        { fileId: backup.id }
      );
      const blob = new Blob([JSON.stringify(result.backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = backup.name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.json$/i, "") + ".json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success("Portable backup downloaded", {
        description: "The file contains your configuration and Jellyfin history. Store it securely.",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not download this backup");
    } finally {
      setBusy(false);
    }
  };

  const selectPortableBackup = async (file: File | undefined) => {
    if (recoveryUUID) return;
    setPortableBackup(null);
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        (parsed as PortableBackup).formatVersion !== 1 ||
        typeof (parsed as PortableBackup).userUUID !== "string" ||
        !/^[A-Za-z0-9_-]{3,255}$/.test((parsed as PortableBackup).userUUID) ||
        typeof (parsed as PortableBackup).config !== "object" ||
        (parsed as PortableBackup).config === null ||
        Array.isArray((parsed as PortableBackup).config)
      ) {
        throw new Error("This is not a valid AIOMetadata portable backup");
      }
      setPortableBackup(parsed as PortableBackup);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read this backup file");
    }
  };

  const restorePortableBackup = async () => {
    if (!portableBackup) return;
    if (!recoveryPassword) {
      toast.error("Choose a password for the recovered configuration");
      return;
    }
    if (recoveryPassword !== recoveryPasswordConfirm) {
      toast.error("The recovery passwords do not match");
      return;
    }
    setBusy(true);
    let createdUUID = recoveryUUID;
    try {
      let installUrl: string | null = auth.installUrl ?? null;
      if (!createdUUID) {
        const response = await fetch("/api/config/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            config: portableBackup.config,
            password: recoveryPassword,
            addonPassword: recoveryAddonPassword || undefined,
          }),
        });
        const text = await response.text();
        let created: { success?: boolean; userUUID?: string; installUrl?: string; error?: string } = {};
        if (text) {
          try {
            const parsed: unknown = JSON.parse(text);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
              throw new Error("The server returned an invalid recovery response");
            }
            created = parsed as typeof created;
          } catch {
            throw new Error("The server returned an invalid recovery response");
          }
        }
        if (!response.ok || created.success !== true || !created.userUUID) {
          throw new Error(created.error || `Could not create the recovered configuration (${response.status})`);
        }
        createdUUID = created.userUUID;
        installUrl = created.installUrl ?? null;
        setRecoveryUUID(createdUUID);
        setAuth({
          authenticated: true,
          userUUID: createdUUID,
          password: recoveryPassword,
          installUrl,
        });
      }

      if (portableBackup.jellyfinState) {
        await requestBackupApi("/api/google-drive-backup/restore-portable-state", {
          userUUID: createdUUID,
          password: recoveryPassword,
        }, {
          state: portableBackup.jellyfinState,
        });
      }

      const loadResponse = await fetch(`/api/config/load/${encodeURIComponent(createdUUID)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: recoveryPassword }),
      });
      const loaded = await loadResponse.json();
      if (!loadResponse.ok || loaded?.success !== true || !loaded?.config) {
        throw new Error(loaded?.error || "The restored configuration was saved, but could not be reloaded");
      }
      setConfig(loaded.config);
      setAuth({
        authenticated: true,
        userUUID: createdUUID,
        password: recoveryPassword,
        installUrl,
      });
      markConfigPersisted(loaded.config, {
        userUUID: createdUUID,
        installUrl: installUrl ?? "",
      });
      setPortableBackup(null);
      setPortableRestoreOpen(false);
      setRecoveryUUID(null);
      setRecoveryPassword("");
      setRecoveryPasswordConfirm("");
      setRecoveryAddonPassword("");
      toast.success(portableBackup.jellyfinState
        ? `Recovered as a new UUID with configuration and Jellyfin history: ${createdUUID}`
        : `Recovered as a new UUID: ${createdUUID}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not restore this portable backup";
      toast.error(createdUUID
        ? `A new UUID was created (${createdUUID}), but recovery did not finish: ${message}`
        : message);
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!restoreTarget || !userUUID) return;
    setBusy(true);
    let configRestored = false;
    try {
      const result = await requestBackupApi<{
        config: Record<string, unknown>;
        hasJellyfinState?: boolean;
      }>("/api/google-drive-backup/restore", requestAuth, {
        fileId: restoreTarget.id,
      });
      const response = await fetch(`/api/config/update/${encodeURIComponent(userUUID)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: result.config, password: auth.password, force: true }),
      });
      const text = await response.text();
      let updated: { success?: boolean; error?: string } = {};
      if (text) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("The server returned an invalid configuration response");
          }
          updated = parsed as { success?: boolean; error?: string };
        } catch {
          throw new Error("The server returned an invalid configuration response");
        }
      }
      if (!response.ok || updated.success !== true) {
        throw new Error(updated.error || `Configuration restore failed (${response.status})`);
      }
      configRestored = true;
      if (result.hasJellyfinState) {
        await requestBackupApi("/api/google-drive-backup/restore-state", requestAuth, {
          fileId: restoreTarget.id,
        });
      }
      toast.success(result.hasJellyfinState
        ? "Configuration and Jellyfin history restored. Reloading saved settings..."
        : "Configuration restored. Reloading saved settings...");
      window.location.reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not restore this backup";
      toast.error(configRestored
        ? `Configuration restored, but Jellyfin history could not be restored: ${message}`
        : message);
    } finally {
      setBusy(false);
      setRestoreTarget(null);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await requestBackupApi("/api/google-drive-backup/disconnect", requestAuth);
      toast.success("Google Drive disconnected. Existing backup files were kept.");
      setDisconnectOpen(false);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not disconnect Google Drive");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Cloud className="h-5 w-5" /> Google Drive Backups</CardTitle>
          <CardDescription>
            Daily snapshots for this UUID, stored in the connected Google account. Backups contain the saved
            configuration and API keys plus locally stored Jellyfin playback history, favorites, watchlists,
            ratings, and preferences. Authorization tokens are not included.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {loading && !status ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking backup status...
            </div>
          ) : null}

          {status && !status.configured ? (
            <p className="text-sm text-muted-foreground">
              Google Drive backups are unavailable until the server administrator configures Google OAuth.
            </p>
          ) : null}

          {status?.configured && !status.connected ? (
            <Button onClick={() => void connect()} disabled={busy || loading}>
              <ExternalLink className="mr-2 h-4 w-4" /> Connect Google Drive
            </Button>
          ) : null}

          {status?.configured && status.connected ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => void backupNow()} disabled={busy || loading || isDirty !== false}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Cloud className="mr-2 h-4 w-4" />}
                  Back Up Now
                </Button>
                <Button variant="outline" onClick={() => void connect()} disabled={busy || loading}>
                  <ExternalLink className="mr-2 h-4 w-4" /> Reconnect Google Drive
                </Button>
                <Button variant="outline" onClick={() => setDisconnectOpen(true)} disabled={busy}>
                  <Unlink className="mr-2 h-4 w-4" /> Disconnect
                </Button>
                {isDirty ? <span className="text-xs text-muted-foreground">Save your changes before backing up.</span> : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">Last successful backup</div>
                  <div className="mt-1 text-sm">{formatBackupDate(status.lastBackupAt)}</div>
                </div>
                <div className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">Next scheduled backup</div>
                  <div className="mt-1 text-sm">{status.enabled ? formatBackupDate(status.nextBackupAt) : "Paused"}</div>
                </div>
              </div>
              {status.lastBackupFailed ? (
                <p className="text-sm text-destructive">The last backup attempt failed. Try a manual backup or reconnect Google Drive.</p>
              ) : null}

              <div className="flex flex-wrap items-end gap-4 border-t pt-4">
                <div className="flex items-center gap-2">
                  <Switch
                    id="google-drive-backup-schedule"
                    checked={status.enabled}
                    disabled={busy}
                    onCheckedChange={(enabled) => void saveSettings(enabled, status.retentionLimit)}
                  />
                  <Label htmlFor="google-drive-backup-schedule">Daily backups</Label>
                </div>
                <div className="flex items-end gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="google-drive-backup-limit">Backups to keep</Label>
                    <Input
                      id="google-drive-backup-limit"
                      type="number"
                      min={1}
                      max={2_147_483_647}
                      step={1}
                      value={retentionLimit}
                      onChange={(event) => setRetentionLimit(event.target.value)}
                      className="w-32"
                    />
                  </div>
                  <Button
                    variant="outline"
                    disabled={busy || Number(retentionLimit) === status.retentionLimit}
                    onClick={() => void saveSettings(status.enabled)}
                  >
                    <Save className="mr-2 h-4 w-4" /> Save limit
                  </Button>
                </div>
              </div>

              <div className="space-y-2 border-t pt-4">
                <h3 className="text-sm font-medium">Available backups ({backups.length})</h3>
                {backups.length ? backups.map((backup) => (
                  <div key={backup.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{formatBackupDate(backup.createdTime)}</div>
                      <div className="truncate text-xs text-muted-foreground">{backup.name}</div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void downloadPortableBackup(backup)}>
                        <Download className="mr-2 h-4 w-4" /> Download
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setRestoreTarget(backup)}
                      >
                        <RotateCcw className="mr-2 h-4 w-4" /> Restore
                      </Button>
                    </div>
                  </div>
                )) : <p className="text-sm text-muted-foreground">No backups found in this Google Drive account.</p>}
              </div>
            </>
          ) : null}

          <div className="space-y-3 border-t pt-4">
              <div>
                <h3 className="text-sm font-medium">Recover from a portable backup</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Use this to transfer a backup between instances, including instances with different Google OAuth apps.
                  Select a downloaded AIOMetadata backup and choose a new password. Recovery creates a new UUID on this
                  instance and restores the configuration and Jellyfin history under it; any currently loaded UUID is unchanged.
                  {recoveryUUID ? ` Recovery is in progress for ${recoveryUUID}; retrying will continue with that UUID.` : ""}
                </p>
              </div>
              <Input
                type="file"
                accept="application/json,.json"
                disabled={busy || Boolean(recoveryUUID)}
                onChange={(event) => void selectPortableBackup(event.target.files?.[0])}
              />
              {portableBackup ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="portable-recovery-password">New configuration password</Label>
                    <Input
                      id="portable-recovery-password"
                      type="password"
                      autoComplete="new-password"
                      value={recoveryPassword}
                      onChange={(event) => setRecoveryPassword(event.target.value)}
                      disabled={busy}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="portable-recovery-password-confirm">Confirm new password</Label>
                    <Input
                      id="portable-recovery-password-confirm"
                      type="password"
                      autoComplete="new-password"
                      value={recoveryPasswordConfirm}
                      onChange={(event) => setRecoveryPasswordConfirm(event.target.value)}
                      disabled={busy}
                    />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor="portable-recovery-addon-password">Instance add-on password (if required)</Label>
                    <Input
                      id="portable-recovery-addon-password"
                      type="password"
                      autoComplete="current-password"
                      value={recoveryAddonPassword}
                      onChange={(event) => setRecoveryAddonPassword(event.target.value)}
                      disabled={busy}
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 sm:col-span-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      Backup from UUID {portableBackup.userUUID}
                    </span>
                    <Button
                      disabled={busy || !recoveryPassword || recoveryPassword !== recoveryPasswordConfirm}
                      onClick={() => setPortableRestoreOpen(true)}
                    >
                      {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                      {recoveryUUID ? "Continue Recovery" : "Recover as New UUID"}
                    </Button>
                  </div>
                </div>
              ) : null}
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        isOpen={Boolean(restoreTarget)}
        onClose={() => setRestoreTarget(null)}
        onConfirm={() => void restore()}
        title="Replace Configuration"
        description={`Restore ${restoreTarget ? formatBackupDate(restoreTarget.createdTime) : "this backup"}? This replaces the saved configuration for this UUID. The current configuration will be overwritten.`}
        confirmText="Restore Backup"
      />
      <ConfirmDialog
        isOpen={portableRestoreOpen}
        onClose={() => setPortableRestoreOpen(false)}
        onConfirm={() => void restorePortableBackup()}
        title="Create recovered configuration"
        description={`Create a new UUID from the backup made for ${portableBackup?.userUUID ?? "the selected file"}? Any current configuration remains unchanged. You will sign into the new UUID with the password you entered. Linked OAuth tokens are not included.`}
        confirmText={recoveryUUID ? "Continue Recovery" : "Create New UUID"}
      />
      <ConfirmDialog
        isOpen={disconnectOpen}
        onClose={() => setDisconnectOpen(false)}
        onConfirm={() => void disconnect()}
        title="Disconnect Google Drive"
        description="Scheduled backups will stop and the local authorization token will be removed. Existing backup files will remain in Google Drive."
        confirmText="Disconnect"
      />
    </>
  );
}
