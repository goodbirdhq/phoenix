import {
  ChartNoAxesColumnIcon,
  FolderIcon,
  LayersIcon,
  LinkIcon,
  ShieldCheckIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs";

const ENVIRONMENT_TABS = [
  { value: "overview", label: "Overview", Icon: ChartNoAxesColumnIcon },
  { value: "projects", label: "Projects", Icon: FolderIcon },
  { value: "providers", label: "Providers", Icon: LayersIcon },
  { value: "connections", label: "Connections", Icon: LinkIcon },
  { value: "access", label: "Access", Icon: ShieldCheckIcon },
] as const;

export function EnvironmentTabs({
  value,
  onChange,
  children,
}: {
  children?: ReactNode;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Tabs value={value} onValueChange={onChange}>
      <TabsList aria-label="Environment sections" className="w-full justify-start gap-6">
        {ENVIRONMENT_TABS.map(({ value, label, Icon }) => (
          <TabsTrigger
            key={value}
            value={value}
            className="gap-[7px] leading-[19px] data-[active]:font-semibold"
          >
            <Icon className="size-4" strokeWidth={1.75} />
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      {children && <TabsContent value={value}>{children}</TabsContent>}
    </Tabs>
  );
}
