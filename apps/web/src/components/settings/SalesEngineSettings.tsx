import { readSalesFailure } from "@t3tools/client-runtime/sales/failure";
import { shortFingerprint } from "@t3tools/client-runtime/sales/signing";
import { createDeviceKey, thisDeviceDescription } from "@t3tools/client-runtime/sales/devices";
import {
  ProviderDriverKind,
  canStartProviderSession,
  defaultSalesRunModel,
  modelSelectionUnavailable,
  type EnvironmentId,
  type ModelSelection,
  type SalesDevice,
  type SalesEngineSettings as SalesEngineSettingsValue,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProjects } from "../../state/entities";
import type { EnvironmentPresentation } from "../../state/environments";
import {
  salesDeviceKeyStore,
  salesEnvironment,
  useSalesDevice,
  useSalesDeviceGuard,
} from "../../state/sales";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { getDriverOption } from "./providerDriverMeta";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

/**
 * The sales engine this environment's server reads for the Sales area, and the devices that
 * approve its drafts. Tokens are write-only: the server keeps them in its secret store and only
 * reports whether one is set. Device keys never reach the server.
 */
export function SalesEngineSettingsSection() {
  const { environment } = useSettingsScope();
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  if (!connected || environment.serverConfig?.environment.capabilities.sales !== true) {
    return null;
  }
  return (
    <>
      <SettingsSection {...searchableSetting("sales-engine")}>
        <SalesEngineForm
          // Drafts belong to one environment; switching must not carry them over.
          key={environment.environmentId}
          environmentId={environment.environmentId}
          providers={environment.serverConfig.providers}
        />
      </SettingsSection>
      <SalesDevicesSection environment={environment} />
    </>
  );
}

const NO_PROJECT = "__none__";

function TokenField(props: {
  readonly id: string;
  readonly label: string;
  readonly saved: boolean;
  readonly placeholder: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        type="password"
        autoComplete="off"
        size="sm"
        placeholder={
          props.saved ? "Stored secret, enter a new value to replace" : props.placeholder
        }
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  );
}

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

/**
 * Who runs Sales work. Left unset, the server starts Claude Code on its default model
 * (`defaultSalesRunModel`), so the picker shows that until another agent is chosen. Only providers
 * that can start a session are offered, by the rule the server checks at dispatch.
 */
