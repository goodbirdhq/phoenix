import {
  DEFAULT_ENVIRONMENT_EDITOR_HANDOFF,
  EDITORS,
  EditorId,
  EnvironmentId,
  type EnvironmentEditorHandoff,
} from "@t3tools/contracts";
import {
  mapAtomCommandResult,
  type AtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";
import { useCallback, useMemo } from "react";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { useClientSettings } from "./hooks/useSettings";
import {
  buildRemoteEditorTarget,
  launchRemoteEditor,
  type RemoteEditorTarget,
} from "./remoteEditorHandoff";

const LAST_EDITOR_KEY = "t3code:last-editor";

export class PreferredEditorEnvironmentRequiredError extends Schema.TaggedErrorClass<PreferredEditorEnvironmentRequiredError>()(
  "PreferredEditorEnvironmentRequiredError",
  {
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot open ${this.targetPath} because no environment is selected.`;
  }
}

export class PreferredEditorUnavailableError extends Schema.TaggedErrorClass<PreferredEditorUnavailableError>()(
  "PreferredEditorUnavailableError",
  {
    environmentId: EnvironmentId,
    targetPath: Schema.String,
    availableEditorIds: Schema.Array(EditorId),
  },
) {
  override get message(): string {
    return `No available editor can open ${this.targetPath} in environment ${this.environmentId}.`;
  }
}

export class RemoteEditorHandoffUnavailableError extends Schema.TaggedErrorClass<RemoteEditorHandoffUnavailableError>()(
  "RemoteEditorHandoffUnavailableError",
  { targetPath: Schema.String },
) {
  override get message(): string {
    return `Cannot open ${this.targetPath} in local VS Code because it is outside the configured workspace or Remote-SSH is incomplete.`;
  }
}

export interface EditorOpenTarget {
  readonly workspaceRelativePath?: string | null | undefined;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
}

export function resolveEditorOpenPlan(
  handoff: EnvironmentEditorHandoff,
  target: EditorOpenTarget,
):
  | { readonly kind: "environment" }
  | { readonly kind: "remote"; readonly target: RemoteEditorTarget }
  | { readonly kind: "unavailable" } {
  if (handoff.mode === "local-server-editor") return { kind: "environment" };
  if (handoff.mode === "disabled") return { kind: "unavailable" };
  const remoteTarget = buildRemoteEditorTarget({ handoff, ...target });
  return remoteTarget ? { kind: "remote", target: remoteTarget } : { kind: "unavailable" };
}

export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastEditor, setLastEditor] = useLocalStorage(LAST_EDITOR_KEY, null, EditorId);

  const effectiveEditor = useMemo(() => {
    if (lastEditor && availableEditors.includes(lastEditor)) return lastEditor;
    return EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null;
  }, [lastEditor, availableEditors]);

  return [effectiveEditor, setLastEditor] as const;
}

export function resolveAndPersistPreferredEditor(
  availableEditors: readonly EditorId[],
): EditorId | null {
  const availableEditorIds = new Set(availableEditors);
  const stored = getLocalStorageItem(LAST_EDITOR_KEY, EditorId);
  if (stored && availableEditorIds.has(stored)) return stored;
  const editor = EDITORS.find((editor) => availableEditorIds.has(editor.id))?.id ?? null;
  if (editor) setLocalStorageItem(LAST_EDITOR_KEY, editor, EditorId);
  return editor ?? null;
}

export function useOpenInPreferredEditor(
  environmentId: EnvironmentId | null,
  availableEditors: readonly EditorId[],
) {
  const environmentEditorHandoffs = useClientSettings(
    (settings) => settings.environmentEditorHandoffs,
  );
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  type OpenInEditorError = AtomCommandFailure<Awaited<ReturnType<typeof openInEditor>>>;

  return useCallback(
    async (
      targetPath: string,
      target: EditorOpenTarget = {},
    ): Promise<
      AtomCommandResult<
        EditorId,
        | OpenInEditorError
        | PreferredEditorEnvironmentRequiredError
        | PreferredEditorUnavailableError
        | RemoteEditorHandoffUnavailableError
      >
    > => {
      if (environmentId === null) {
        return AsyncResult.failure(
          Cause.fail(
            new PreferredEditorEnvironmentRequiredError({
              targetPath,
            }),
          ),
        );
      }
      const handoff =
        environmentEditorHandoffs[environmentId] ?? DEFAULT_ENVIRONMENT_EDITOR_HANDOFF;
      const plan = resolveEditorOpenPlan(handoff, target);
      if (plan.kind === "remote") {
        if (!(await launchRemoteEditor(plan.target))) {
          return AsyncResult.failure(
            Cause.fail(new RemoteEditorHandoffUnavailableError({ targetPath })),
          );
        }
        // The handoff is entirely client-local. Do not send shell.openInEditor to the environment.
        return AsyncResult.success(EditorId.make("vscode"));
      }
      if (plan.kind === "unavailable") {
        return AsyncResult.failure(
          Cause.fail(new RemoteEditorHandoffUnavailableError({ targetPath })),
        );
      }
      const editor = resolveAndPersistPreferredEditor(availableEditors);
      if (!editor) {
        return AsyncResult.failure(
          Cause.fail(
            new PreferredEditorUnavailableError({
              environmentId,
              targetPath,
              availableEditorIds: availableEditors,
            }),
          ),
        );
      }
      const result = await openInEditor({
        environmentId,
        input: {
          cwd: targetPath,
          editor,
        },
      });
      return mapAtomCommandResult(result, () => editor);
    },
    [availableEditors, environmentEditorHandoffs, environmentId, openInEditor],
  );
}
