import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Dialog, DialogPopup, DialogTitle } from "./ui/dialog";
import { sanitizeMermaidSvg } from "./mermaidSvg";

const MAX_SOURCE_BYTES = 128 * 1024;
let nextDiagramId = 0;

export async function renderMermaid(source: string, theme: "light" | "dark"): Promise<string> {
  if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
    throw new Error("Diagram source exceeds 128 KiB.");
  }
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    maxTextSize: 131072,
    maxEdges: 500,
    theme: theme === "dark" ? "dark" : "default",
  });
  const { svg } = await mermaid.render(`phoenix-mermaid-${++nextDiagramId}`, source);
  return sanitizeMermaidSvg(svg);
}

export function MermaidViewer({
  source,
  open,
  onClose,
  theme,
}: {
  source: string;
  open: boolean;
  onClose: () => void;
  theme: "light" | "dark";
}) {
  const [result, setResult] = useState<{ svg?: string; error?: string }>({});
  const [showSource, setShowSource] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [returnFocusTarget] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    if (!open) return;
    let current = true;
    setResult({});
    void renderMermaid(source, theme).then(
      (svg) => {
        if (current) setResult({ svg });
      },
      (error: unknown) => {
        if (current)
          setResult({
            error: error instanceof Error ? error.message : "Could not render diagram.",
          });
      },
    );
    return () => {
      current = false;
    };
  }, [source, theme, open]);

  const fit = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };
  const frame = result.svg
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; connect-src 'none'; font-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}svg{display:block;width:100%;height:100%}</style>${result.svg}`
    : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogPopup
        className="flex h-[min(88vh,900px)] w-[min(94vw,1200px)] max-w-none flex-col gap-3 p-4"
        showCloseButton={false}
        finalFocus={() => returnFocusTarget}
      >
        <div className="flex flex-wrap items-center gap-2 pr-8">
          <DialogTitle className="mr-auto text-base font-semibold">Mermaid diagram</DialogTitle>
          <Button size="sm" variant="outline" onClick={fit}>
            Fit
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setZoom((value) => Math.min(value * 1.25, 8))}
          >
            Zoom in
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setZoom((value) => Math.max(value / 1.25, 0.25))}
          >
            Zoom out
          </Button>
          <Button size="sm" variant="outline" onClick={fit}>
            Reset
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowSource((value) => !value)}>
            {showSource ? "Show diagram" : "Show source"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigator.clipboard.writeText(source)}
          >
            Copy source
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
        {showSource || result.error ? (
          <div className="min-h-0 flex-1 overflow-auto rounded border border-border p-3">
            {result.error ? (
              <p role="alert" className="mb-3 text-destructive">
                {result.error}
              </p>
            ) : null}
            <pre className="whitespace-pre-wrap break-words text-xs select-text">{source}</pre>
          </div>
        ) : result.svg ? (
          <div
            className="min-h-0 flex-1 overflow-hidden rounded border border-border bg-background"
            aria-label="Diagram canvas"
            onPointerDown={(event) => {
              drag.current = { x: event.clientX - pan.x, y: event.clientY - pan.y };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (drag.current)
                setPan({ x: event.clientX - drag.current.x, y: event.clientY - drag.current.y });
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            <iframe
              title="Mermaid diagram"
              sandbox=""
              srcDoc={frame}
              tabIndex={-1}
              className="h-full w-full pointer-events-none"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center" role="status">
            Rendering diagram…
          </div>
        )}
      </DialogPopup>
    </Dialog>
  );
}
