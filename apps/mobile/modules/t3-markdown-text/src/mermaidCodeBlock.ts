export function canViewMermaid(
  platform: string,
  language: string | null | undefined,
  complete: boolean,
): boolean {
  return platform === "android" && complete && language?.trim().toLowerCase() === "mermaid";
}
