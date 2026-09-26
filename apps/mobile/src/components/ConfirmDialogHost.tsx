import { useEffect, useRef, useState, type RefObject } from "react";
import { Pressable, TextInput, type View } from "react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import IconTrash from "@tabler/icons-react-native/IconTrash";
import IconInfoCircle from "@tabler/icons-react-native/IconInfoCircle";
import IconEdit from "@tabler/icons-react-native/IconEdit";
import { AppText } from "./AppText";
import { ModalSlideUp } from "./ModalSlideUp";
import { ThreadAvatar, threadIdentityLabel } from "./ThreadAvatar";
import { useNavigationColors } from "./useNavigationColors";
import { useProject, useEnvironmentServerConfig } from "../state/entities";

export type ConfirmDialogRequest = {
  readonly title: string;
  readonly message?: string;
  readonly cancelText?: string;
  readonly confirmText: string;
  readonly destructive?: boolean;
  readonly thread?: EnvironmentThreadShell;
  readonly returnFocusRef?: RefObject<View | null>;
  readonly onConfirm: () => void | Promise<boolean>;
  readonly onCancel?: () => void;
};

export type TextInputDialogRequest = {
  readonly title: string;
  readonly initialValue: string;
  readonly cancelText?: string;
  readonly confirmText: string;
  readonly returnFocusRef?: RefObject<View | null>;
  readonly onConfirm: (value: string) => void | Promise<boolean>;
  readonly onCancel?: () => void;
};

type DialogRequest =
  | { readonly kind: "confirm"; readonly request: ConfirmDialogRequest }
  | { readonly kind: "text-input"; readonly request: TextInputDialogRequest };

let presentRequest: ((request: DialogRequest) => void) | null = null;

export function showConfirmDialog(request: ConfirmDialogRequest): void {
  presentRequest?.({ kind: "confirm", request });
}

export function showTextInputDialog(request: TextInputDialogRequest): void {
  presentRequest?.({ kind: "text-input", request });
}

export function ConfirmDialogHost() {
  const [presented, setPresented] = useState<DialogRequest | null>(null);
  useEffect(() => {
    presentRequest = setPresented;
    return () => {
      presentRequest = null;
    };
  }, []);
  return presented ? (
    <Confirmation
      key={
        presented.kind === "confirm" && presented.request.thread
          ? `${presented.request.thread.environmentId}:${presented.request.thread.id}`
          : presented.request.title
      }
      presented={presented}
      onClose={() => setPresented(null)}
    />
  ) : null;
}

function Confirmation({ presented, onClose }: { presented: DialogRequest; onClose: () => void }) {
  const request = presented.request;
  const colors = useNavigationColors();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState(
    presented.kind === "text-input" ? presented.request.initialValue : "",
  );
  const thread = presented.kind === "confirm" ? presented.request.thread : undefined;
  const project = useProject(
    thread ? { environmentId: thread.environmentId, projectId: thread.projectId } : null,
  );
  const config = useEnvironmentServerConfig(thread?.environmentId ?? null);
  const provider = config?.providers.find(
    (p) =>
      p.instanceId === (thread?.session?.providerInstanceId ?? thread?.modelSelection.instanceId),
  );
  const destructive = presented.kind === "confirm" && presented.request.destructive === true;
  const confirmDisabled = presented.kind === "text-input" && inputValue.trim().length === 0;
  const Icon =
    presented.kind === "text-input" ? IconEdit : destructive ? IconTrash : IconInfoCircle;
  const confirm = async () => {
    if (lock.current || confirmDisabled) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const success =
        presented.kind === "text-input"
          ? await presented.request.onConfirm(inputValue)
          : await presented.request.onConfirm();
      if (success === false) setError("The action could not be completed. Please try again.");
      else onClose();
    } catch {
      setError("The action could not be completed. Please try again.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <ModalSlideUp
      title={request.title}
      description={thread?.title}
      identityLabel={thread ? threadIdentityLabel(thread, provider?.driver ?? null) : undefined}
      identity={
        thread ? (
          <ThreadAvatar
            thread={thread}
            project={project}
            providerDriver={provider?.driver ?? null}
            size={64}
          />
        ) : (
          <Icon size={38} color={destructive ? colors.danger : colors.accent} />
        )
      }
      cancelText={request.cancelText}
      returnFocusRef={request.returnFocusRef}
      busy={busy}
      onClose={() => {
        request.onCancel?.();
        onClose();
      }}
      footer={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={busy ? `${request.confirmText}, working` : request.confirmText}
          disabled={busy || confirmDisabled}
          accessibilityState={{ busy, disabled: busy || confirmDisabled }}
          onPress={() => void confirm()}
          style={{
            minHeight: 48,
            padding: 12,
            borderRadius: 12,
            backgroundColor: destructive ? "#b91c1c" : colors.accent,
            alignItems: "center",
            justifyContent: "center",
            opacity: busy || confirmDisabled ? 0.6 : 1,
          }}
        >
          <AppText style={{ fontSize: 16, fontFamily: "DMSans-Medium", color: "#ffffff" }}>
            {busy ? "Working…" : request.confirmText}
          </AppText>
        </Pressable>
      }
    >
      {presented.kind === "text-input" ? (
        <TextInput
          accessibilityLabel={request.title}
          autoFocus
          onChangeText={setInputValue}
          onSubmitEditing={confirmDisabled ? undefined : () => void confirm()}
          returnKeyType="done"
          selectTextOnFocus
          value={inputValue}
          style={{
            marginHorizontal: 8,
            marginBottom: 12,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.border,
            paddingHorizontal: 12,
            paddingVertical: 10,
            fontSize: 16,
            color: colors.foreground,
          }}
        />
      ) : presented.request.message ? (
        <AppText
          style={{
            paddingHorizontal: 8,
            paddingBottom: 12,
            fontSize: 16,
            lineHeight: 23,
            color: colors.foreground,
          }}
        >
          {presented.request.message}
        </AppText>
      ) : null}
      {error ? (
        <AppText accessibilityRole="alert" style={{ padding: 8, color: colors.danger }}>
          {error}
        </AppText>
      ) : null}
    </ModalSlideUp>
  );
}
