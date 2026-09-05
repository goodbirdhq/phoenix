import { ConcealedValue } from "../components/patterns/ConcealedValue";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Layers, Moon, Sun } from "lucide-react";
import "../index.css";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { PageHeading } from "../components/patterns/PageHeading";
import { Metric } from "../components/patterns/Metric";
import { LineAreaChart } from "../components/charts/LineAreaChart";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "../components/ui/table";

const periods = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const series = [
  { id: "one", label: "Series one", color: "var(--primary)", values: [4, 12, 6, 20, 8, 16, 10] },
  {
    id: "two",
    label: "Series two",
    color: "var(--muted-foreground)",
    values: [2, 4, 3, 8, 3, 6, 5],
  },
];
function Gallery() {
  const [dark, setDark] = useState(false);
  return (
    <div className={dark ? "dark" : "light"}>
      <main className="min-h-screen bg-background text-foreground">
        <WorkspacePageContainer width="expanded">
          <PageHeading
            title="Component library"
            icon={<Layers />}
            description="Paper patterns · interactive fixtures · no live account data"
            actions={
              <Button variant="outline" onClick={() => setDark(!dark)}>
                {dark ? <Sun /> : <Moon />}
                {dark ? "Light" : "Dark"}
              </Button>
            }
          />
          <Tabs defaultValue="overview">
            <TabsList aria-label="Component examples">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="states">
                States <Badge>3</Badge>
              </TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="space-y-6">
              <div className="grid gap-6 sm:grid-cols-3">
                <Metric prominent label="API cost" value="$76.00" description="Illustrative data" />
                <Metric prominent label="Tokens" value="12.4M" />
                <Metric prominent label="Sessions created" value="76" />
              </div>
              <LineAreaChart
                label="Example sessions created"
                periods={periods}
                series={series}
                format={String}
                formatPeriod={String}
              />
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Environment</TableHead>
                    <TableHead>Installed version</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell>Development</TableCell>
                    <TableCell>Example version</TableCell>
                    <TableCell>
                      <Badge variant="success">Connected</Badge>
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Build server</TableCell>
                    <TableCell>Example version</TableCell>
                    <TableCell>
                      <Badge variant="warning">Update available</Badge>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </TabsContent>
            <TabsContent value="states" className="space-y-6">
              <ConcealedValue value="person@example.com" />
              <div className="flex flex-wrap gap-2">
                <Button>Primary action</Button>
                <Button variant="outline">Secondary action</Button>
                <Button variant="ghost">Quiet action</Button>
                <Button disabled>Unavailable</Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="success">Connected</Badge>
                <Badge variant="warning">Update available</Badge>
                <Badge variant="error">Limit reached</Badge>
              </div>
              <LineAreaChart
                label="No recorded activity"
                periods={periods}
                series={[
                  {
                    id: "empty",
                    label: "No activity",
                    color: "var(--primary)",
                    values: periods.map(() => 0),
                  },
                ]}
                format={String}
                formatPeriod={String}
              />
            </TabsContent>
          </Tabs>
        </WorkspacePageContainer>
      </main>
    </div>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Gallery />);
