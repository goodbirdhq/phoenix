import {
  CommandId,
  MessageId,
  ProjectId,
  type ModelSelection,
  type SalesActionError,
  type SalesDispatch,
  type SalesDispatchAction,
  type SalesDispatchInput,
  type SalesDispatchPlans,
  ThreadId,
  canStartProviderSession,
  fillSalesNote,
  safeSalesNote,
  salesDispatchThreadPrefix,
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
 * Starts the threads the sales engine offers from a card or a conversation. The engine builds
 * each one whole (docs/internals/birdhouse.md, "Dispatch"): which workflow runs, its target and
 * the prompt's wording are its, and this only fills in the person's note. The thread runs in the
 * configured agents project, and its id carries the card or conversation it came from
 * (`salesDispatchThreadPrefix`), so the read model remembers the link. Nothing dispatched can
 * approve: what a workflow writes waits for a press like any other.
 */

/**
 * The plan to run, read again just before it runs, or why it may not: it is no longer offered,
 * its card moved on from the version the person saw, or it needs a note and has none.
 */
export function checkPlan(
  input: SalesDispatchInput,
  plans: SalesDispatchPlans,
): { readonly plan: SalesDispatchAction; readonly prompt: string } | SalesActionError {
  const plan = plans[input.action];
  if (plan === null) {
    return salesActionError("no-target", {
      message: "The engine no longer offers this here. It has been read again.",
    });
  }
  if (
    plan.card !== null &&
    plan.card.expectedHash.toLowerCase() !== input.expectedHash?.toLowerCase()
  ) {
    return phoenixCheckFailure("stale_hash", { currentHash: plan.card.expectedHash });
  }
  if (plan.noteRequired && safeSalesNote(input.note).length === 0) {
    return phoenixCheckFailure("bad_request", { message: "This needs a note." });
  }
  const prompt = fillSalesNote(plan.prompt, input.note);
  if (prompt === null) {
    return salesActionError("dispatch-failed", {
      message: "The engine sent a prompt Phoenix cannot fill in.",
    });
  }
  return { plan, prompt };
}

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

  const failed = (message: string) => () =>
    salesActionError("dispatch-failed", { message });
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
    input: { readonly threadId: ThreadId; readonly prompt: string; readonly title: string },
  ) {
    const { threadId } = input;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
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
        Effect.mapError((error) =>
          salesActionError("dispatch-failed", { message: error.message }),
        ),
      );
  });

  const dispatch = Effect.fn("SalesDispatch.dispatch")(function* (input: SalesDispatchInput) {
    // Settle where the thread will run before touching the engine, so a plan that discards
    // first never discards and then fails to find a project for the run that replaces it.
    const project = yield* resolveProject;
    const plans =
      "activityId" in input
        ? (yield* sales.getQueueItem(input.activityId)).dispatch
        : (yield* sales.getConversation(input.contactKey)).dispatch;
    const checked = checkPlan(input, plans);
    if ("_tag" in checked) return yield* checked;
    const { plan, prompt } = checked;
    yield* Effect.annotateCurrentSpan({ skill: plan.skill });

    // The bootstrap creates the thread and starts its turn in one step, so the start can still
    // fail after the discard. That error says the card is gone, and its `state` lets the client
    // send the person to the conversation to start again.
    const discarded = plan.discardFirst && plan.card !== null;
    if (discarded) yield* sales.discard(plan.card);
    const threadId = ThreadId.make(`${salesDispatchThreadPrefix(input)}${yield* randomUUID}`);
    yield* startThread(project, { threadId, prompt, title: plan.title }).pipe(
      Effect.mapError((error) =>
        discarded
          ? salesActionError("dispatch-failed", {
              message: `The draft was discarded, but the run that replaces it did not start (${error.message}). Start it again from the conversation.`,
              state: "discarded",
            })
          : error,
      ),
    );
    return { threadId, title: plan.title } satisfies SalesDispatch;
  });

  return SalesDispatchService.of({ dispatch });
});

export const layer = Layer.effect(SalesDispatchService, make);
