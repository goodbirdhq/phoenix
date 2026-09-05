import type { UsageAccount } from "@t3tools/client-runtime/usage/accounts";
import type { MergedUsage } from "@t3tools/shared/usageMerge";
import { formatTokens, formatUsd, formatDateTimeShort } from "@t3tools/shared/usageFormat";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table";
import { Badge } from "../ui/badge";

export function UsageEnvironments({
  account,
  merged,
  timeZone,
}: {
  readonly account: UsageAccount;
  readonly merged: MergedUsage;
  readonly timeZone: string;
}) {
  const ids = [...new Set(account.memberships.map((member) => member.environmentId))];
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Environment</TableHead>
          <TableHead>Installed version</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Sessions</TableHead>
          <TableHead className="text-right">Tokens</TableHead>
          <TableHead className="text-right">API cost</TableHead>
          <TableHead>Last checked</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ids.map((id) => {
          const members = account.memberships.filter((member) => member.environmentId === id);
          const hasLinkedHistory = members.some((member) =>
            member.historySources.some(
              (source) =>
                source.configuredInstanceIds?.length &&
                source.configuredInstanceIds.every((instanceId) =>
                  members.some((candidate) => candidate.provider.instanceId === instanceId),
                ),
            ),
          );
          const total = hasLinkedHistory
            ? merged.environmentTotals.find((entry) => entry.environmentId === id)
            : undefined;
          return (
            <TableRow key={id}>
              <TableCell className="py-5 text-sm">{members[0]?.environmentLabel}</TableCell>
              <TableCell>
                {members.map(({ provider }) => (
                  <div className="flex flex-col gap-1 py-1" key={provider.instanceId}>
                    <span>{provider.version ?? "Not reported"}</span>
                    {provider.versionAdvisory?.status === "behind_latest" && (
                      <Badge variant="warning">
                        Update available
                        {provider.versionAdvisory.latestVersion
                          ? ` · ${provider.versionAdvisory.latestVersion}`
                          : ""}
                      </Badge>
                    )}
                  </div>
                ))}
              </TableCell>
              <TableCell>
                {members.map(({ provider, isConnected }) => (
                  <div className="py-1" key={provider.instanceId}>
                    <Badge
                      variant={
                        isConnected !== false &&
                        provider.enabled &&
                        provider.auth.status === "authenticated"
                          ? "success"
                          : "secondary"
                      }
                    >
                      {isConnected === false
                        ? "Offline"
                        : !provider.enabled
                          ? "Disabled"
                          : !provider.installed
                            ? "Not installed"
                            : provider.auth.status === "authenticated"
                              ? "Signed in"
                              : provider.auth.status === "unauthenticated"
                                ? "Signed out"
                                : "Unknown"}
                    </Badge>
                  </div>
                ))}
              </TableCell>
              <TableCell className="text-right tabular-nums">{total?.sessions ?? "—"}</TableCell>
              <TableCell className="text-right tabular-nums">
                {total ? formatTokens(total.totalTokens) : "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {total ? formatUsd(total.costUsd) : "—"}
              </TableCell>
              <TableCell>
                {members.map(({ provider }) => (
                  <div key={provider.instanceId} className="py-1 text-muted-foreground">
                    {formatDateTimeShort(provider.checkedAt, timeZone)}
                  </div>
                ))}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
