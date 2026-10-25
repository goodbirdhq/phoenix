import { afterEach, expect, it, vi } from "vite-plus/test";
import { authConfig, databaseUrl } from "./env";

afterEach(() => vi.unstubAllEnvs());
it("requires a database URL", () => {
  vi.stubEnv("DATABASE_URL", "");
  expect(databaseUrl).toThrow("DATABASE_URL");
});
it("rejects missing, short and example secrets", () => {
  for (const secret of [
    "",
    "short",
    "replace-with-a-random-secret-at-least-32-characters",
    "your-secret-that-is-long-enough-to-pass-length",
  ]) {
    vi.stubEnv("BETTER_AUTH_SECRET", secret);
    expect(authConfig).toThrow("BETTER_AUTH_SECRET");
  }
});
it("accepts a generated secret and explicit origin", () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "df2b5ea3cb204d0d8adb4541631db861");
  vi.stubEnv("BETTER_AUTH_URL", "https://cloud.example.com");
  expect(authConfig().baseURL).toBe("https://cloud.example.com");
});
