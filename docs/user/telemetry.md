# Product usage data

Phoenix does not collect product usage data by default.

If you run your own PostHog project, you can have the Phoenix server send it product usage events
by setting `T3CODE_POSTHOG_KEY` (and `T3CODE_POSTHOG_HOST` if you don't use PostHog's US cloud) in
the server's environment before starting it. Events are associated with a hashed account or
installation identifier and include the provider, model, reasoning effort, permission mode, turn
result, duration, and main-agent token totals when available.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

To stop collection, remove the key or set `T3CODE_TELEMETRY_ENABLED=false`.
