import Constants from "expo-constants";
import { makeRelayClientTracingLayer } from "@t3tools/shared/relayTracing";

export interface TracingConfig {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
}

export interface TracingResource {
  readonly serviceVersion?: string;
  readonly appVariant: string;
}

export function resolveTracingConfig(): TracingConfig | null {
  const observability = Constants.expoConfig?.extra?.observability;
  const tracesUrl = typeof observability?.tracesUrl === "string" ? observability.tracesUrl : null;
  const tracesDataset =
    typeof observability?.tracesDataset === "string" ? observability.tracesDataset : null;
  const tracesToken =
    typeof observability?.tracesToken === "string" ? observability.tracesToken : null;
  if (!tracesUrl || !tracesDataset || !tracesToken) {
    return null;
  }
  return { tracesUrl, tracesDataset, tracesToken };
}

export function makeTracingLayer(config: TracingConfig | null, resource: TracingResource) {
  return makeRelayClientTracingLayer(config, {
    serviceName: "phoenix-mobile-client",
    serviceVersion: resource.serviceVersion,
    runtime: "react-native",
    client: `mobile-${resource.appVariant}`,
  });
}

export const tracingLayer = makeTracingLayer(resolveTracingConfig(), {
  serviceVersion: Constants.expoConfig?.version,
  appVariant:
    typeof Constants.expoConfig?.extra?.appVariant === "string"
      ? Constants.expoConfig.extra.appVariant
      : "unknown",
});
