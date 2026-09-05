import { useState } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { Button } from "../ui/button";

/** Conceals display text until explicitly revealed; this is presentation, not access control. */
export function ConcealedValue({
  value,
  label = "email",
}: {
  readonly value: string;
  readonly label?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <Button
      variant="ghost"
      size="compact"
      className="h-auto gap-1.5 p-0 text-xs text-muted-foreground"
      onClick={() => setRevealed(!revealed)}
      aria-label={`${revealed ? "Hide" : "Reveal"} ${label}`}
      aria-pressed={revealed}
    >
      {revealed ? (
        <span>{value}</span>
      ) : (
        <span aria-hidden className="select-none blur-[3px]">
          ••••••@••••••
        </span>
      )}
      {revealed ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
    </Button>
  );
}
