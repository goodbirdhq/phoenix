# Product usage data

Phoenix does not collect product usage data by default.

If you run your own PostHog project, you can have the Phoenix server send it product usage events
by setting `T3CODE_POSTHOG_KEY` (and `T3CODE_POSTHOG_HOST` if you don't use PostHog's US cloud) in
the server's environment before starting it. Events are associated with a hashed account or
installation identifier and include the provider, model, reasoning effort, permission mode, turn
result, duration, release channel, and main-agent token totals when available.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

To stop collection, remove the key or set `T3CODE_TELEMETRY_ENABLED=false`, then restart the
server. The desktop app reads these variables from your shell profile (for example `~/.zshrc`) on
macOS and Linux. On Windows, set them as user environment variables.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > General > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
