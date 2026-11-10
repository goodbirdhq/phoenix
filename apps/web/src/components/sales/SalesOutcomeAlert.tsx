import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";

/** The engine's answer to an action on one row, under the row. `children` follow the words. */
export function SalesOutcomeAlert(props: {
  readonly outcome: {
    readonly tone: "success" | "warning" | "error";
    readonly title: string;
    readonly description: string;
  };
  readonly children?: ReactNode;
}) {
  const { outcome, children } = props;
  return (
    <Alert variant={outcome.tone}>
      <AlertTitle>{outcome.title}</AlertTitle>
      {outcome.description || children ? (
        <AlertDescription>
          {outcome.description}
          {children}
        </AlertDescription>
      ) : null}
    </Alert>
  );
}
