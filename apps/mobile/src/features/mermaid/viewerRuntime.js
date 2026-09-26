import mermaid from "mermaid";

const stage = document.getElementById("stage");
let source = "";
let theme = "light";
let scale = 1;
let offsetX = 0;
let offsetY = 0;
let drag = null;

function report(type, error) {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type, error }));
}

function transform() {
  const svg = stage.querySelector("svg");
  if (svg) svg.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
}

function fit() {
  const svg = stage.querySelector("svg");
  if (!svg) return;
  const box = svg.getBBox();
  const width = box.width || Number(svg.getAttribute("width")) || 1;
  const height = box.height || Number(svg.getAttribute("height")) || 1;
  scale = Math.min(1, (stage.clientWidth - 32) / width, (stage.clientHeight - 32) / height);
  offsetX = 0;
  offsetY = 0;
  transform();
}

function sanitize(svgText) {
  const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
  if (parsed.querySelector("parsererror") || parsed.documentElement.localName !== "svg")
    throw new Error("Invalid SVG output");
  const root = parsed.documentElement;
  for (const node of [...root.querySelectorAll("*")]) {
    const name = node.localName.toLowerCase();
    if (
      [
        "script",
        "foreignobject",
        "image",
        "use",
        "animate",
        "animatemotion",
        "animatetransform",
        "set",
      ].includes(name)
    ) {
      node.remove();
      continue;
    }
    if (name === "a") {
      node.replaceWith(...node.childNodes);
      continue;
    }
    if (name === "style") {
      node.textContent = node.textContent
        .replace(/@import[^;]*;/gi, "")
        .replace(/url\(\s*(?!['\"]?#)[^)]*\)/gi, "none");
    }
    for (const attr of [...node.attributes]) {
      const key = attr.name.toLowerCase();
      const value = attr.value;
      if (
        key.startsWith("on") ||
        key === "href" ||
        key.endsWith(":href") ||
        key === "src" ||
        key === "srcset" ||
        /url\(\s*(?!['\"]?#)/i.test(value) ||
        /javascript:/i.test(value)
      )
        node.removeAttribute(attr.name);
    }
  }
  for (const attr of [...root.attributes]) {
    const key = attr.name.toLowerCase();
    if (
      key.startsWith("on") ||
      key === "href" ||
      key.endsWith(":href") ||
      key === "src" ||
      /url\(\s*(?!['\"]?#)/i.test(attr.value) ||
      /javascript:/i.test(attr.value)
    )
      root.removeAttribute(attr.name);
  }
  return document.importNode(root, true);
}

async function render() {
  stage.replaceChildren();
  if (new TextEncoder().encode(source).length > 131072) {
    report("error", "Diagram source exceeds 128 KiB.");
    return;
  }
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: false,
      maxTextSize: 131072,
      maxEdges: 500,
      theme: theme === "dark" ? "dark" : "default",
    });
    const { svg } = await mermaid.render(`diagram-${Date.now()}`, source);
    stage.appendChild(sanitize(svg));
    requestAnimationFrame(fit);
    report("rendered");
  } catch (error) {
    stage.replaceChildren();
    report("error", error instanceof Error ? error.message : String(error));
  }
}

window.receiveMermaid = (payload) => {
  if (!payload || typeof payload !== "object") return;
  if (payload.type === "render" && typeof payload.source === "string") {
    source = payload.source;
    theme = payload.theme === "dark" ? "dark" : "light";
    void render();
  } else if (payload.type === "fit") fit();
  else if (payload.type === "reset") {
    scale = 1;
    offsetX = 0;
    offsetY = 0;
    transform();
  } else if (payload.type === "zoom") {
    scale = Math.max(0.1, Math.min(8, scale * (payload.factor === 0.8 ? 0.8 : 1.25)));
    transform();
  }
};

stage.addEventListener("pointerdown", (event) => {
  drag = { x: event.clientX, y: event.clientY };
  stage.setPointerCapture(event.pointerId);
});
stage.addEventListener("pointermove", (event) => {
  if (!drag) return;
  offsetX += event.clientX - drag.x;
  offsetY += event.clientY - drag.y;
  drag = { x: event.clientX, y: event.clientY };
  transform();
});
stage.addEventListener("pointerup", () => {
  drag = null;
});
stage.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    scale = Math.max(0.1, Math.min(8, scale * (event.deltaY > 0 ? 0.8 : 1.25)));
    transform();
  },
  { passive: false },
);
report("ready");
