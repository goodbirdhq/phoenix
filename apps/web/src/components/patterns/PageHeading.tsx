import type { ReactNode } from "react";

/** Destination title, identity metadata, and actions; wraps on narrow viewports. */
export function PageHeading({
  title,
  icon,
  description,
  actions,
}: {
  readonly title: string;
  readonly icon?: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 space-y-1.5">
        <h1 className="flex items-center gap-2.5 text-[28px] leading-9 font-semibold tracking-[-0.025em] text-foreground">
          {icon && (
            <span
              className="flex size-7 shrink-0 items-center justify-center [&>svg]:size-7"
              aria-hidden
            >
              {icon}
            </span>
          )}
          {title}
        </h1>
        {description && (
          <div className="text-[13px] leading-4 text-muted-foreground">{description}</div>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
