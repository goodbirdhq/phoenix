import type { UsageProviderKind } from "@t3tools/contracts";

import { ClaudeAI, GrokIcon, type Icon, OpenAI } from "../Icons";

import { OpenCodeUsageMark } from "./UsageProviderMarks";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly mark: Icon;
};

/** Exhaustive presentation for providers supported by the usage contract. */
export const PROVIDER_PRESENTATION = {
  codex: {
    label: "Codex",
    color: "var(--contrast-foreground)",
    mark: OpenAI,
  },
  claude: {
    label: "Claude Code",
    color: "#d97757",
    mark: ClaudeAI,
  },
  grok: {
    label: "Grok Build",
    // Contrast-aware neutral between the Codex series and muted chart chrome.
    color: "color-mix(in oklab, var(--contrast-foreground) 72%, var(--background))",
    mark: GrokIcon,
  },
  opencode: {
    label: "OpenCode",
    color: "#6366f1",
    mark: OpenCodeUsageMark,
  },
} satisfies Record<UsageProviderKind, UsageProviderPresentation>;
