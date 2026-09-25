export type ViewerMessage =
  | { readonly type: "ready" | "rendered" }
  | { readonly type: "error"; readonly error: string };

export function parseViewerMessage(data: string): ViewerMessage | null {
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object" || !("type" in value)) return null;
    if (value.type === "ready" || value.type === "rendered") return { type: value.type };
    if (value.type === "error")
      return {
        type: "error",
        error:
          "error" in value && typeof value.error === "string"
            ? value.error
            : "Diagram could not be rendered.",
      };
    return null;
  } catch {
    return null;
  }
}

export function shouldShowViewerSource(showSource: boolean, error: string | null): boolean {
  return showSource || error !== null;
}
