"use client";

import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type { ProviderFailoverGroupOption } from "./ProviderFailoverGroups.logic";

interface ProviderFailoverGroupControlProps {
  readonly currentGroup: string | null;
  readonly driverLabel: string;
  readonly groups: ReadonlyArray<ProviderFailoverGroupOption>;
  readonly onGroupChange: (group: string | null) => void;
  readonly validateNewGroupName: (group: string) => string | null;
}

const UNGROUPED_VALUE = "ungrouped";
const GROUP_VALUE_PREFIX = "group:";

function groupSelectValue(group: string): string {
  return `${GROUP_VALUE_PREFIX}${group}`;
}

export function ProviderFailoverGroupControl({
  currentGroup,
  driverLabel,
  groups,
  onGroupChange,
  validateNewGroupName,
}: ProviderFailoverGroupControlProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const currentGroupOption = groups.find((group) => group.name === currentGroup);

  const createGroup = () => {
    const name = draftName.trim();
    const validationError = validateNewGroupName(name);
    if (validationError !== null) {
      setDraftError(validationError);
      return;
    }

    onGroupChange(name);
    setDraftName("");
    setDraftError(null);
    setIsCreating(false);
  };

  return (
    <section className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-xs font-medium text-foreground">Failover group</h4>
        {currentGroup ? (
          <Badge variant="info" size="sm">
            {currentGroup}
          </Badge>
        ) : (
          <Badge variant="outline" size="sm">
            Ungrouped
          </Badge>
        )}
      </div>

      <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
        When this account hits a usage limit, Phoenix switches affected threads to the group member
        with the most remaining quota, retries the failed turn, and notifies you. Ungrouped accounts
        never move automatically.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select
          value={currentGroup ? groupSelectValue(currentGroup) : UNGROUPED_VALUE}
          onValueChange={(value) => {
            const next = String(value);
            if (next === UNGROUPED_VALUE) {
              onGroupChange(null);
              return;
            }
            if (next.startsWith(GROUP_VALUE_PREFIX)) {
              onGroupChange(next.slice(GROUP_VALUE_PREFIX.length));
            }
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-64"
            aria-label={`Failover group for this ${driverLabel} account`}
          >
            <SelectValue>{currentGroup ?? "Ungrouped — never switch automatically"}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem value={UNGROUPED_VALUE}>Ungrouped — never switch automatically</SelectItem>
            {groups.map((group) => (
              <SelectItem key={group.name} value={groupSelectValue(group.name)}>
                {group.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>

        {currentGroup ? (
          <Button type="button" size="sm" variant="outline" onClick={() => onGroupChange(null)}>
            Remove from group
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant={isCreating ? "ghost-muted" : "outline"}
          onClick={() => {
            setDraftError(null);
            setIsCreating((open) => !open);
          }}
        >
          {isCreating ? "Cancel" : "New group"}
        </Button>
      </div>

      {isCreating ? (
        <form
          className="flex max-w-xl flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            createGroup();
          }}
        >
          <div className="min-w-0 flex-1">
            <Input
              value={draftName}
              onChange={(event) => {
                setDraftName(event.target.value);
                setDraftError(null);
              }}
              aria-label="New failover group name"
              aria-invalid={draftError !== null || undefined}
              placeholder="Group name"
              autoFocus
            />
            {draftError ? (
              <p className="mt-1 text-xs text-destructive" role="alert">
                {draftError}
              </p>
            ) : null}
          </div>
          <Button type="submit" size="sm">
            Create and join
          </Button>
        </form>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {currentGroupOption && currentGroupOption.memberLabels.length > 0
          ? `Members: ${currentGroupOption.memberLabels.join(", ")}. `
          : ""}
        Only {driverLabel} accounts are offered here; accounts using other providers cannot share
        this group.
      </p>
    </section>
  );
}
