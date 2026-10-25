import { createFileRoute } from "@tanstack/react-router";
import { PhoenixCloudBrowserReturn } from "../components/PhoenixCloudBrowserReturn";

export const Route = createFileRoute("/cloud/callback")({ component: PhoenixCloudBrowserReturn });
