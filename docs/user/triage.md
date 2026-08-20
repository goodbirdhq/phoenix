# Triage a Broken Install

When Phoenix itself misbehaves — crashes, auth failures, broken setups, slow launches — `phoenix
triage` hands the problem to your own coding agent. It gathers machine facts (installed version,
OS, whether the server is running, where its logs and database live), then starts Claude Code or
Codex interactively with a triage playbook. The agent asks you what went wrong, investigates on
your machine, and helps you file a well-evidenced GitHub issue when one is warranted.

```sh
phoenix triage
```

If both Claude Code and Codex are installed, Phoenix asks which to use; pick one directly with
`--agent claude` or `--agent codex`, and pass a specific model with `--model`. With no supported
agent CLI installed, the prompt and context files are written to disk instead, ready to paste into
whatever agent you do have.

A few things to know:

- The agent runs as a normal interactive session. Its own permission prompts gate everything it
  wants to read or run, and it asks before posting anything to GitHub.
- It never reads your secrets directory, and the playbook tells it to redact API keys, tokens, and
  home-directory paths from anything it quotes in an issue.
- Fixes are offered, not applied: the agent proposes exact commands and runs them only with your
  approval.
- Issues filed this way use the Triage report template and are labeled `via-triage`, so
  hand-written reports stay distinct.
