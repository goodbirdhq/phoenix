export function canViewMermaid(
  platform: string,
  language: string | null | undefined,
  complete: boolean,
): boolean {
  return platform === "android" && complete && language?.trim().toLowerCase() === "mermaid";
}

export function completedMermaidSources(markdown: string): ReadonlySet<string> {
  const sources = new Set<string>();
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})mermaid(?:[ \t][^\n]*)?$/i.exec(lines[i] ?? "");
    if (!open) continue;
    const fence = open[1] ?? "";
    const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`);
    const start = i + 1;
    while (++i < lines.length && !close.test(lines[i] ?? "")) {}
    if (i < lines.length) sources.add(`${lines.slice(start, i).join("\n")}\n`);
  }
  return sources;
}
