import { z } from "zod";

export const displayName = z
  .string()
  .trim()
  .min(1, "Enter a name.")
  .max(80, "Use 80 characters or fewer.");
export const workspaceInput = z.object({ name: displayName });
export const workspaceId = z.object({ id: z.uuid() });
export const renameWorkspaceInput = workspaceId.extend({ name: displayName });
export const installationInput = z.object({
  name: displayName,
  kind: z.enum(["desktop", "remote-server"]),
});
export const loginInput = z.object({
  name: z.string(),
  email: z.email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});
export const signupInput = loginInput.extend({
  name: displayName,
  password: z
    .string()
    .min(12, "Use at least 12 characters.")
    .max(128, "Use 128 characters or fewer."),
});
