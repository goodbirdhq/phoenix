import "@tanstack/react-start/server-only";
export function databaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value)
    throw new Error("Set DATABASE_URL before starting Phoenix Cloud or running migrations.");
  return value;
}

export function authConfig() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (
    !secret ||
    secret.length < 32 ||
    /change.?me|replace|example|placeholder|your[-_ ]?secret/i.test(secret)
  ) {
    throw new Error("Set BETTER_AUTH_SECRET to a random secret of at least 32 characters.");
  }
  return { secret, baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3100" };
}
