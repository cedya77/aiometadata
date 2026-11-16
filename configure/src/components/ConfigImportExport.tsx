// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useState, useEffect } from "react";
import { useConfig } from "@/contexts/ConfigContext";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Download, Upload, FileText, Shield, AlertCircle, Loader2, Trash2, Lock, KeyRound, Link as LinkIcon } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { exportConfigFile } from "@/lib/exportConfigFile";
import { mergeImportedAccounts } from "@/lib/managerAccounts";
import { CollapsibleSettingCard } from "@/components/settings/CollapsibleSettingCard";
import { SettingRow } from "@/components/settings/SettingRow";

export function ConfigImportExport() {
  const { config, setConfig, resetConfig: resetConfigFromContext, auth, setAuth } = useConfig();
  const [excludeApiKeys, setExcludeApiKeys] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [addonVersion, setAddonVersion] = useState("");
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [addonPassword, setAddonPassword] = useState('');
  const [requiresAddonPassword, setRequiresAddonPassword] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [signedInWithAccount, setSignedInWithAccount] = useState(false);


  useEffect(() => {
    fetch("/api/config/addon-info")
      .then(res => res.json())
      .then(data => {
        setAddonVersion(data.addonVersion || "unknown");
        setRequiresAddonPassword(!!data.requiresAddonPassword);
      })
      .catch(err => {
        console.error('Failed to fetch addon-info:', err);
        setAddonVersion("unknown");
        setRequiresAddonPassword(false);
      });
  }, []);

  const exportConfig = () => {
    setIsExporting(true);
    try {
      exportConfigFile(config, {
        addonVersion,
        excludeApiKeys,
      });

      toast.success("Configuration exported successfully!", {
        description: excludeApiKeys ? "API keys were excluded from export" : "Full configuration exported"
      });
    } catch (error) {
      console.error('Export error:', error);
      toast.error("Failed to export configuration", {
        description: "Please try again"
      });
    } finally {
      setIsExporting(false);
    }
  };

  const applyImport = (importData: any) => {
    // Validate the import data
    if (!importData.config || !importData.version) {
      throw new Error("Invalid configuration file format");
    }

    // Check if this is a different version (basic version check)
    if (importData.version !== addonVersion) {
      toast.warning("Configuration file version mismatch", {
        description: `This file was exported from version ${importData.version}, but you're running ${addonVersion}. Some settings may not import correctly.`
      });
    }

    const mergedConfig = {
      ...importData.config,
      // Credentials, not content: an import adds destinations it knows about and
      // never removes the ones already holding a working key.
      managers: config.managers,
      managerAccounts: mergeImportedAccounts(config.managerAccounts, importData.config.managerAccounts),
      apiKeys: (() => {
        if (importData.metadata?.apiKeysExcluded) {
          return config.apiKeys;
        }

        if (!importData.config.apiKeys) {
          return config.apiKeys;
        }

        const importedKeys = importData.config.apiKeys;
        const allKeysEmpty = Object.values(importedKeys).every(key => !key || (typeof key === 'string' && key.trim() === ''));

        if (allKeysEmpty) {
          return config.apiKeys;
        }

        return importedKeys;
      })()
    };

    setConfig(prev => ({
      ...mergedConfig,
      catalogSetupComplete: true,
      apiKeys: {
        ...mergedConfig.apiKeys,
        customDescriptionBlurb: prev.apiKeys.customDescriptionBlurb,
      },
    }));

    toast.success("Configuration imported successfully!", {
      description: `Imported ${importData.metadata?.enabledCatalogs || 0} enabled catalogs`
    });

    // Show summary of what was imported
    const summary = {
      catalogs: importData.config.catalogs?.length || 0,
      enabledCatalogs: importData.config.catalogs?.filter((catalog: { enabled?: boolean }) => catalog.enabled).length || 0,
      apiKeysIncluded: !importData.metadata?.apiKeysExcluded,
      language: importData.config.language,
      providers: importData.config.providers
    };

    console.log('Import summary:', summary);
  };

  const reportImportError = (error: unknown, fallback: string) => {
    console.error('Import error:', error);
    toast.error("Failed to import configuration", {
      description: error instanceof Error ? error.message : fallback
    });
  };

  const importConfig = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) return;

      setIsImporting(true);
      try {
        applyImport(JSON.parse(await file.text()));
      } catch (error) {
        reportImportError(error, "Invalid file format");
      } finally {
        setIsImporting(false);
      }
    };
    input.click();
  };

  const readJson = async (target: string) => {
    const response = await fetch(target);
    const body = await response.text();

    if (!response.ok) {
      let message = `The link returned ${response.status}`;
      try {
        message = JSON.parse(body)?.error || message;
      } catch {
        /* empty */
      }
      throw new Error(message);
    }

    try {
      const parsed = JSON.parse(body);
      return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
    } catch {
      throw new Error("That link did not return JSON");
    }
  };

  const importFromUrl = async () => {
    const url = importUrl.trim();

    try {
      const { protocol } = new URL(url);
      if (protocol !== 'http:' && protocol !== 'https:') {
        throw new Error('unsupported protocol');
      }
    } catch {
      toast.error("Enter a valid link", {
        description: "It has to start with http:// or https://"
      });
      return;
    }

    setIsImporting(true);
    try {
      let data: any;
      try {
        data = await readJson(url);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        data = await readJson(`/api/proxy-manifest?url=${encodeURIComponent(url)}`);
      }
      applyImport(data);
      setImportUrl('');
    } catch (error) {
      reportImportError(error, "Could not read that link");
    } finally {
      setIsImporting(false);
    }
  };

  const resetConfig = () => {
    setShowResetDialog(true);
  };

  const handleResetConfirm = () => {
    resetConfigFromContext();
    toast.success("Configuration reset to defaults");
  };

  const openChangePassword = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmNewPassword('');
    setShowChangePassword(true);
    fetch('/api/auth/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((status) => setSignedInWithAccount(Boolean(status?.signedIn)))
      .catch(() => setSignedInWithAccount(false));
  };

  const newPasswordProblem =
    newPassword.length > 0 && newPassword.length < 6 ? 'At least 6 characters'
      : confirmNewPassword.length > 0 && confirmNewPassword !== newPassword ? 'The two new passwords differ'
        : '';
  const canChangePassword = newPassword.length >= 6 && newPassword === confirmNewPassword && (signedInWithAccount || currentPassword.length > 0) && !changingPassword;

  const handleChangePassword = async () => {
    if (!canChangePassword || !auth.userUUID) return;
    setChangingPassword(true);
    try {
      const response = await fetch(`/api/config/change-password/${encodeURIComponent(auth.userUUID)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Failed to change the password');
      // Saving from this page sends the password, so it carries on with the new one.
      setAuth((prev) => ({ ...prev, password: newPassword }));
      setShowChangePassword(false);
      toast.success('Password changed', { description: 'Jellyfin apps and personal pages sign in again with the new one.' });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to change the password');
    } finally {
      setChangingPassword(false);
    }
  };

  const deleteUserRecords = async () => {
    if (!auth.userUUID) {
      toast.error("No user account found", {
        description: "You must be logged in to delete your records"
      });
      return;
    }

    setShowPasswordDialog(true);
    console.log("requiresAddonPassword before showing password dialog:", requiresAddonPassword);
  };

  const handlePasswordConfirm = async () => {
    if (!deletePassword.trim()) {
      toast.error("Password is required", {
        description: "Please enter your password to confirm deletion"
      });
      return;
    }

    if (requiresAddonPassword && !addonPassword.trim()) {
      toast.error("Addon Password is required", {
        description: "Please enter the addon password to confirm deletion"
      });
      return;
    }

    setShowPasswordDialog(false);
    setShowDeleteDialog(true);
  };

  const handleDeleteConfirm = async () => {
    setIsDeleting(true);
    try {
      const body: { password: string; addonPassword?: string } = {
        password: deletePassword
      };

      if (requiresAddonPassword && addonPassword) {
        body.addonPassword = addonPassword;
      }
      
      const response = await fetch(`/api/config/delete-user/${encodeURIComponent(auth.userUUID)}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body)
      });

      if (response.ok) {
        toast.success("User records deleted successfully", {
          description: "You have been logged out and all your data has been removed"
        });
        
        // Clear auth state and redirect to home
        setAuth({ authenticated: false, userUUID: null, password: null });
        window.location.href = '/configure';
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete user records');
      }
    } catch (error) {
      console.error('Delete user error:', error);
      toast.error("Failed to delete user records", {
        description: error instanceof Error ? error.message : "Please try again"
      });
    } finally {
      setIsDeleting(false);
      setDeletePassword('');
    }
  };



  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold">Import & Export</h2>
        <p className="text-muted-foreground mt-1">
          Backup your configuration or import settings from another device.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Export Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Download className="h-5 w-5" />
              Export Configuration
            </CardTitle>
            <CardDescription>
              Download your current configuration as a JSON file for backup or sharing.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center space-x-2">
              <Switch
                id="exclude-api-keys"
                checked={excludeApiKeys}
                onCheckedChange={setExcludeApiKeys}
              />
              <Label htmlFor="exclude-api-keys" className="flex items-center gap-2">
                <Shield className="h-4 w-4" />
                Exclude API keys from export
              </Label>
            </div>
            
            <div className="text-sm text-muted-foreground">
              {excludeApiKeys ? (
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 mt-0.5 text-amber-500" />
                  <span>API keys will be excluded for security. You'll need to re-enter them after import.</span>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <FileText className="h-4 w-4 mt-0.5 text-blue-500" />
                  <span>Full configuration including API keys will be exported.</span>
                </div>
              )}
            </div>

            <Button 
              onClick={exportConfig} 
              disabled={isExporting}
              className="w-full"
            >
              {isExporting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Exporting...
                </>
              ) : (
                <>
                  <Download className="mr-2 h-4 w-4" />
                  Export Configuration
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Import Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" />
              Import Configuration
            </CardTitle>
            <CardDescription>
              Import a previously exported configuration file.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-sm text-muted-foreground">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5 text-amber-500" />
                <span>This will replace your current configuration. Make sure to backup first.</span>
              </div>
            </div>

            <Button
              onClick={importConfig}
              disabled={isImporting}
              variant="outline"
              className="w-full"
            >
              {isImporting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Importing...
                </>
              ) : (
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  Import Configuration
                </>
              )}
            </Button>

            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or from a link</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="import-url" className="flex items-center gap-2 text-sm font-medium">
                <LinkIcon className="h-4 w-4" />
                Configuration URL
              </Label>
              <div className="flex gap-2">
                <Input
                  id="import-url"
                  type="url"
                  inputMode="url"
                  value={importUrl}
                  onChange={(e) => setImportUrl(e.target.value)}
                  placeholder="https://example.com/aiometadata-config.json"
                  disabled={isImporting}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && importUrl.trim()) {
                      void importFromUrl();
                    }
                  }}
                />
                <Button
                  onClick={() => void importFromUrl()}
                  disabled={isImporting || !importUrl.trim()}
                  variant="outline"
                  className="shrink-0"
                >
                  {isImporting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Fetch"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Point this at a hosted export, such as a raw file link or a paste. Only the person you got the link
                from can see what it holds, so treat it the way you would treat a config file someone sent you.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <CollapsibleSettingCard
        title="Danger Zone"
        description="Reset your configuration, change its password, or permanently delete your account."
      >
        <div className="divide-y">
          <SettingRow
            label="Reset to Defaults"
            description="Returns every setting to its default. Anything you have not saved is lost; a saved configuration can be loaded again."
            control={
              <Button
                onClick={resetConfig}
                variant="outline"
                className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                Reset
              </Button>
            }
          />

          {auth.authenticated && auth.userUUID ? (
            <SettingRow
              id="change-password"
              label="Change Password"
              description="Sets a new password for this configuration. Jellyfin apps signed in to it are signed out and sign in again with the new one, and so do personal pages. Install links keep working."
              control={
                <Button onClick={openChangePassword} variant="outline">
                  <KeyRound className="mr-2 h-4 w-4" />
                  Change
                </Button>
              }
            />
          ) : null}

          {auth.authenticated && auth.userUUID ? (
            <SettingRow
              label="Delete User Records"
              description="Permanently deletes your saved configuration and your account. This cannot be undone."
              control={
                <Button
                  onClick={deleteUserRecords}
                  disabled={isDeleting}
                  variant="destructive"
                >
                  {isDeleting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Deleting...
                    </>
                  ) : (
                    <>
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete User Records
                    </>
                  )}
                </Button>
              }
            />
          ) : null}
        </div>
      </CollapsibleSettingCard>

      {/* Confirmation Dialogs */}
      <ConfirmDialog
        isOpen={showResetDialog}
        onClose={() => setShowResetDialog(false)}
        onConfirm={handleResetConfirm}
        title="Reset Configuration"
        description="Are you sure you want to reset your configuration to defaults?\n\nThis action cannot be undone."
        confirmText="Reset to Defaults"
        variant="destructive"
      />

      <ConfirmDialog
        isOpen={showDeleteDialog}
        onClose={() => setShowDeleteDialog(false)}
        onConfirm={handleDeleteConfirm}
        title="Delete User Records"
        description={`⚠️ WARNING: This will permanently delete ALL your data!

• Your user account
• Your configuration
• Your saved settings
• All associated data

This action CANNOT be undone. Are you absolutely sure?`}
        confirmText="Delete All Data"
        variant="destructive"
        icon={<Trash2 className="h-5 w-5 text-destructive" />}
      />

      <Dialog open={showChangePassword} onOpenChange={(open) => !changingPassword && setShowChangePassword(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              Change Password
            </DialogTitle>
            <DialogDescription>
              Jellyfin apps signed in to this configuration are signed out and need the new password, and so do personal pages. Install links keep working.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              handleChangePassword();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="current-password">Current password</Label>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
              {signedInWithAccount && (
                <p className="text-xs text-muted-foreground">Not needed when the account you are signed in with owns this configuration.</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-new-password">Confirm new password</Label>
              <Input
                id="confirm-new-password"
                type="password"
                autoComplete="new-password"
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
              />
              <p className={`text-xs ${newPasswordProblem ? 'text-destructive' : 'text-muted-foreground'}`}>
                {newPasswordProblem || 'At least 6 characters.'}
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowChangePassword(false)} disabled={changingPassword}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canChangePassword}>
                {changingPassword ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Change Password
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Password Dialog */}
      <Dialog open={showPasswordDialog} onOpenChange={setShowPasswordDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5 text-destructive" />
              Confirm Password
            </DialogTitle>
            <DialogDescription>
              Please enter your password to confirm the deletion of your user account and all associated data.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="delete-password">Password</Label>
              <Input
                id="delete-password"
                type="password"
                value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)}
                placeholder="Enter your password"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handlePasswordConfirm();
                  }
                }}
              />
            </div>
            {requiresAddonPassword && (
              <div className="space-y-2">
                <Label htmlFor="delete-addon-password">Addon Password</Label>
                <Input
                  id="delete-addon-password"
                  type="password"
                  value={addonPassword}
                  onChange={(e) => setAddonPassword(e.target.value)}
                  placeholder="Enter the addon password"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handlePasswordConfirm();
                    }
                  }}
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPasswordDialog(false)}>
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={handlePasswordConfirm}
              disabled={!deletePassword.trim()}
            >
              Confirm Password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
