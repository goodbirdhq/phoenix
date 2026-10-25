import "@tanstack/react-start/server-only";
import { db } from "../db";
import { authConfig } from "./env";
import { createAuth } from "./create-auth";

export const auth = createAuth(db, authConfig());
