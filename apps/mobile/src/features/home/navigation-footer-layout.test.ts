import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";
import type {
  StackNavigationState,
  StackRouter as StackRouterType,
  StackActions as StackActionsType,
} from "@react-navigation/native";
import { vi } from "vite-plus/test";

function loadRouters() {
  const require = NodeModule.createRequire(import.meta.url);
  const nativePackage = require.resolve("@react-navigation/native/package.json");
  const requireFromNative = NodeModule.createRequire(nativePackage);
  const corePackage = requireFromNative.resolve("@react-navigation/core/package.json");
  const requireFromCore = NodeModule.createRequire(corePackage);
  return requireFromCore("@react-navigation/routers") as {
    readonly StackActions: typeof StackActionsType;
    readonly StackRouter: typeof StackRouterType;
  };
}

vi.mock("@react-navigation/native", () => {
  const { StackActions } = loadRouters();
  return { StackActions };
});

import {
  footerShowsLabels,
  footerDestination,
  footerRootTarget,
  type FooterRoute,
} from "./navigation-footer-layout";

const { StackActions, StackRouter } = loadRouters();
const routeNames = ["Home", "SettingsSheet", "Thread"];
const routeParamList = {
  Home: undefined,
  SettingsSheet: undefined,
  Thread: undefined,
};
const router = StackRouter({ initialRouteName: "Home" });
const routerOptions = { routeNames, routeParamList, routeGetIdList: {} };

function footerAction(route: FooterRoute) {
  return (state: StackNavigationState<Record<string, object | undefined>>) => {
    const target = footerRootTarget(state, route);
    const params =
      "screen" in target ? { screen: target.screen, params: target.params } : undefined;
    return target.kind === "push"
      ? StackActions.push(target.name, params)
      : StackActions.popTo(target.name, params);
  };
}

function apply(
  state: StackNavigationState<Record<string, object | undefined>>,
  action: Parameters<typeof router.getStateForAction>[1],
) {
  const nextState = router.getStateForAction(state, action, routerOptions);
  expect(nextState).not.toBeNull();
  return nextState as StackNavigationState<Record<string, object | undefined>>;
}
describe("navigation footer label fit", () => {
  it("keeps six accessible icon targets below the agreed breakpoint", () => {
    expect(footerShowsLabels(390, 1)).toBe(false);
    expect(footerShowsLabels(409, 1)).toBe(false);
    expect(footerShowsLabels(410, 1)).toBe(true);
    expect(footerShowsLabels(412, 1)).toBe(true);
  });
  it("falls back to icons when larger text no longer fits the longest destination", () => {
    expect(footerShowsLabels(412, 1.3)).toBe(false);
    expect(footerShowsLabels(500, 1.3)).toBe(true);
  });
});

describe("navigation footer destination", () => {
  it("follows the settings destination through the root and sheet stacks", () => {
    expect(
      footerDestination({
        index: 1,
        routes: [
          { name: "Home" },
          {
            name: "SettingsSheet",
            state: {
              routes: [
                {
                  name: "SettingsContent",
                  state: {
                    index: 1,
                    routes: [{ name: "Settings" }, { name: "SettingsEnvironments" }],
                  },
                },
              ],
            },
          },
        ],
      }),
    ).toBe("SettingsEnvironments");
  });
  it("keeps conversation routes under Agents and nested preferences under Settings", () => {
    expect(footerDestination({ routes: [{ name: "Thread" }] })).toBe("Home");
    expect(footerDestination({ routes: [{ name: "SettingsAppearance" }] })).toBe("Settings");
    expect(footerDestination({ routes: [{ name: "SettingsScheduleDetail" }] })).toBe(
      "SettingsSchedules",
    );
  });

  it("switches root destinations without stacking stale footer routes", () => {
    const home = router.getInitialState(routerOptions);
    const settings = apply(home, footerAction("SettingsSchedules")(home));
    expect(settings.routes.map((route) => route.name)).toEqual(["Home", "SettingsSheet"]);

    const staleThread = apply(settings, StackActions.push("Thread"));
    const returnedToSettings = apply(staleThread, footerAction("SettingsUsage")(staleThread));
    expect(returnedToSettings.routes.map((route) => route.name)).toEqual(["Home", "SettingsSheet"]);
    expect(returnedToSettings.routes.at(-1)?.params).toEqual({
      screen: "SettingsContent",
      params: { screen: "SettingsUsage" },
    });

    const returnedHome = apply(returnedToSettings, footerAction("Home")(returnedToSettings));
    expect(returnedHome.routes.map((route) => route.name)).toEqual(["Home"]);
  });
});
