import { useState } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { InlineButton } from "../ui/button";

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
    <InlineButton
      tone="muted"
      onClick={() => setRevealed(!revealed)}
      aria-label={`${revealed ? "Hide" : "Reveal"} ${label}`}
      aria-pressed={revealed}
    >
      <span className="flex items-center gap-1.5 text-xs">
        {revealed ? (
          <span>{value}</span>
        ) : (
          <span aria-hidden className="select-none blur-xs">
            ••••••@••••••
          </span>
        )}
        {revealed ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
      </span>
    </InlineButton>
  );
}
