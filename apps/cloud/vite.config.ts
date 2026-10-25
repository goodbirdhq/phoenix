import * as NodeURL from "node:url";
import { defineConfig, loadEnv } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ""));
  return {
    resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("./src", import.meta.url)) } },
    server: {
      port: 3100,
      strictPort: true,
      allowedHosts: [new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3100").hostname],
    },
    plugins: [tailwindcss(), tanstackStart(), nitro(), react()],
  };
});
