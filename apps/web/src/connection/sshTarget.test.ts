import { describe, expect, it } from "vite-plus/test";
import { parseManualDesktopSshTarget } from "./sshTarget";

describe("manual SSH targets", () => {
  it("accepts a user and port in the host field", () => {
    expect(
      parseManualDesktopSshTarget({ host: "builder@build-server:2222", username: "", port: "" }),
    ).toEqual({ alias: "build-server", hostname: "build-server", username: "builder", port: 2222 });
  });
  it("keeps IPv6 hosts intact and explicit fields override inline values", () => {
    expect(
      parseManualDesktopSshTarget({
        host: "builder@[2001:db8::1]:2222",
        username: "reviewer",
        port: "2200",
      }),
    ).toEqual({ alias: "2001:db8::1", hostname: "2001:db8::1", username: "reviewer", port: 2200 });
  });
  it.each(["22oops", "0", "65536", "-1"])("rejects invalid port %s", (port) => {
    expect(() => parseManualDesktopSshTarget({ host: "build-server", username: "", port })).toThrow(
      "SSH port must be between 1 and 65535.",
    );
  });
});
