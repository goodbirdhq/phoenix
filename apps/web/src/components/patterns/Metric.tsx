import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export function Metric({
  label,
  value,
  description,
  prominent = false,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly description?: ReactNode;
  readonly prominent?: boolean;
}) {
  return (
    <dl className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs leading-4 text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "font-medium text-foreground tabular-nums",
          prominent ? "text-4xl leading-11 tracking-tight" : "text-base",
        )}
      >
        {value}
      </dd>
      {description && <dd className="text-xs leading-4 text-muted-foreground">{description}</dd>}
    </dl>
  );
}
