import { type HiddenTextFinding, markHiddenText } from "@t3tools/client-runtime/sales/hidden-text";

/**
 * A draft field as hashed, with each hidden-text finding shown as a visible token in its place.
 * With no findings it is the text exactly, so a clean draft reads as it is signed.
 */
export function SalesMarkedText(props: {
  readonly text: string;
  readonly findings: ReadonlyArray<HiddenTextFinding>;
}) {
  if (props.findings.length === 0) return props.text;
  let at = 0;
  return markHiddenText(props.text, props.findings).map((segment) => {
    // A segment's offset in the field is unique and stable while the field is.
    const key = at;
    at += segment.text.length;
    return segment.token === null ? (
      segment.text
    ) : (
      <mark
        key={key}
        className="rounded-sm bg-warning/15 px-0.5 font-mono text-xs text-warning-foreground"
      >
        {segment.token}
      </mark>
    );
  });
}
