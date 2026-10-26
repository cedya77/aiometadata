import { useState } from "react";
import { useConfig } from "@/contexts/ConfigContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/settings/Callout";
import { ChevronDown, Link2, Loader2, Unlink } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  PARENT_SECTIONS,
  type MergeStrategy,
  type ParentConfigLink,
  type ParentSection,
} from "../../../addon/lib/parentConfig";

const STRATEGY_LABELS: Record<MergeStrategy, string> = {
  inherit: "Inherit from Parent",
  extend: "Extend Parent (Add Mine)",
  override: "Override with Mine",
};

const SECTION_DEFAULT = "section";

function strategyOptions(extendable: boolean): MergeStrategy[] {
  return extendable ? ["inherit", "extend", "override"] : ["inherit", "override"];
}

export function ParentConfigCard() {
  const { config, setConfig, auth } = useConfig();
  const link = config.parentConfig;
  const [uuidInput, setUuidInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [linking, setLinking] = useState(false);
  const [openSection, setOpenSection] = useState<string | null>(null);

  const updateLink = (update: (link: ParentConfigLink) => ParentConfigLink) =>
    setConfig(prev => (prev.parentConfig ? { ...prev, parentConfig: update(prev.parentConfig) } : prev));

  const handleLink = async (event: React.FormEvent) => {
    event.preventDefault();
    const uuid = uuidInput.trim();
    if (!uuid || !passwordInput) return;
    if (auth.userUUID && uuid === auth.userUUID) {
      toast.error("A configuration cannot be its own parent");
      return;
    }
    setLinking(true);
    try {
      const response = await fetch(`/api/config/verify-parent/${encodeURIComponent(uuid)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: passwordInput }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "Could not link the parent configuration");
      if (auth.userUUID && result.userUUID === auth.userUUID) throw new Error("A configuration cannot be its own parent");
      setConfig(prev => ({
        ...prev,
        parentConfig: { uuid: result.userUUID, password: passwordInput, mergeStrategies: {} },
      }));
      setUuidInput("");
      setPasswordInput("");
      toast.success("Parent linked", { description: "Save your configuration to apply it." });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not link the parent configuration");
    } finally {
      setLinking(false);
    }
  };

  const handleUnlink = () => {
    setConfig(prev => ({ ...prev, parentConfig: undefined }));
    toast.success("Parent unlinked", { description: "Save your configuration to apply it." });
  };

  const setSectionStrategy = (section: ParentSection, value: MergeStrategy) =>
    updateLink(current => ({
      ...current,
      mergeStrategies: { ...current.mergeStrategies, [section.id]: value },
    }));

  const setFieldStrategy = (key: string, value: string) =>
    updateLink(current => {
      const fieldOverrides = { ...current.mergeStrategies?.fieldOverrides };
      if (value === SECTION_DEFAULT) delete fieldOverrides[key];
      else fieldOverrides[key] = value as MergeStrategy;
      return {
        ...current,
        mergeStrategies: {
          ...current.mergeStrategies,
          fieldOverrides: Object.keys(fieldOverrides).length > 0 ? fieldOverrides : undefined,
        },
      };
    });

  return (
    <Card id="parent-config">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-5 w-5" />
          Parent Config
        </CardTitle>
        <CardDescription>
          Take settings from another configuration on this instance. Anything saved to the parent reaches this
          configuration right away, so one change updates every configuration linked to it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!link ? (
          <form onSubmit={handleLink} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="parent-config-uuid">Parent UUID</Label>
              <Input
                id="parent-config-uuid"
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                autoComplete="off"
                value={uuidInput}
                onChange={e => setUuidInput(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="parent-config-password">Parent Password</Label>
              <Input
                id="parent-config-password"
                type="password"
                autoComplete="off"
                value={passwordInput}
                onChange={e => setPasswordInput(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={linking || !uuidInput.trim() || !passwordInput}>
              {linking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              Link Parent
            </Button>
          </form>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/20 p-3">
              <div className="flex min-w-0 items-center gap-2">
                <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-xs text-muted-foreground">{link.uuid}</span>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={handleUnlink}>
                <Unlink className="h-4 w-4" />
                Unlink
              </Button>
            </div>

            <Callout variant="info">
              The other pages keep showing this configuration's own settings; sections set to Inherit are served
              from the parent instead. Tracker sign-ins, watch tracking, manager accounts, Jellyfin users and
              recommendations always stay this configuration's own. Only one level is followed: a parent's own
              parent is ignored.
            </Callout>

            <div className="divide-y">
              {PARENT_SECTIONS.map(section => {
                const sectionStrategy = link.mergeStrategies?.[section.id] ?? "inherit";
                const overrides = link.mergeStrategies?.fieldOverrides ?? {};
                const overrideCount = section.fields.filter(field => overrides[field.key]).length;
                const open = openSection === section.id;
                return (
                  <div key={section.id} className="py-3">
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                      <div className="min-w-[12rem] flex-1">
                        <Label htmlFor={`parent-strategy-${section.id}`} className="text-sm font-medium">
                          {section.label}
                        </Label>
                        <p className="text-sm text-muted-foreground mt-0.5">{section.description}</p>
                        <button
                          type="button"
                          onClick={() => setOpenSection(open ? null : section.id)}
                          aria-expanded={open}
                          className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
                          Field Overrides{overrideCount > 0 ? ` (${overrideCount})` : ""}
                        </button>
                      </div>
                      <Select
                        value={sectionStrategy}
                        onValueChange={value => setSectionStrategy(section, value as MergeStrategy)}
                      >
                        <SelectTrigger id={`parent-strategy-${section.id}`} className="w-64">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {strategyOptions(!!section.extendable).map(strategy => (
                            <SelectItem key={strategy} value={strategy}>{STRATEGY_LABELS[strategy]}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {open ? (
                      <div className="mt-3 space-y-2 border-l pl-4">
                        {section.fields.map(field => (
                          <div key={field.key} className="flex flex-wrap items-center justify-between gap-2">
                            <Label htmlFor={`parent-field-${field.key}`} className="text-sm font-normal">
                              {field.label}
                            </Label>
                            <Select
                              value={overrides[field.key] ?? SECTION_DEFAULT}
                              onValueChange={value => setFieldStrategy(field.key, value)}
                            >
                              <SelectTrigger id={`parent-field-${field.key}`} className="w-64">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={SECTION_DEFAULT}>Use Section Setting</SelectItem>
                                {strategyOptions(!!field.identity).map(strategy => (
                                  <SelectItem key={strategy} value={strategy}>{STRATEGY_LABELS[strategy]}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
