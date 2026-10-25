import { createFileRoute } from "@tanstack/react-router";
import { auth } from "~/server/auth";

function handle(request: Request) {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace("/api/installations/", "/api/auth/installation/");
  return auth.handler(new Request(url, request));
}

export const Route = createFileRoute("/api/installations/$")({
  server: {
    handlers: { GET: ({ request }) => handle(request), POST: ({ request }) => handle(request) },
  },
});