function SalesRunAgentField(props: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly value: ModelSelection | null;
  readonly onChange: (value: ModelSelection | null) => void;
}) {
  const settings = useEnvironmentSettings(props.environmentId);
  const startable = props.providers.filter(canStartProviderSession);
  const selection = props.value ?? defaultSalesRunModel(startable);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(startable), settings),
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    startable,
    selection?.instanceId,
    selection?.model,
  );
  const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  const hint =
    props.value === null
      ? selection === null
        ? `${getDriverOption(CLAUDE_DRIVER)?.label ?? "Claude Code"} isn't set up on this environment.`
        : null
      : modelSelectionUnavailable(props.providers, props.value) !== null
        ? "The chosen agent isn't available on this environment."
        : null;
  // With nothing chosen and no Claude Code, the picker opens on the first agent that can start.
  const pickerInstanceId = selection?.instanceId ?? entries[0]?.instanceId;

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-1">
        <Label>Agent for Sales runs</Label>
        {props.value !== null ? (
          <SettingResetButton label="agent for Sales runs" onClick={() => props.onChange(null)} />
        ) : null}
      </div>
      {pickerInstanceId !== undefined ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <ProviderModelPicker
            activeInstanceId={pickerInstanceId}
            model={selection?.model ?? ""}
            lockedProvider={null}
            instanceEntries={entries}
            modelOptionsByInstance={modelOptions}
            triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
            triggerAriaLabel="Agent for Sales runs"
            {...(selection === null ? { triggerLabel: "Choose an agent" } : {})}
            onInstanceModelChange={(instanceId, model) =>
              props.onChange(createModelSelection(instanceId, model))
            }
          />
          {selection !== null && activeEntry !== undefined ? (
            <TraitsPicker
              provider={activeEntry.driverKind}
              models={activeEntry.models}
              model={selection.model}
              prompt=""
              onPromptChange={() => {}}
              modelOptions={selection.options ?? []}
              allowPromptInjectedEffort={false}
              planModeEnabled={settings.planModeEnabled}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              onModelOptionsChange={(options) =>
                props.onChange(createModelSelection(selection.instanceId, selection.model, options))
              }
            />
          ) : null}
        </div>
      ) : null}
      {hint !== null ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function SalesEngineForm({
  environmentId,
  providers,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.salesEngine);
  const allProjects = useProjects();
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save the sales engine",
  });
  const [baseUrlDraft, setBaseUrlDraft] = useState<string | null>(null);
  const [readToken, setReadToken] = useState("");
  const [actionToken, setActionToken] = useState("");
  const [saving, setSaving] = useState(false);
  const baseUrl = (baseUrlDraft ?? saved.baseUrl).trim();
  const newReadToken = readToken.trim();
  const newActionToken = actionToken.trim();
  const isSaved = saved.baseUrl.length > 0 || saved.readToken.length > 0;
  // The server clears saved tokens when the URL changes, so a new URL needs its own tokens.
  const urlChanged = baseUrl !== saved.baseUrl;
  const hasSavedTokens = saved.readToken.length > 0 || saved.actionToken.length > 0;
  const canSave =
    baseUrl.length > 0 &&
    (newReadToken.length > 0 || (saved.readToken.length > 0 && !urlChanged)) &&
    (urlChanged || newReadToken.length > 0 || newActionToken.length > 0);

  const save = async (patch: Partial<SalesEngineSettingsValue>) => {
    setSaving(true);
    try {
      const result = await updateSettings({
        environmentId,
        input: { patch: { salesEngine: patch } },
      });
      // Only a save of the engine fields consumes their drafts; picking a project or an agent
      // keeps whatever is still being typed.
      if (
        result._tag === "Success" &&
        ("baseUrl" in patch || "readToken" in patch || "actionToken" in patch)
      ) {
        setReadToken("");
        setActionToken("");
        setBaseUrlDraft(null);
      }
    } finally {
      setSaving(false);
    }
  };

  const selectedProject = projects.find((project) => project.id === saved.agentsProjectId);

  return (
    <form
      className="grid gap-4 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        // An omitted token keeps the saved one.
        if (canSave) {
          void save({
            baseUrl,
            ...(newReadToken ? { readToken: newReadToken } : {}),
            ...(newActionToken ? { actionToken: newActionToken } : {}),
          });
        }
      }}
    >
      {/* Locked while saving: a successful engine save clears the drafts. */}
      <fieldset disabled={saving} className="contents">
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          The server reads outreach status from this engine and shows it under Sales. Phoenix stores
          no sales data; the engine and Notion stay the record. The action token lets Phoenix hold,
          resume, edit and discard drafts, report LinkedIn tasks, and carry approvals signed on an
          enrolled device; by itself it approves nothing.
        </p>
        <div className="grid gap-1.5">
          <Label htmlFor={`sales-engine-url-${environmentId}`}>Engine URL</Label>
          <Input
            id={`sales-engine-url-${environmentId}`}
            type="url"
            autoComplete="off"
            size="sm"
            placeholder="https://engine.example.com"
            value={baseUrlDraft ?? saved.baseUrl}
            onChange={(event) => setBaseUrlDraft(event.target.value)}
          />
          {urlChanged && hasSavedTokens ? (
            <p className="text-xs text-muted-foreground">
              Changing the URL clears the saved tokens. Enter them again for the new engine.
            </p>
          ) : null}
        </div>
        <TokenField
          id={`sales-engine-token-${environmentId}`}
          label="Read token"
          saved={saved.readToken.length > 0}
          placeholder="The engine's SALES_READ_TOKEN"
          value={readToken}
          onChange={setReadToken}
        />
        <TokenField
          id={`sales-engine-action-token-${environmentId}`}
          label="Action token"
          saved={saved.actionToken.length > 0}
          placeholder="The engine's SALES_ACTION_TOKEN"
          value={actionToken}
          onChange={setActionToken}
        />
        <div className="grid gap-1.5">
          <Label>Sales agents project</Label>
          <Select
            value={selectedProject ? selectedProject.id : NO_PROJECT}
            onValueChange={(value) =>
              void save({ agentsProjectId: value === NO_PROJECT ? "" : String(value) })
            }
          >
            <SelectTrigger size="sm" aria-label="Sales agents project">
              <SelectValue>
                {selectedProject?.title ??
                  (saved.agentsProjectId ? "A project that is gone" : "None")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              <SelectItem value={NO_PROJECT}>None</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <p className="text-xs text-muted-foreground">
            Runs started from Sales open a thread in this project, the checkout that holds the sales
            workflows. They use the project&apos;s thread mode and permissions; the agent comes from
            Agent for Sales runs.
          </p>
        </div>
        <SalesRunAgentField
          environmentId={environmentId}
          providers={providers}
          value={saved.runModelSelection}
          onChange={(runModelSelection) => void save({ runModelSelection })}
        />
        <div className="flex justify-end gap-2">
          {isSaved ? (
            <Button
              size="xs"
              variant="outline"
              disabled={saving}
              onClick={() => void save({ baseUrl: "", readToken: "", actionToken: "" })}
            >
              Remove
            </Button>
          ) : null}
          <Button type="submit" size="xs" disabled={!canSave || saving}>
            Save
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

const DEVICE_STATE_VARIANT = {
  active: "success",
  pending: "warning",
  rejected: "error",
  revoked: "secondary",
} as const;

function defaultDeviceName() {
  const platform =
    typeof navigator === "undefined"
      ? ""
      : /Mac/u.test(navigator.userAgent)
        ? "Mac"
        : /Windows/u.test(navigator.userAgent)
          ? "Windows"
          : /Linux/u.test(navigator.userAgent)
            ? "Linux"
            : "";
  return `Phoenix ${isElectron ? "desktop" : "web"}${platform ? ` on ${platform}` : ""}`;
}

/** Enrol this device, see every device the engine knows, and revoke one. */
function SalesDevicesSection({ environment }: { readonly environment: EnvironmentPresentation }) {
  const environmentId = environment.environmentId;
  const salesEngine = environment.serverConfig?.settings.salesEngine;
  const canAct =
    (salesEngine?.actionToken.length ?? 0) > 0 && (salesEngine?.baseUrl.length ?? 0) > 0;
  const device = useSalesDevice(environmentId, salesEngine?.baseUrl ?? "", canAct);
  const enrolDevice = useAtomCommand(salesEnvironment.enrolDevice, { reportFailure: false });
  const revokeDevice = useAtomCommand(salesEnvironment.revokeDevice, { reportFailure: false });
  const [name, setName] = useState(defaultDeviceName);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ title: string; description: string } | null>(null);
  const blockedReason = useSalesDeviceGuard();
  const blocked = device.blocked;

  if (salesEngine === undefined || salesEngine.baseUrl.length === 0) return null;

  const enrol = async () => {
    // Checked again at the press: the client's environments may have changed since render.
    const blockedNow = blockedReason();
    if (blockedNow !== null) {
      setFailure({ title: "Enrol from another client", description: blockedNow });
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const { key, enrol: request } = await createDeviceKey({ engine: device.engine, name });
      const result = await enrolDevice({ environmentId, input: request });
      // Stored only once the engine has it, so a refused enrolment leaves nothing behind.
      if (result._tag === "Success") await salesDeviceKeyStore.save(key);
      else setFailure(readSalesFailure(result));
      await device.reload();
    } catch (error) {
      setFailure({
        title: "Could not make a device key",
        description: error instanceof Error ? error.message : "This browser refused.",
      });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (entry: SalesDevice) => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await revokeDevice({ environmentId, input: { deviceId: entry.deviceId } });
      if (result._tag === "Success" && entry.deviceId === device.key?.deviceId) {
        await salesDeviceKeyStore.remove(device.engine);
      }
      if (result._tag !== "Success") setFailure(readSalesFailure(result));
      await device.reload();
    } finally {
      setBusy(false);
    }
  };

  const mayEnrol =
    canAct &&
    blocked === null &&
    device.loaded &&
    (device.state === "none" ||
      device.state === "rejected" ||
      device.state === "revoked" ||
      device.state === "unknown");

  return (
    <SettingsSection {...searchableSetting("sales-devices")}>
      <div className="grid gap-4 p-4">
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Approving a draft in Phoenix is a press signed on an enrolled device. Enrolling makes a
          key that never leaves this device and sends the engine its public half. The engine posts a
          card to Slack; the device can approve once someone presses Approve device there, after
          checking the fingerprint matches the one shown here.
        </p>
        {!canAct ? (
          <p className="text-xs text-muted-foreground">
            Add the action token above to enrol devices.
          </p>
        ) : (
          <>
            <div className="grid gap-1">
              <p className="text-sm font-medium">This device</p>
              <p className="text-xs text-muted-foreground">
                {thisDeviceDescription(device.state, device.key)}
              </p>
              {device.key && device.state !== "active" && device.state !== "none" ? (
                <p className="font-mono text-lg tracking-wider" aria-label="Fingerprint">
                  {shortFingerprint(device.key.fingerprint)}
                </p>
              ) : null}
            </div>
            {blocked !== null ? (
              <Alert variant="warning">
                <AlertTitle>Enrol from another client</AlertTitle>
                <AlertDescription>{blocked}</AlertDescription>
              </Alert>
            ) : mayEnrol ? (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void enrol();
                }}
              >
                <div className="grid min-w-56 flex-1 gap-1.5">
                  <Label htmlFor={`sales-device-name-${environmentId}`}>Device name</Label>
                  <Input
                    id={`sales-device-name-${environmentId}`}
                    size="sm"
                    maxLength={80}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
                <Button type="submit" size="xs" disabled={busy || name.trim().length === 0}>
                  {busy ? "Enrolling…" : "Enrol this device"}
                </Button>
              </form>
            ) : null}
            {failure ? (
              <Alert variant="error">
                <AlertTitle>{failure.title}</AlertTitle>
                <AlertDescription>{failure.description}</AlertDescription>
              </Alert>
            ) : null}
            {device.error ? (
              <p className="text-xs text-destructive-foreground">{device.error}</p>
            ) : null}
            <ul aria-label="Enrolled devices" className="divide-y rounded-lg border">
              {(device.devices ?? []).length === 0 ? (
                <li className="px-3 py-2 text-xs text-muted-foreground">No devices yet.</li>
              ) : null}
              {(device.devices ?? []).map((entry) => (
                <li
                  key={entry.deviceId}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2"
                >
                  <div className="min-w-40 flex-1">
                    <p className="text-sm">
                      {entry.name}
                      {entry.deviceId === device.key?.deviceId ? (
                        <span className="text-muted-foreground"> · this device</span>
                      ) : null}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {entry.deviceId} · {entry.fingerprintShort}
                    </p>
                  </div>
                  <Badge
                    variant={
                      DEVICE_STATE_VARIANT[entry.state as keyof typeof DEVICE_STATE_VARIANT] ??
                      "outline"
                    }
                  >
                    {entry.state}
                  </Badge>
                  {entry.state === "active" || entry.state === "pending" ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void revoke(entry)}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </SettingsSection>
  );
}
