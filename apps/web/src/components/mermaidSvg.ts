const SVG_NS = "http://www.w3.org/2000/svg";
const SAFE_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "marker",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "title",
  "desc",
  "style",
]);
const SAFE_ATTRIBUTES = new Set([
  "xmlns",
  "viewBox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "points",
  "d",
  "transform",
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "font-size",
  "font-family",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  "marker-start",
  "marker-mid",
  "marker-end",
  "offset",
  "stop-color",
  "stop-opacity",
  "clip-path",
  "class",
  "id",
  "preserveAspectRatio",
  "role",
  "aria-label",
  "style",
]);

function hasUnsafeCss(value: string): boolean {
  if (/@import|@font-face|expression\s*\(|behavior\s*:/i.test(value)) return true;
  return Array.from(value.matchAll(/url\s*\(([^)]*)\)/gi)).some(
    (match) => !/^#[\w.-]+$/.test((match[1] ?? "").trim().replace(/^['"]|['"]$/g, "")),
  );
}

/** SVG is displayed in a scriptless, network-blocked frame as a second boundary. */
export function sanitizeMermaidSvg(svg: string): string {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;
  if (
    root.localName !== "svg" ||
    root.namespaceURI !== SVG_NS ||
    document.getElementsByTagName("parsererror").length > 0
  ) {
    throw new Error("Mermaid returned an invalid diagram.");
  }

  function clean(node: Element): void {
    if (node.localName === "style" && hasUnsafeCss(node.textContent ?? "")) {
      node.parentNode?.removeChild(node);
      return;
    }
    for (const child of Array.from(node.children)) {
      if (child.namespaceURI !== SVG_NS || !SAFE_ELEMENTS.has(child.localName)) {
        // Keep link labels while removing their interactive wrapper.
        if (child.localName === "a") {
          while (child.firstChild) {
            const grandchild = child.firstChild;
            node.insertBefore(grandchild, child);
            if (grandchild.nodeType === 1) {
              const element = grandchild as Element;
              if (element.namespaceURI === SVG_NS && SAFE_ELEMENTS.has(element.localName))
                clean(element);
              else node.removeChild(element);
            }
          }
          node.removeChild(child);
        } else {
          node.removeChild(child);
        }
      } else {
        clean(child);
      }
    }
    for (const attribute of Array.from(node.attributes)) {
      const value = attribute.value;
      if (
        attribute.namespaceURI ||
        !SAFE_ATTRIBUTES.has(attribute.name) ||
        hasUnsafeCss(value) ||
        /[<>]/.test(value)
      ) {
        node.removeAttributeNode(attribute);
      }
    }
  }

  clean(root);
  // Mermaid puts its intrinsic width in an inline max-width, which prevents
  // the viewer's fit-to-canvas SVG from growing to the available space.
  root.removeAttribute("style");
  root.setAttribute("xmlns", SVG_NS);
  root.setAttribute("width", "100%");
  root.setAttribute("height", "100%");
  return new XMLSerializer().serializeToString(root);
}
