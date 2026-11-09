import type {
  EnvironmentId,
  SalesEngineSettings as SalesEngineSettingsValue,
} from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

/**
 * The sales engine this environment's server reads for the Sales area. The token is
 * write-only: the server keeps it in its secret store and only reports whether one is set.
 */
export function SalesEngineSettingsSection() {
  const { environment } = useSettingsScope();
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  if (!connected || environment.serverConfig?.environment.capabilities.sales !== true) {
    return null;
  }
  return (
    <SettingsSection {...searchableSetting("sales-engine")}>
      <SalesEngineForm
        // Drafts belong to one environment; switching must not carry them over.
        key={environment.environmentId}
        environmentId={environment.environmentId}
      />
    </SettingsSection>
  );
}

function SalesEngineForm({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.salesEngine);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save the sales engine",
  });
  const [baseUrlDraft, setBaseUrlDraft] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const baseUrl = (baseUrlDraft ?? saved.baseUrl).trim();
  const newToken = token.trim();
  const isSaved = saved.baseUrl.length > 0 || saved.readToken.length > 0;
  const canSave =
    baseUrl.length > 0 &&
    (newToken.length > 0 || saved.readToken.length > 0) &&
    (baseUrl !== saved.baseUrl || newToken.length > 0);

  const save = async (patch: Partial<SalesEngineSettingsValue>) => {
    setSaving(true);
    try {
      const result = await updateSettings({
        environmentId,
        input: { patch: { salesEngine: patch } },
      });
      if (result._tag === "Success") {
        setToken("");
        setBaseUrlDraft(null);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="grid gap-4 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        // An omitted token keeps the saved one.
        if (canSave) void save(newToken ? { baseUrl, readToken: newToken } : { baseUrl });
      }}
    >
      {/* Locked while saving: a successful save clears the drafts. */}
      <fieldset disabled={saving} className="contents">
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          The server reads outreach status from this engine and shows it under Sales. Phoenix stores
          no sales data; the engine and Notion stay the record.
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
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`sales-engine-token-${environmentId}`}>Read token</Label>
          <Input
            id={`sales-engine-token-${environmentId}`}
            type="password"
            autoComplete="off"
            size="sm"
            placeholder={
              saved.readToken.length > 0
                ? "Stored secret, enter a new value to replace"
                : "The engine's SALES_READ_TOKEN"
            }
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2">
          {isSaved ? (
            <Button
              size="xs"
              variant="outline"
              disabled={saving}
              onClick={() => void save({ baseUrl: "", readToken: "" })}
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
