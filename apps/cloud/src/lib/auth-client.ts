import { createAuthClient } from "better-auth/react";

// Relative URLs keep cookies and auth requests on the current origin.
export const authClient = createAuthClient();
