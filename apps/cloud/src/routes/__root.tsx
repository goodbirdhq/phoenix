import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import styles from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Phoenix Cloud" },
      { name: "description", content: "A home for your Phoenix workspaces and devices." },
    ],
    links: [{ rel: "stylesheet", href: styles }],
  }),
  shellComponent: ({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  ),
  component: Outlet,
  notFoundComponent: () => (
    <main className="page-message">
      <h1>Page not found</h1>
      <Link to="/">Go home</Link>
    </main>
  ),
  errorComponent: ({ reset }) => (
    <main className="page-message">
      <h1>Something went wrong</h1>
      <p>Please try again. If this continues, check your connection.</p>
      <Button onClick={reset}>Try again</Button>
    </main>
  ),
});
