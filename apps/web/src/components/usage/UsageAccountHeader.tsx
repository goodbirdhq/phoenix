import { lazy, Suspense, useState, type ReactNode } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import type { UsageAccount, UsageAccountMembership } from "@t3tools/client-runtime/usage/accounts";
import { PencilIcon } from "lucide-react";
import { PageHeading } from "../patterns/PageHeading";
import { ConcealedValue } from "../patterns/ConcealedValue";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogHeader, DialogPanel } from "../ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { PROVIDER_PRESENTATION } from "./usageProviders";
import { usageProviderKind } from "./usageAccountPresentation";
const ProviderSettingsPanel = lazy(() =>
  import("../settings/ProviderSettingsPanel").then((module) => ({
    default: module.ProviderSettingsPanel,
  })),
);

export function UsageAccountHeader({
  account,
  actions,
}: {
  readonly account: UsageAccount;
  readonly actions?: ReactNode;
}) {
  const [editing, setEditing] = useState<UsageAccountMembership | null>(null);
  const provider = account.memberships[0]?.provider;
  const { label, mark: Mark } = PROVIDER_PRESENTATION[usageProviderKind(account.driver)];
  const plans = [
    ...new Set(
      account.memberships.flatMap((member) =>
        member.provider.auth.label ? [member.provider.auth.label] : [],
      ),
    ),
  ];
  return (
    <>
      <PageHeading
        title={provider?.displayName ?? label}
        icon={<Mark />}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {account.emails.map((email) => (
              <ConcealedValue key={email} value={email} />
            ))}
            {account.emails.length === 0 && (
              <span>{provider?.auth.type === "api_key" ? "API key" : "Email unavailable"}</span>
            )}
            {plans.length > 0 && (
              <>
                <span aria-hidden>·</span>
                <span>{plans.join(" · ")}</span>
              </>
            )}
          </span>
        }
        actions={
          <>
            {account.memberships.length === 1 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing(account.memberships[0] ?? null)}
              >
                <PencilIcon />
                Edit
              </Button>
            ) : (
              <Select
                value=""
                onValueChange={(value) =>
                  setEditing(
                    account.memberships.find(
                      (member) =>
                        JSON.stringify([member.environmentId, member.provider.instanceId]) ===
                        value,
                    ) ?? null,
                  )
                }
              >
                <SelectTrigger aria-label="Choose environment to edit">
                  <PencilIcon className="size-3.5" />
                  <SelectValue>Edit</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {account.memberships.map((member) => (
                    <SelectItem
                      key={JSON.stringify([member.environmentId, member.provider.instanceId])}
                      value={JSON.stringify([member.environmentId, member.provider.instanceId])}
                    >
                      {member.environmentLabel} ·{" "}
                      {member.provider.displayName ?? member.provider.instanceId}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
            {actions}
          </>
        }
      />
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogPopup className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>Edit provider · {editing?.environmentLabel}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="p-0">
            {editing && (
              <Suspense
                fallback={
                  <p className="p-6 text-sm text-muted-foreground">Loading provider settings…</p>
                }
              >
                <ProviderSettingsPanel
                  key={JSON.stringify([editing.environmentId, editing.provider.instanceId])}
                  initialEnvironmentId={EnvironmentId.make(editing.environmentId)}
                  initialInstanceId={editing.provider.instanceId}
                />
              </Suspense>
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
