import {
  CommandId,
  MessageId,
  ProjectId,
  type ModelSelection,
  type SalesActionError,
  type SalesContactRef,
  type SalesDispatch,
  type SalesDispatchInput,
  ThreadId,
  canStartProviderSession,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadTurnBootstrap from "../orchestration/ThreadTurnBootstrap.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { phoenixCheckFailure, salesActionError } from "./SalesEngineApi.ts";
import * as SalesService from "./SalesService.ts";

/**
 * "Research this" and "Redraft with notes": start an ordinary thread in the sales agents
 * project (the checkout that holds the sales workflows) that runs one workflow against one
 * target. The prompt is the agents repo's dispatch contract (its README, "Dispatching a
 * skill"); the workflow itself decides what to write. Nothing dispatched can approve: the
 * drafts it writes wait for a press like any other.
 */

/** Which workflow a dispatch runs, and the target it hands it. */
export interface SalesDispatchPlan {
  readonly skill: string;
  /** `Account:` / `Contact:` lines, in order. */
  readonly targetLines: ReadonlyArray<string>;
  /** What the user typed. Empty means no note. */
  readonly note: string;
}

/**
 * The dispatch prompt, word for word as the agents repo's README gives it, with the key, the
 * target lines and the note filled in. The note and the line above it are left out when empty.
 *
 * `Note from Gabriel:` is a literal the birdhouse workflows key on to find the person's note,
 * so it must match the README's template exactly; change both together. Target lines carry
 * card text (names from the CRM, which agents write), so `planDispatch` reduces every such
 * value to one line before it gets here: no card can add a line, a fake note included.
 */
export function buildDispatchPrompt(plan: SalesDispatchPlan): string {
  const note = plan.note.trim();
  return [
    `Read \`.claude/skills/${plan.skill}/SKILL.md\` in this repo and follow it. Your`,
    "working directory is the birdhouse checkout.",
    "",
    "Gabriel dispatched this run from Phoenix against one target. Take the",
    "workflow's path for a run handed a target, and work this target only:",
    "",
    ...plan.targetLines,
    ...(note.length > 0 ? ["Note from Gabriel:", note] : []),
    "",
    "End with a short report. Your final message is the run's report, so put in",
    "it what the workflow's report section asks for. Nobody will read the",
    "transcript.",
    "",
    "If the skill file, or the workflow file it names, does not exist, stop and",
    "say so. Never improvise the task: a missing file means the workflow was",
    "retired.",
  ].join("\n");
}

/**
 * A target value on one line. Names come from the CRM, which agents write, so a line break in
 * one must not be able to add a line of its own to the prompt.
 */
const oneLine = (value: string) => value.replace(/\s+/gu, " ").trim().slice(0, 200);

/** Only a Notion page URL is a page target; anything else the engine sent is not trusted. */
export function notionPageUrl(value: string | null): string | null {
  if (value === null || !URL.canParse(value)) return null;
  const url = new URL(value);
  const notion = url.hostname === "www.notion.so" || url.hostname === "notion.so";
  return url.protocol === "https:" && notion && !/\s/u.test(value) ? url.toString() : null;
}

const noTarget = (message: string) => salesActionError("no-target", { message });

const contactLine = (contact: SalesContactRef) => {
  const url = notionPageUrl(contact.notionUrl);
  return url === null ? null : `Contact: ${url}`;
};

/**
 * The workflow for redrafting a card of this kind. A reply is drafted again after a discard,
 * since the reply drafter cannot edit a row; the others rewrite the waiting draft in place.
 */
function redraftSkill(
  kind: string | null,
): "outreach-drafting" | "follow-up-drafting" | "reply-drafting" | null {
  switch (kind) {
    case "first":
      return "outreach-drafting";
    case "chase":
    case "revisit":
      return "follow-up-drafting";
    case "reply":
      return "reply-drafting";
    default:
      return null;
  }
}

/** A card dispatch can act on: `research` and `redraft` take one. */
interface DispatchCard {
  readonly kind: string | null;
  readonly state: string;
  readonly approved: boolean;
  readonly contact: SalesContactRef;
  readonly rowName: string;
  readonly contentHash: string;
}

/** The plan for a dispatch, or why it cannot run. Pure, so the tests can pin every case. */
export function planDispatch(
  input: SalesDispatchInput,
  target: DispatchCard | { readonly contact: SalesContactRef },
): { readonly plan: SalesDispatchPlan; readonly title: string } | SalesActionError {
  const contact = target.contact;
  const who = oneLine(contact.name ?? contact.email ?? "contact");
  switch (input.action) {
    case "research": {
      const account = contact.accountName === null ? "" : oneLine(contact.accountName);
      if (account.length === 0) {
        return noTarget(
          "The engine names no account for this draft, so there is nothing to research.",
        );
      }
      const candidate = contactLine(contact);
      return {
        plan: {
          skill: "prospect-research",
          // The engine has no Account page id, so the account goes by name, which the
          // workflow accepts; the contact rides along as the candidate.
          targetLines: [`Account: ${account}`, ...(candidate === null ? [] : [candidate])],
          note: "",
        },
        title: `Research ${account}`,
      };
    }
    case "redraft": {
      if (!("kind" in target)) return noTarget("Redraft needs a draft.");
      const skill = redraftSkill(target.kind);
      if (skill === null) {
        return noTarget(
          `Phoenix does not know which workflow writes "${oneLine(target.rowName)}".`,
        );
      }
      // The redraft rewrites what the person saw; a card that moved on since is shown again.
      if (input.expectedHash.toLowerCase() !== target.contentHash.toLowerCase()) {
        return phoenixCheckFailure("stale_hash", { currentHash: target.contentHash });
      }
      if (target.approved) {
        return salesActionError("dispatch-failed", {
          message: "Unapprove it first: a workflow never rewrites an approved draft.",
        });
      }
      const line = contactLine(contact);
      if (line === null) return noTarget("The engine has no Notion page for this contact.");
      if (input.note.trim().length === 0) {
        return phoenixCheckFailure("bad_request", {
          message: "Say what the new draft should do.",
        });
      }
      return {
        plan: { skill, targetLines: [line], note: input.note },
        title: `Redraft for ${who}`,
      };
    }
    case "draft-reply": {
      const line = contactLine(contact);
      if (line === null) return noTarget("The engine has no Notion page for this contact.");
      return {
        plan: { skill: "reply-drafting", targetLines: [line], note: input.note },
        title: `Draft a reply to ${who}`,
      };
    }
  }
}

const OPEN_STATES = new Set(["awaiting", "approved", "held", "refused"]);

export class SalesDispatchService extends Context.Service<
  SalesDispatchService,
  {
    readonly dispatch: (
      input: SalesDispatchInput,
    ) => Effect.Effect<SalesDispatch, SalesActionError>;
  }
>()("t3/sales/SalesDispatch/SalesDispatchService") {}

const make = Effect.gen(function* () {
  const sales = yield* SalesService.SalesService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const bootstrap = yield* ThreadTurnBootstrap.ThreadTurnBootstrap;
  const projectFiles = yield* T3ProjectFileLoader.T3ProjectFileLoader;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const crypto = yield* Crypto.Crypto;

  const failed = (message: string) => () => salesActionError("dispatch-failed", { message });
  const randomUUID = crypto.randomUUIDv4.pipe(Effect.mapError(failed("Could not start a thread.")));

  /** The agents project and how a new thread there starts, by that project's own defaults. */
  const resolveProject = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(failed("Could not read the server settings.")),
    );
    const projectIdText = settings.salesEngine.agentsProjectId;
    if (projectIdText.length === 0) {
      return yield* salesActionError("no-agents-project", {
        message: "Choose the sales agents project in Settings › Integrations first.",
      });
    }
    const projectId = ProjectId.make(projectIdText);
    const project = yield* projection
      .getProjectShellById(projectId)
      .pipe(Effect.mapError(failed("Could not read the sales agents project.")));
    if (Option.isNone(project)) {
      return yield* salesActionError("agents-project-missing", {
        message: "The sales agents project chosen in Settings no longer exists here.",
      });
    }
    const projectFile = yield* projectFiles.load(project.value.workspaceRoot);
    const resolved = resolveProjectSettings(
      settings,
      projectId,
      project.value,
      Option.getOrNull(projectFile),
    ).settings;
    const fallback = (yield* providers.getProviders).find(canStartProviderSession);
    const fallbackModel =
      fallback?.models.find((model) => model.isDefault === true)?.slug ?? fallback?.models[0]?.slug;
    const modelSelection: ModelSelection | null =
      resolved.defaultModelSelection ??
      (fallback !== undefined && fallbackModel !== undefined
        ? { instanceId: fallback.instanceId, model: fallbackModel }
        : null);
    if (modelSelection === null) {
      return yield* salesActionError("dispatch-failed", {
        message: "No provider is available to run the workflow.",
      });
    }
    const status =
      resolved.defaultThreadEnvMode === "worktree"
        ? yield* gitWorkflow
            .localStatus({ cwd: project.value.workspaceRoot })
            .pipe(Effect.orElseSucceed(() => null))
        : null;
    const baseBranch = status?.isRepo === true ? (status.refName ?? null) : null;
    return {
      projectId,
      workspaceRoot: project.value.workspaceRoot,
      modelSelection,
      runtimeMode: resolved.defaultRuntimeMode,
      baseBranch,
      startFromOrigin: resolved.newWorktreesStartFromOrigin,
    };
  });

  const startThread = Effect.fn("SalesDispatch.startThread")(function* (
    project: Effect.Success<typeof resolveProject>,
    input: { readonly prompt: string; readonly title: string },
  ) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const threadId = ThreadId.make(yield* randomUUID);
    const messageId = MessageId.make(yield* randomUUID);
    const commandId = CommandId.make(`server:sales-dispatch:${yield* randomUUID}`);
    const branchToken = (yield* randomUUID).replace(/-/gu, "");
    yield* bootstrap
      .bootstrapTurnStart({
        type: "thread.turn.start",
        commandId,
        threadId,
        message: { messageId, role: "user", text: input.prompt, attachments: [] },
        modelSelection: project.modelSelection,
        runtimeMode: project.runtimeMode,
        interactionMode: "default",
        titleSeed: input.title,
        bootstrap: {
          createThread: {
            projectId: project.projectId,
            title: input.title,
            modelSelection: project.modelSelection,
            runtimeMode: project.runtimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            spawnedByThreadId: null,
            reportDelivery: null,
            createdAt,
          },
          ...(project.baseBranch === null
            ? {}
            : {
                prepareWorktree: {
                  projectCwd: project.workspaceRoot,
                  baseBranch: project.baseBranch,
                  branch: buildTemporaryWorktreeBranchName(() => branchToken),
                  startFromOrigin: project.startFromOrigin,
                },
                runSetupScript: true,
              }),
        },
        createdAt,
      })
      .pipe(
        Effect.mapError((error) => salesActionError("dispatch-failed", { message: error.message })),
      );
    return { threadId, createdAt };
  });

  const dispatch = Effect.fn("SalesDispatch.dispatch")(function* (input: SalesDispatchInput) {
    // Settle where the thread will run before touching the engine, so a reply redraft never
    // discards a draft and then fails to start the run that replaces it.
    const project = yield* resolveProject;
    const target =
      input.action === "draft-reply"
        ? yield* sales.getConversation(input.contactKey)
        : yield* sales.getQueueItem(input.activityId).pipe(
            Effect.map((item) => ({
              kind: item.kind,
              state: item.state,
              approved: item.approval !== null,
              contact: item.contact,
              rowName: item.rowName,
              contentHash: item.contentHash,
            })),
          );
    if ("state" in target && !OPEN_STATES.has(target.state)) {
      return yield* phoenixCheckFailure("not_open", {
        message: "This draft is no longer open.",
        state: target.state,
      });
    }
    const planned = planDispatch(input, target);
    if ("_tag" in planned) return yield* planned;

    // A reply is drafted again rather than rewritten, so its waiting answer goes first, for the
    // version the user saw; a newer one stops here. The bootstrap creates the thread and starts
    // its turn in one step, so the start can still fail after the discard. That error says the
    // answer is gone, and its `state` lets the client offer Draft an answer.
    const discardsFirst = input.action === "redraft" && planned.plan.skill === "reply-drafting";
    if (discardsFirst) {
      yield* sales.discard({ activityId: input.activityId, expectedHash: input.expectedHash });
    }
    const started = yield* startThread(project, {
      prompt: buildDispatchPrompt(planned.plan),
      title: planned.title,
    }).pipe(
      Effect.mapError((error) =>
        discardsFirst
          ? salesActionError("dispatch-failed", {
              message: `The waiting answer was discarded, but the run that drafts a new one did not start (${error.message}). Choose Draft an answer in Conversations to start it again.`,
              state: "discarded",
            })
          : error,
      ),
    );
    const record: SalesDispatch = {
      target: input.action === "draft-reply" ? input.contactKey : input.activityId,
      action: input.action,
      skill: planned.plan.skill,
      threadId: started.threadId,
      projectId: project.projectId,
      title: planned.title,
      startedAt: started.createdAt,
    };
    yield* sales.recordDispatch(record);
    return record;
  });

  return SalesDispatchService.of({ dispatch });
});

export const layer = Layer.effect(SalesDispatchService, make);
