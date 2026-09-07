import type { UsageAccount } from "@t3tools/client-runtime/usage/accounts";
import type { MergedUsage } from "@t3tools/shared/usageMerge";
import { formatTokens, formatUsd, formatDateTimeShort } from "@t3tools/shared/usageFormat";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table";
import { ServerIcon, InfoIcon } from "lucide-react";
import { Badge } from "../ui/badge";

export function UsageEnvironments({
  account,
  environmentId,
  merged,
  timeZone,
  pending,
}: {
  readonly account: UsageAccount;
  readonly environmentId: string | null;
  readonly merged: MergedUsage;
  readonly timeZone: string;
  readonly pending: boolean;
}) {
  const ids = [...new Set(account.memberships.map((member) => member.environmentId))].filter(
    (id) => environmentId === null || id === environmentId,
  );
  const connected = ids.filter((id) =>
    account.memberships.some(
      (member) => member.environmentId === id && member.isConnected !== false,
    ),
  ).length;
  const value = (text: string | number) =>
    pending ? (
      <span className="ml-auto block h-3 w-12 rounded bg-border" aria-label="Loading usage" />
    ) : (
      text
    );
  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1.5">
          <h2 className="text-base leading-5 font-semibold">Environments</h2>
          <p className="text-[13px] leading-[18px] text-muted-foreground">
            This account is configured in {ids.length}{" "}
            {ids.length === 1 ? "environment" : "environments"}.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          {connected} connected · {ids.length - connected} offline
        </p>
      </div>
      <Table className="min-w-[920px] table-fixed text-xs [&_th]:px-0 [&_td]:px-0 [&_th]:pr-6 [&_td]:pr-6 [&_th]:font-normal [&_th]:text-muted-foreground">
        <colgroup>
          <col className="w-[22%]" />
          <col className="w-[14%]" />
          <col className="w-[13%]" />
          <col className="w-[10%]" />
          <col className="w-[12%]" />
          <col className="w-[12%]" />
          <col className="w-[17%]" />
        </colgroup>
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
                <TableCell className="h-20 text-sm">
                  <span className="flex items-center gap-3">
                    <ServerIcon className="size-[18px] text-muted-foreground" />
                    {members[0]?.environmentLabel}
                  </span>
                </TableCell>
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
                                ? "Connected"
                                : provider.auth.status === "unauthenticated"
                                  ? "Signed out"
                                  : "Unknown"}
                      </Badge>
                    </div>
                  ))}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {value(total?.sessions ?? "—")}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {value(total ? formatTokens(total.totalTokens) : "—")}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {value(total ? formatUsd(total.costUsd) : "—")}
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
          <TableRow className="h-[52px] font-medium">
            <TableCell colSpan={3}>Total across environments</TableCell>
            <TableCell className="text-right tabular-nums">{value(merged.sessions)}</TableCell>
            <TableCell className="text-right tabular-nums">
              {value(formatTokens(merged.totalTokens))}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {value(formatUsd(merged.costUsd))}
            </TableCell>
            <TableCell />
          </TableRow>
        </TableBody>
      </Table>
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <InfoIcon className="size-3.5 shrink-0" />
        Offline environments retain their last synced usage. Shared usage history is counted once;
        this account’s limits are shared.
      </p>
    </section>
  );
}
