import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(root, "../src/features/mermaid/viewerAsset.json");
const bundled = await build({
  entryPoints: [path.resolve(root, "../src/features/mermaid/viewerRuntime.js")],
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  write: false,
  logLevel: "silent",
});
const script = bundled.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const hash = createHash("sha256").update(script).digest("base64");
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>html,body,#stage{margin:0;width:100%;height:100%;overflow:hidden}body{background:transparent}#stage{display:flex;align-items:center;justify-content:center;touch-action:none}svg{max-width:none!important;max-height:none!important;transform-origin:center center}</style></head><body><div id="stage"></div><script>${script}</script></body></html>`;
if (/https?:\/\//i.test(html.slice(0, html.indexOf("<script>"))))
  throw new Error("Remote viewer resource");
const encoded = `${JSON.stringify(html)}\n`;
if (process.argv.includes("--check")) {
  if ((await readFile(output, "utf8")) !== encoded)
    throw new Error("Mermaid viewer asset is missing or stale");
} else await writeFile(output, encoded);
