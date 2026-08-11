import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";

const trimNonEmptyOption = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

const trimmedString = (name: string) =>
  Config.string(name).pipe(Config.option, Config.map(Option.flatMap(trimNonEmptyOption)));

const commaSeparatedStrings = (name: string) =>
  trimmedString(name).pipe(
    Config.map(
      Option.match({
        onNone: () => [],
        onSome: (value) =>
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
      }),
    ),
  );

/**
 * Phoenix reads its own `PHOENIX_*` variable first and falls back to the upstream
 * `T3CODE_*` name, so existing setups keep working without configuration changes.
 *
 * `PHOENIX_HOME` deliberately does NOT use this helper — see `t3Home` below.
 */
const brandedString = (suffix: string) =>
  Config.all([trimmedString(`PHOENIX_${suffix}`), trimmedString(`T3CODE_${suffix}`)]).pipe(
    Config.map(([phoenix, upstream]) => Option.orElse(phoenix, () => upstream)),
  );

const brandedBoolean = (suffix: string) =>
  Config.all([
    Config.boolean(`PHOENIX_${suffix}`).pipe(Config.option),
    Config.boolean(`T3CODE_${suffix}`).pipe(Config.option),
  ]).pipe(
    Config.map(([phoenix, upstream]) =>
      Option.getOrElse(
        Option.orElse(phoenix, () => upstream),
        () => false,
      ),
    ),
  );

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const DesktopConfig = Config.all({
  appDataDirectory: trimmedString("APPDATA"),
  xdgConfigHome: trimmedString("XDG_CONFIG_HOME"),
  xdgDataHome: trimmedString("XDG_DATA_HOME"),
  // No T3CODE_HOME fallback on purpose. Every other variable is safe to share with
  // upstream, but the base dir holds the SQLite database and auth state: inheriting
  // a T3CODE_HOME set for T3 Code would put both apps in one directory, which is the
  // exact collision Phoenix's separate identity exists to prevent.
  t3Home: trimmedString("PHOENIX_HOME"),
  devServerUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option),
  appUserModelIdOverride: brandedString("DESKTOP_APP_USER_MODEL_ID"),
  devRemoteT3ServerEntryPath: brandedString("DEV_REMOTE_T3_SERVER_ENTRY_PATH"),
  configuredBackendPort: Config.all([
    Config.port("PHOENIX_PORT").pipe(Config.option),
    Config.port("T3CODE_PORT").pipe(Config.option),
  ]).pipe(Config.map(([phoenix, upstream]) => Option.orElse(phoenix, () => upstream))),
  commitHashOverride: brandedString("COMMIT_HASH"),
  desktopLanHostOverride: brandedString("DESKTOP_LAN_HOST"),
  desktopHttpsEndpointUrls: commaSeparatedStrings("T3CODE_DESKTOP_HTTPS_ENDPOINTS"),
  otlpTracesUrl: brandedString("OTLP_TRACES_URL"),
  otlpExportIntervalMs: Config.int("T3CODE_OTLP_EXPORT_INTERVAL_MS").pipe(
    Config.withDefault(10_000),
  ),
  appImagePath: trimmedString("APPIMAGE"),
  disableAutoUpdate: brandedBoolean("DISABLE_AUTO_UPDATE"),
  mockUpdates: brandedBoolean("DESKTOP_MOCK_UPDATES"),
  mockUpdateServerPort: Config.port("T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(
    Config.withDefault(3000),
  ),
});

export const layerTest = (env: Readonly<Record<string, string | undefined>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }));
