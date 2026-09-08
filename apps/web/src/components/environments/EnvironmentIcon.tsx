import { LaptopIcon, MonitorIcon, ServerIcon } from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useClientSettings } from "../../hooks/useSettings";

export const ENVIRONMENT_ICONS = { laptop: LaptopIcon, desktop: MonitorIcon, server: ServerIcon };
export type EnvironmentIconKind = keyof typeof ENVIRONMENT_ICONS;

export function EnvironmentIcon({
  environmentId,
  className = "size-[18px]",
}: {
  environmentId: EnvironmentId;
  className?: string;
}) {
  const appearance = useClientSettings((settings) => settings.environmentAppearance[environmentId]);
  const Icon = ENVIRONMENT_ICONS[appearance?.icon ?? "desktop"];
  return <Icon aria-hidden className={className} strokeWidth={1.5} />;
}
