import type { ReactElement } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const state = vi.hoisted(() => ({
  priceTargets: [] as readonly {
    environmentId: EnvironmentId;
    label: string;
    prices: Record<string, unknown> | null;
    unavailable: string | null;
  }[],
}));

const commands = vi.hoisted(() => ({
  updateSettings: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useContext: () => ({}),
    useCallback: reactHookHarness.useCallback,
    useEffect: reactHookHarness.useEffect,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => state.priceTargets,
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => commands.updateSettings,
}));

vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: null },
}));

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    updateSettings: () => undefined,
    settingsValueAtom: () => null,
  },
}));

vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => null },
}));

vi.mock("../../env", () => ({ isElectron: false }));

import { UsagePriceOverrides } from "./UsagePriceOverrides";

const price = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };

function target(id: string): (typeof state)["priceTargets"][number] {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    prices: {},
    unavailable: null,
  };
}

function render(initialSelectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null) {
  hooks.beginRender();
  return UsagePriceOverrides({
    usage: [],
    initialSelectedEnvironmentIds,
    onOpenChange: () => {},
  }) as ReactElement<Record<string, unknown>>;
}

function byAriaLabel(node: unknown, label: string) {
  return visitElements(node, (element) => element.props["aria-label"] === label);
}

function buttonByText(node: unknown, text: string) {
  return visitElements(
    node,
    (element) => typeof element.props.children === "string" && element.props.children === text,
  );
}

function click(element: ReturnType<typeof visitElements>): void {
  (element?.props.onClick as (() => void) | undefined)?.();
}

function change(element: ReturnType<typeof visitElements>, value: string): void {
  (element?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
    target: { value },
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Adds a new custom model, sets its input and output rates, then re-renders. */
function driveToSave(panel: ReactElement<Record<string, unknown>>) {
  click(byAriaLabel(panel, "Add model price"));
  panel = render();
  change(byAriaLabel(panel, "New model ID"), "custom-gpt-5");
  panel = render();
  change(byAriaLabel(panel, "Input price for custom-gpt-5"), "2");
  panel = render();
  change(byAriaLabel(panel, "Output price for custom-gpt-5"), "8");
  panel = render();
  return panel;
}

describe("UsagePriceOverrides interaction", () => {
  beforeEach(() => {
    hooks.reset();
    commands.updateSettings.mockReset().mockResolvedValue({ _tag: "Success" });
  });

  it("seeds selection from the current scope and saves a custom price to every environment", async () => {
    state.priceTargets = [target("a"), target("b")];
    let panel = render(); // initialSelectedEnvironmentIds null -> all environments
    expect(
      visitElements(panel, (element) => element.props.children === "All environments"),
    ).not.toBeNull();

    panel = driveToSave(panel);
    click(buttonByText(panel, "Save changes"));
    await flush();

    expect(commands.updateSettings).toHaveBeenCalledTimes(2);
    expect(commands.updateSettings).toHaveBeenCalledWith({
      environmentId: "a",
      input: { patch: { usagePriceOverrides: { "custom-gpt-5": price } } },
    });
    expect(commands.updateSettings).toHaveBeenCalledWith({
      environmentId: "b",
      input: { patch: { usagePriceOverrides: { "custom-gpt-5": price } } },
    });
  });

  it("saves only the one selected environment", async () => {
    state.priceTargets = [target("a"), target("b")];
    let panel = render(new Set([EnvironmentId.make("a")]));
    expect(visitElements(panel, (element) => element.props.children === "a")).not.toBeNull();

    panel = driveToSave(panel);
    click(buttonByText(panel, "Save changes"));
    await flush();

    expect(commands.updateSettings).toHaveBeenCalledTimes(1);
    expect(commands.updateSettings).toHaveBeenCalledWith({
      environmentId: "a",
      input: { patch: { usagePriceOverrides: { "custom-gpt-5": price } } },
    });
  });

  it("retries only the destination that failed, keeping successful writes", async () => {
    state.priceTargets = [target("a"), target("b")];
    commands.updateSettings.mockImplementation(
      async ({ environmentId }: { environmentId: string }) =>
        environmentId === "a" ? { _tag: "Failure" as const } : { _tag: "Success" as const },
    );

    let panel = render();
    panel = driveToSave(panel);
    click(buttonByText(panel, "Save changes"));
    await flush();

    expect(commands.updateSettings).toHaveBeenCalledTimes(2);

    panel = render();
    const retry = buttonByText(panel, "Retry failed saves");
    expect(retry).not.toBeNull();
    click(retry);
    await flush();

    expect(commands.updateSettings).toHaveBeenCalledTimes(3);
    expect(commands.updateSettings).toHaveBeenNthCalledWith(3, {
      environmentId: "a",
      input: { patch: { usagePriceOverrides: { "custom-gpt-5": price } } },
    });
    expect(commands.updateSettings).not.toHaveBeenNthCalledWith(3, {
      environmentId: "b",
      input: { patch: { usagePriceOverrides: { "custom-gpt-5": price } } },
    });
  });
});
