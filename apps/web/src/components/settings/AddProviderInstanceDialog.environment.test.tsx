import { visitElements } from "../../test/reactElementTree";
import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const settingsHooks = vi.hoisted(() => ({
  read: vi.fn(() => ({ providerInstances: {} })),
  update: vi.fn<(input: unknown) => Promise<{ _tag: "Success" | "Failure" }>>(),
  toast: vi.fn(),
  session: vi.fn(() => ({ data: { scopes: ["orchestration:operate"] } })),
  providers: vi.fn((): unknown[] => []),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: settingsHooks.read,
}));

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => settingsHooks.update }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: settingsHooks.providers }));
vi.mock("../../state/session", () => ({ useEnvironmentSessionState: settingsHooks.session }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    updateSettings: Symbol("updateSettings"),
    providersValueAtom: vi.fn(),
  },
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: settingsHooks.toast } }));

import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";

const remoteEnvironmentId = EnvironmentId.make("remote-device");

function acknowledgement<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("AddProviderInstanceDialog environment routing", () => {
  beforeEach(() => {
    hooks.reset();
    vi.clearAllMocks();
    settingsHooks.session.mockReturnValue({ data: { scopes: ["orchestration:operate"] } });
    settingsHooks.providers.mockReturnValue([]);
  });

  function scenario() {
    const onOpenChange = vi.fn();
    const render = () => {
      hooks.beginRender();
      return AddProviderInstanceDialog({
        open: true,
        environmentId: remoteEnvironmentId,
        environmentLabel: "Remote device",
        onOpenChange,
      });
    };
    const click = (label: string) => {
      const button = visitElements(
        render(),
        (element) =>
          element.props.children === label && typeof element.props.onClick === "function",
      );
      if (!button) throw new Error(`Missing button ${label}`);
      (button.props.onClick as () => void)();
    };
    const field = visitElements(render(), (element) => element.props.placeholder === "e.g. Work")!;
    (field.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "Work" },
    });
    click("Next");
    click("Next");
    return { render, click, onOpenChange };
  }

  it("rejects creation and restoration in a read-only target environment", () => {
    settingsHooks.session.mockReturnValue({ data: { scopes: ["orchestration:read"] } });
    settingsHooks.providers.mockReturnValue([
      { instanceId: "codex_work", driver: "codex", enabled: false, displayName: "Work" },
    ]);
    const onOpenChange = vi.fn();
    hooks.beginRender();
    const initial = AddProviderInstanceDialog({
      open: true,
      environmentId: remoteEnvironmentId,
      environmentLabel: "Remote",
      onOpenChange,
    });
    const restore = visitElements(
      initial,
      (element) => element.props["aria-label"] === "Enable Work (codex_work)",
    )!;
    expect(restore.props.disabled).toBe(true);
    (restore.props.onClick as () => void)();
    const dialog = scenario();
    dialog.click("Add instance");
    expect(settingsHooks.update).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(dialog.onOpenChange).not.toHaveBeenCalled();
  });

  it("routes the save to the supplied environment and waits for acknowledgement before closing", async () => {
    const ack = acknowledgement<{ _tag: "Success" }>();
    settingsHooks.update.mockReturnValue(ack.promise);
    const dialog = scenario();
    dialog.click("Add instance");
    expect(settingsHooks.read).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.update).toHaveBeenCalledWith({
      environmentId: remoteEnvironmentId,
      input: {
        patch: {
          providerInstances: {
            codex_work: { driver: "codex", enabled: true, displayName: "Work" },
          },
        },
      },
    });
    expect(dialog.onOpenChange).not.toHaveBeenCalled();
    const pending = dialog.render();
    pending.props.onOpenChange(false);
    expect(dialog.onOpenChange).not.toHaveBeenCalled();
    expect(
      visitElements(pending, (element) => element.props.children === "Adding…")?.props.disabled,
    ).toBe(true);
    ack.resolve({ _tag: "Success" });
    await ack.promise;
    expect(dialog.onOpenChange).toHaveBeenCalledWith(false);
    expect(settingsHooks.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  });

  it("keeps the draft and allows retry when the selected environment rejects the save", async () => {
    const ack = acknowledgement<{ _tag: "Failure" }>();
    settingsHooks.update.mockReturnValue(ack.promise);
    const dialog = scenario();
    dialog.click("Add instance");
    ack.resolve({ _tag: "Failure" });
    await ack.promise;
    expect(dialog.onOpenChange).not.toHaveBeenCalled();
    expect(settingsHooks.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    expect(
      visitElements(dialog.render(), (element) => element.props.placeholder === "e.g. Work")?.props
        .value,
    ).toBe("Work");
    expect(
      visitElements(dialog.render(), (element) => element.props.children === "Add instance")?.props
        .disabled,
    ).toBe(false);
    settingsHooks.update.mockResolvedValue({ _tag: "Success" });
    dialog.click("Add instance");
    await Promise.resolve();
    expect(dialog.onOpenChange).toHaveBeenCalledWith(false);
    expect(settingsHooks.update).toHaveBeenCalledTimes(2);
  });
});
