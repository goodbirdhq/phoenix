import { createRouter } from "@tanstack/react-router";
import { parseCloudSearch, stringifyCloudSearch } from "./lib/oauth-search";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    parseSearch: parseCloudSearch,
    stringifySearch: stringifyCloudSearch,
  });
}
declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
