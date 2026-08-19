import type { ThreadMigrationHandoffMode } from "@t3tools/contracts";
import { ArrowRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Radio, RadioGroup } from "../ui/radio-group";
import { cn } from "../../lib/utils";
import { deriveMigrationModeAvailability } from "./threadMigration.logic";

export function ThreadMigrationDialog(props: {
  readonly open: boolean;
  readonly sourceName: string;
  readonly targetName: string;
  readonly targetModel: string;
  readonly actionLabel: string;
  readonly isOriginLimited: boolean;
  readonly isTurnStreaming: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (handoffMode: ThreadMigrationHandoffMode) => void;
}) {
  const [handoffMode, setHandoffMode] = useState<ThreadMigrationHandoffMode>("replay");
  const availability = deriveMigrationModeAvailability({
    isOriginLimited: props.isOriginLimited,
    isTurnStreaming: props.isTurnStreaming,
  });

  useEffect(() => {
    if (props.open) setHandoffMode("replay");
  }, [props.open, props.targetName, props.targetModel]);

  useEffect(() => {
    if (handoffMode === "brief" && availability.briefDisabledReason) {
      setHandoffMode("replay");
    }
  }, [availability.briefDisabledReason, handoffMode]);

  const options: ReadonlyArray<{
    readonly value: ThreadMigrationHandoffMode;
    readonly title: string;
    readonly description: string;
    readonly disabledReason: string | null;
  }> = [
    {
      value: "replay",
      title: "Replay history",
      description:
        "Reconstruct the conversation directly from Phoenix. Works even when the current account is limited.",
      disabledReason: availability.replayDisabledReason,
    },
    {
      value: "brief",
      title: "Create a handoff brief",
      description:
        "Ask the current agent to compact the thread before the new provider takes over.",
      disabledReason: availability.briefDisabledReason,
    },
  ];

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="w-full sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Migrate this thread?</DialogTitle>
          <DialogDescription>
            Move the thread from {props.sourceName} to {props.targetName} on {props.targetModel}.
            Its messages, checkpoints, diffs, and sidebar identity stay in place.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="flex items-center gap-2 rounded-lg border bg-muted/35 px-3 py-2 text-sm">
            <span className="min-w-0 truncate font-medium">{props.sourceName}</span>
            <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 truncate font-medium">{props.targetName}</span>
          </div>

          <div>
            <div id="migration-handoff-mode-label" className="mb-2 text-sm font-medium">
              Handoff mode
            </div>
            <RadioGroup
              aria-labelledby="migration-handoff-mode-label"
              value={handoffMode}
              onValueChange={(value) => setHandoffMode(value as ThreadMigrationHandoffMode)}
              className="gap-2"
            >
              {options.map((option) => {
                const disabled = option.disabledReason !== null;
                return (
                  <label
                    key={option.value}
                    className={cn(
                      "flex gap-3 rounded-lg border bg-card px-3 py-3",
                      disabled
                        ? "cursor-not-allowed opacity-64"
                        : "cursor-pointer has-[[data-checked]]:border-primary has-[[data-checked]]:bg-primary/5",
                    )}
                  >
                    <Radio
                      value={option.value}
                      disabled={disabled}
                      className="mt-0.5"
                      aria-describedby={`migration-mode-${option.value}-description`}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">
                        {option.title}
                      </span>
                      <span
                        id={`migration-mode-${option.value}-description`}
                        className="mt-0.5 block text-muted-foreground text-xs leading-5"
                      >
                        {option.disabledReason ?? option.description}
                      </span>
                    </span>
                  </label>
                );
              })}
            </RadioGroup>
          </div>

          {availability.migrationDisabledReason ? (
            <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-warning-foreground text-sm">
              {availability.migrationDisabledReason}
            </p>
          ) : null}
          {props.error ? (
            <p role="alert" className="text-destructive text-sm">
              {props.error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => props.onOpenChange(false)}
            disabled={props.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => props.onConfirm(handoffMode)}
            disabled={props.isPending || availability.migrationDisabledReason !== null}
          >
            {props.isPending ? "Switching..." : props.actionLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
