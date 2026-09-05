import type { UsageSession, UsageSource, UsageThread } from "@t3tools/contracts";

export interface UsageSessionLink {
  readonly providerName: string;
  readonly providerInstanceId: string;
  readonly sessionId: string;
  readonly thread: UsageThread;
}

/** Match recorded native identity within the configured history store. Neither
 * workspace paths nor the account currently signed in establish ownership. */
export function attributeUsageSessions(
  sessions: readonly UsageSession[],
  sources: readonly UsageSource[],
  links: readonly UsageSessionLink[],
): readonly UsageSession[] {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const linksBySession = new Map<string, UsageSessionLink[]>();
  for (const link of links) {
    const key = JSON.stringify([link.providerName, link.sessionId]);
    const entries = linksBySession.get(key);
    if (entries) entries.push(link);
    else linksBySession.set(key, [link]);
  }
  return sessions.map((session) => {
    const instances = sourceById.get(session.sourceId)?.configuredInstanceIds ?? [];
    const driver = session.provider === "claude" ? "claudeAgent" : session.provider;
    const candidates = linksBySession.get(JSON.stringify([driver, session.sessionId])) ?? [];
    const threads = new Map(
      candidates
        .filter((link) => instances.includes(link.providerInstanceId))
        .map((link) => [link.thread.id, link.thread]),
    );
    const thread = threads.size === 1 ? threads.values().next().value : undefined;
    return {
      ...session,
      attribution: thread ? "linked" : threads.size > 1 ? "ambiguous" : "unlinked",
      ...(thread ? { thread } : {}),
    };
  });
}
