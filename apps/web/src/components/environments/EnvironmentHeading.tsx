import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export function EnvironmentHeading({
  title,
  icon,
  description,
  status,
  connected,
  actions,
}: {
  title: string;
  icon: ReactNode;
  description: string;
  status: string;
  connected: boolean;
  actions: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-center gap-5">
      <div className="min-w-0 basis-full flex-1 space-y-2 sm:basis-0">
        <h1 className="environment-inter flex items-center [&_svg]:shrink-0 gap-3 text-[28px] leading-9 font-semibold">
          {icon}
          <span className="truncate">{title}</span>
        </h1>
        <p className="text-[13px] leading-[19px] text-muted-foreground">{description}</p>
      </div>
      <span
        className={cn(
          "flex items-center gap-1 text-xs leading-[18px] font-medium",
          connected ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground",
        )}
      >
        <span className="size-[11px] rounded-full bg-current" />
        {status}
      </span>
      {actions}
    </header>
  );
}
