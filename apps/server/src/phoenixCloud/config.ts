import * as Schema from "effect/Schema";

export class CloudOriginError extends Schema.TaggedError<CloudOriginError>()("CloudOriginError", {
  reason: Schema.Literals(["missing", "invalid", "insecure"]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "missing":
        return "Configure a Phoenix Cloud URL before signing in.";
      case "invalid":
        return "Phoenix Cloud URL must be an HTTP or HTTPS origin without credentials, a path, or a query.";
      case "insecure":
        return "Phoenix Cloud requires HTTPS. Enable PHOENIX_CLOUD_ALLOW_INSECURE_HTTP only for development.";
    }
  }
}

export function normalizeCloudOrigin(
  value: string | undefined,
  allowInsecureHttp = false,
): string | CloudOriginError {
  if (!value?.trim()) return new CloudOriginError({ reason: "missing" });
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return new CloudOriginError({ reason: "invalid" });
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    return new CloudOriginError({ reason: "invalid" });
  if (url.protocol === "http:" && !allowInsecureHttp) {
    return new CloudOriginError({ reason: "insecure" });
  }
  return url.origin;
}
