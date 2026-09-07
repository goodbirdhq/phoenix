import { useEffect, useRef, useState } from "react";
import { Pressable } from "react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import IconTrash from "@tabler/icons-react-native/IconTrash";
import IconInfoCircle from "@tabler/icons-react-native/IconInfoCircle";
import { AppText } from "./AppText";
import { ModalSlideUp } from "./ModalSlideUp";
import { ThreadAvatar } from "./ThreadAvatar";
import { useNavigationColors } from "./useNavigationColors";
import { useProject, useEnvironmentServerConfig } from "../state/entities";

export type ConfirmDialogRequest = {
  readonly title: string;
  readonly message?: string;
  readonly cancelText?: string;
  readonly confirmText: string;
  readonly destructive?: boolean;
  readonly thread?: EnvironmentThreadShell;
  readonly onConfirm: () => void | Promise<boolean>;
  readonly onCancel?: () => void;
};
let presentRequest: ((request: ConfirmDialogRequest) => void) | null = null;
export function showConfirmDialog(request: ConfirmDialogRequest): void {
  presentRequest?.(request);
}
export function ConfirmDialogHost() {
  const [request, setRequest] = useState<ConfirmDialogRequest | null>(null);
  useEffect(() => {
    presentRequest = setRequest;
    return () => {
      presentRequest = null;
    };
  }, []);
  return request ? (
    <Confirmation
      key={request.thread ? `${request.thread.environmentId}:${request.thread.id}` : request.title}
      request={request}
      onClose={() => setRequest(null)}
    />
  ) : null;
}
function Confirmation({
  request,
  onClose,
}: {
  request: ConfirmDialogRequest;
  onClose: () => void;
}) {
  const colors = useNavigationColors();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const project = useProject(
    request.thread
      ? { environmentId: request.thread.environmentId, projectId: request.thread.projectId }
      : null,
  );
  const config = useEnvironmentServerConfig(request.thread?.environmentId ?? null);
  const provider = config?.providers.find(
    (p) =>
      p.instanceId ===
      (request.thread?.session?.providerInstanceId ?? request.thread?.modelSelection.instanceId),
  );
  const Icon = request.destructive ? IconTrash : IconInfoCircle;
  const confirm = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const success = await request.onConfirm();
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
      description={request.thread?.title}
      identity={
        request.thread ? (
          <ThreadAvatar
            thread={request.thread}
            project={project}
            providerDriver={provider?.driver ?? null}
            size={64}
          />
        ) : (
          <Icon size={38} color={request.destructive ? colors.danger : colors.accent} />
        )
      }
      cancelText={request.cancelText}
      busy={busy}
      onClose={() => {
        request.onCancel?.();
        onClose();
      }}
      footer={
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          accessibilityState={{ busy, disabled: busy }}
          onPress={() => void confirm()}
          style={{
            minHeight: 48,
            padding: 12,
            borderRadius: 12,
            backgroundColor: request.destructive ? "#b91c1c" : colors.accent,
            alignItems: "center",
            justifyContent: "center",
            opacity: busy ? 0.6 : 1,
          }}
        >
          <AppText style={{ fontSize: 16, fontFamily: "DMSans-Medium", color: "#ffffff" }}>
            {busy ? "Working…" : request.confirmText}
          </AppText>
        </Pressable>
      }
    >
      {request.message ? (
        <AppText
          style={{
            paddingHorizontal: 8,
            paddingBottom: 12,
            fontSize: 16,
            lineHeight: 23,
            color: colors.foreground,
          }}
        >
          {request.message}
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
