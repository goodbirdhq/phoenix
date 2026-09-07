import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId, ProviderInstanceConfig } from "@t3tools/contracts";
import {
  resolveProviderInstanceEnabled,
  type ProviderDriverKind,
  defaultInstanceIdForDriver,
  ProviderFailoverGroup,
} from "@t3tools/contracts";
import {
  EyeIcon,
  EyeOffIcon,
  StarIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  PlusIcon,
  TrashIcon,
} from "lucide-react";
import { useEnvironmentSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironment } from "../../state/environments";
import {
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { ProviderSettingsForm } from "../settings/ProviderSettingsForm";
import { DRIVER_OPTION_BY_VALUE } from "../settings/providerDriverMeta";
import { deriveProviderModelsForDisplay } from "../settings/ProviderInstanceCard";
import {
  buildProviderInstanceUpdatePatch,
  resolveProviderInstanceSettings,
} from "../settings/SettingsPanels.logic";
import { validateProviderFailoverGroupName } from "../settings/ProviderFailoverGroups.logic";
import { resolveAppModelSelectionState } from "../../modelSelection";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { toastManager } from "../ui/toast";

const COLORS = ["#2563eb", "#4f46e5", "#16a34a", "#ea580c", "#dc2626", "#7c3aed", "#0891b2"];

/** A single draft spans all tabs; only Save sends it to the selected environment. */
export function UsageProviderDialog({
  environmentId,
  instanceId,
  driver,
  onClose,
  onSavingChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly onClose: () => void;
  readonly onSavingChange: (saving: boolean) => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const live = providers?.find((provider) => provider.instanceId === instanceId);
  const environment = useEnvironment(environmentId);
  const saved = resolveProviderInstanceSettings(settings, instanceId, driver);
  const [draft, setDraft] = useState<ProviderInstanceConfig>(
    () => saved ?? { driver, enabled: false },
  );
  const [hidden, setHidden] = useState(() => [
    ...(settings.providerModelPreferences[instanceId]?.hiddenModels ?? []),
  ]);
  const [order, setOrder] = useState(() => [
    ...(settings.providerModelPreferences[instanceId]?.modelOrder ?? []),
  ]);
  const [favorites, setFavorites] = useState(() =>
    settings.favorites.filter((f) => f.provider === instanceId).map((f) => f.model),
  );
  const [failoverGroup, setFailoverGroup] = useState(saved?.failoverGroup ?? "");
  const [customModel, setCustomModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, "save provider settings");
  const updateClient = useUpdateClientSettings();
  const definition = DRIVER_OPTION_BY_VALUE[draft.driver];
  const Mark = definition?.icon;
  const config: Record<string, unknown> =
    draft.config && typeof draft.config === "object" ? { ...draft.config } : {};
  const customModels = Array.isArray(config.customModels)
    ? config.customModels.filter((value): value is string => typeof value === "string")
    : [];
  const models = deriveProviderModelsForDisplay({
    liveModels: live?.models,
    customModels,
  }).toSorted((a, b) => {
    const left = order.indexOf(a.slug),
      right = order.indexOf(b.slug);
    return (left < 0 ? Infinity : left) - (right < 0 ? Infinity : right);
  });
  const nextVariableId = useRef(0);
  const [variables, setVariables] = useState(() =>
    (saved?.environment ?? []).map((variable) => ({
      ...variable,
      rowId: nextVariableId.current++,
    })),
  );
  const toggle = (values: string[], value: string) =>
    values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
  const save = async () => {
    const names = variables.map((variable) => variable.name.trim());
    if (
      names.some((name) => !/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(name)) ||
      new Set(names).size !== names.length
    ) {
      setError(
        "Use unique environment variable names containing letters, numbers and underscores.",
      );
      return;
    }
    const groupError = failoverGroup.trim()
      ? validateProviderFailoverGroupName(
          failoverGroup,
          Object.entries(settings.providerInstances).map(([id, instance]) => ({
            instanceId: id as ProviderInstanceId,
            instance,
          })),
          draft.driver,
        )
      : null;
    if (groupError) {
      setError(groupError);
      return;
    }
    setError(null);
    setSaving(true);
    onSavingChange(true);
    const result = await saveSettings({
      environmentId,
      input: {
        patch: buildProviderInstanceUpdatePatch({
          settings,
          instanceId,
          driver: draft.driver,
          isDefault: instanceId === defaultInstanceIdForDriver(draft.driver),
          ...(!resolveProviderInstanceEnabled(draft) &&
          resolveAppModelSelectionState(settings, providers ?? []).instanceId === instanceId
            ? {
                textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
              }
            : {}),
          instance: {
            ...draft,
            displayName: draft.displayName?.trim() || undefined,
            failoverGroup: failoverGroup.trim()
              ? ProviderFailoverGroup.make(failoverGroup.trim())
              : undefined,
            environment: variables.map(({ rowId: _rowId, ...variable }) => ({
              ...variable,
              name: variable.name.trim(),
            })),
          },
        }),
      },
    });
    setSaving(false);
    onSavingChange(false);
    if (result._tag === "Failure") {
      setError(
        "Could not save provider settings. Your draft is still here; reconnect and try again.",
      );
      return;
    }
    updateClient({
      providerModelPreferences: {
        ...settings.providerModelPreferences,
        [instanceId]: { hiddenModels: hidden, modelOrder: order },
      },
      favorites: [
        ...settings.favorites.filter((f) => f.provider !== instanceId),
        ...favorites.map((model) => ({ provider: instanceId, model })),
      ],
    });
    toastManager.add({ type: "success", title: "Provider settings saved" });
    onClose();
  };
  return (
    <DialogPopup className="usage-surface w-[620px] max-w-[calc(100vw-32px)] rounded-[14px] p-0">
      <div className="flex h-[649px] max-h-[calc(100dvh-50px)] flex-col">
        <DialogHeader className="items-center px-7 pt-7 text-center">
          {Mark && <Mark className="size-6" />}
          <DialogTitle>Edit {definition?.label ?? "provider"} provider</DialogTitle>
          <DialogDescription>
            Manage this provider instance on {environment?.label ?? "the selected environment"}.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="general" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="shrink-0 gap-5 px-7">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="environment">Environment variables</TabsTrigger>
            <TabsTrigger value="configuration">Configuration</TabsTrigger>
            <TabsTrigger value="models">Models</TabsTrigger>
          </TabsList>
          <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-5">
            <TabsContent value="general" className="space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <label className="space-y-2 text-xs">
                  Display name
                  <Input
                    placeholder={definition?.label}
                    value={draft.displayName ?? ""}
                    onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
                  />
                </label>
                <label className="space-y-2 text-xs">
                  Instance ID
                  <Input value={instanceId} disabled />
                  <span className="text-[11px] text-muted-foreground">
                    Routing identity cannot change.
                  </span>
                </label>
              </div>
              <div className="space-y-2">
                <div className="text-xs">Accent colour</div>
                <div className="flex gap-2">
                  {COLORS.map((color) => (
                    <button
                      key={color}
                      aria-label={`Accent ${color}`}
                      aria-pressed={draft.accentColor === color}
                      onClick={() => setDraft({ ...draft, accentColor: color })}
                      className="size-5 rounded-full ring-offset-2 aria-pressed:ring-2 aria-pressed:ring-ring"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>
              <label className="block space-y-2 text-xs">
                Failover group
                <Input
                  placeholder="Ungrouped — never switch automatically"
                  value={failoverGroup}
                  onChange={(event) => setFailoverGroup(event.target.value)}
                />
                <span className="text-[11px] text-muted-foreground">
                  Only instances using the same provider can share a group.
                </span>
              </label>
              <div className="flex items-center justify-between rounded-lg border bg-muted/30 p-3">
                <div>
                  <div className="text-xs font-medium">Provider enabled</div>
                  <div className="text-[11px] text-muted-foreground">
                    Available for new sessions and model selection.
                  </div>
                </div>
                <Switch
                  aria-label="Provider enabled"
                  checked={resolveProviderInstanceEnabled(draft)}
                  onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
                />
              </div>
            </TabsContent>
            <TabsContent value="environment" className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium">Environment variables</h3>
                  <p className="text-[11px] text-muted-foreground">
                    Pass API keys, URLs and per-instance CLI settings.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setVariables([
                      ...variables,
                      { rowId: nextVariableId.current++, name: "", value: "", sensitive: true },
                    ])
                  }
                >
                  <PlusIcon />
                  Add variable
                </Button>
              </div>
              {variables.map((variable, index) => (
                <div
                  key={variable.rowId}
                  className="grid grid-cols-[1fr_1.3fr_28px_28px] items-center gap-2"
                >
                  <Input
                    aria-label={`Variable ${index + 1} name`}
                    value={variable.name}
                    onChange={(event) =>
                      setVariables(
                        variables.map((entry) =>
                          entry.rowId === variable.rowId
                            ? { ...entry, name: event.target.value }
                            : entry,
                        ),
                      )
                    }
                  />
                  <Input
                    aria-label={`Variable ${index + 1} value`}
                    type={variable.sensitive ? "password" : "text"}
                    placeholder={variable.valueRedacted ? "Stored secret · unchanged" : "Value"}
                    value={variable.valueRedacted ? "" : variable.value}
                    onChange={(event) =>
                      setVariables(
                        variables.map((entry) =>
                          entry.rowId === variable.rowId
                            ? { ...entry, value: event.target.value, valueRedacted: false }
                            : entry,
                        ),
                      )
                    }
                  />
                  <button
                    aria-label={`Toggle secret ${index + 1}`}
                    aria-pressed={variable.sensitive}
                    onClick={() =>
                      setVariables(
                        variables.map((entry) =>
                          entry.rowId === variable.rowId
                            ? { ...entry, sensitive: !entry.sensitive }
                            : entry,
                        ),
                      )
                    }
                  >
                    {variable.sensitive ? (
                      <EyeOffIcon className="size-4" />
                    ) : (
                      <EyeIcon className="size-4" />
                    )}
                  </button>
                  <button
                    aria-label={`Remove variable ${index + 1}`}
                    onClick={() =>
                      setVariables(variables.filter((entry) => entry.rowId !== variable.rowId))
                    }
                  >
                    <TrashIcon className="size-4" />
                  </button>
                </div>
              ))}
              <p className="text-[11px] text-muted-foreground">
                Sensitive values are stored securely and redacted when read back.
              </p>
            </TabsContent>
            <TabsContent value="configuration">
              {definition ? (
                <ProviderSettingsForm
                  definition={definition}
                  value={draft.config}
                  idPrefix={`usage-${instanceId}`}
                  variant="dialog"
                  onChange={(config) => setDraft({ ...draft, config })}
                />
              ) : (
                <p className="text-sm">This provider uses settings from a newer runtime.</p>
              )}
            </TabsContent>
            <TabsContent value="models" className="space-y-3">
              <div>
                <h3 className="text-sm font-medium">Models</h3>
                <p className="text-[11px] text-muted-foreground">
                  Choose favourites, visibility and model order.
                </p>
              </div>
              {models.map((model, index) => (
                <div key={model.slug} className="flex items-center gap-2 border-b py-2 text-xs">
                  <span className="min-w-0 flex-1 truncate">{model.name}</span>
                  <button
                    aria-label={`Favourite ${model.name}`}
                    aria-pressed={favorites.includes(model.slug)}
                    onClick={() => setFavorites(toggle(favorites, model.slug))}
                  >
                    <StarIcon
                      className="size-3.5"
                      fill={favorites.includes(model.slug) ? "currentColor" : "none"}
                    />
                  </button>
                  <button
                    aria-label={`Move ${model.name} up`}
                    disabled={index === 0}
                    onClick={() => {
                      const next = models.map((m) => m.slug);
                      [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                      setOrder(next);
                    }}
                  >
                    <ArrowUpIcon className="size-3.5" />
                  </button>
                  <button
                    aria-label={`Move ${model.name} down`}
                    disabled={index === models.length - 1}
                    onClick={() => {
                      const next = models.map((m) => m.slug);
                      [next[index + 1], next[index]] = [next[index]!, next[index + 1]!];
                      setOrder(next);
                    }}
                  >
                    <ArrowDownIcon className="size-3.5" />
                  </button>
                  <button
                    aria-label={`${hidden.includes(model.slug) ? "Show" : "Hide"} ${model.name}`}
                    onClick={() => setHidden(toggle(hidden, model.slug))}
                  >
                    {hidden.includes(model.slug) ? (
                      <EyeOffIcon className="size-3.5" />
                    ) : (
                      <EyeIcon className="size-3.5" />
                    )}
                  </button>
                  {model.isCustom && (
                    <button
                      aria-label={`Remove ${model.name}`}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          config: {
                            ...config,
                            customModels: customModels.filter((name) => name !== model.slug),
                          },
                        })
                      }
                    >
                      <TrashIcon className="size-3.5" />
                    </button>
                  )}
                </div>
              ))}
              <div className="flex gap-2">
                <Input
                  aria-label="Custom model ID"
                  placeholder="Custom model ID"
                  value={customModel}
                  onChange={(event) => setCustomModel(event.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    !customModel.trim() || models.some((model) => model.slug === customModel.trim())
                  }
                  onClick={() => {
                    setDraft({
                      ...draft,
                      config: { ...config, customModels: [...customModels, customModel.trim()] },
                    });
                    setCustomModel("");
                  }}
                >
                  Add model
                </Button>
              </div>
            </TabsContent>
          </div>
        </Tabs>
        <div role="status" className="min-h-6 px-7 text-xs text-destructive">
          {error}
        </div>
        <DialogFooter variant="bare" className="h-16 shrink-0 items-center border-t px-7">
          <span className="mr-auto text-[11px] text-muted-foreground">
            Unsaved changes apply across all tabs.
          </span>
          <Button size="sm" variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={saving || !saved || environment?.connection.phase !== "connected"}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </div>
    </DialogPopup>
  );
}
