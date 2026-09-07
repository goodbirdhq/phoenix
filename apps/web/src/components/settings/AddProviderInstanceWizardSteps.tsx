import { CheckIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import {
  ADD_PROVIDER_WIZARD_STEPS,
  resolveWizardNavigation,
  type WizardNavigation,
} from "./AddProviderInstanceDialog.logic";

interface AddProviderInstanceWizardStepsProps {
  readonly currentStep: number;
  readonly summaries: readonly (string | null)[];
  readonly instanceIdError: string | null;
  readonly onNavigation: (navigation: WizardNavigation) => void;
}

export function AddProviderInstanceWizardSteps({
  currentStep,
  summaries,
  instanceIdError,
  onNavigation,
}: AddProviderInstanceWizardStepsProps) {
  return (
    <ol className="mx-auto grid w-[240px] grid-cols-3 gap-1" role="list">
      {ADD_PROVIDER_WIZARD_STEPS.map((step, index) => (
        <li key={step} className="min-w-0">
          <button
            type="button"
            className={cn(
              "flex w-full min-w-0 cursor-pointer flex-col items-center gap-1.5 rounded-lg px-2 py-2 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring",
              index === currentStep && "text-primary",
            )}
            aria-current={index === currentStep ? "step" : undefined}
            aria-label={`${step}, step ${index + 1}${index < currentStep && summaries[index] ? `, ${summaries[index]}` : ""}`}
            onClick={() =>
              onNavigation(
                resolveWizardNavigation(currentStep, index, ADD_PROVIDER_WIZARD_STEPS.length, {
                  instanceIdError,
                }),
              )
            }
          >
            <span
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full text-sm font-medium ring-1",
                index < currentStep
                  ? "bg-primary text-primary-foreground ring-primary"
                  : index === currentStep
                    ? "bg-primary/10 text-primary ring-primary/30"
                    : "bg-card text-muted-foreground ring-black/10 dark:bg-white/5 dark:ring-white/10",
              )}
              aria-hidden
            >
              {index < currentStep ? <CheckIcon className="size-4 shrink-0" /> : index + 1}
            </span>
            <span
              className={cn(
                "min-w-0 truncate text-[11px] leading-4 font-medium",
                index === currentStep ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {step}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
