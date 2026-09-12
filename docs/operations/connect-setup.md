# T3 Connect setup

Deployment and client configuration for T3 Connect. The [architecture note](../internals/t3-connect.md)
explains the trust boundaries; the [relay README](../../infra/relay/README.md#deployment) owns relay
provisioning instructions.

## Public application configuration

T3 Connect is disabled in a fresh clone. To build against the production deployment, copy the
repository-root example:

```sh
cp .env.example .env
```

For another deployment, set these values in the repository-root `.env` or `.env.local`:

```dotenv
T3CODE_CLERK_PUBLISHABLE_KEY=<publishable key>
T3CODE_CLERK_JWT_TEMPLATE=<JWT template name>
T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=<public OAuth application client ID>
T3CODE_RELAY_URL=https://relay.example.com
```

Process variables take precedence over `.env.local`, then `.env`. Use these canonical names;
the build loader supplies framework-specific aliases. These values are public identifiers.
`CLERK_SECRET_KEY` belongs only in the relay's secrets, never in client configuration.

Client and bundled-server builds embed the public values, so set them before building.
EAS preview and production environments need the publishable key, JWT template name, and relay URL.
Bundled servers also accept runtime overrides for operator-managed deployments.

Copy `infra/relay/.env.example` to `infra/relay/.env` for relay deployment settings.
Deploy `prod` before personal stages because it owns the retained database that their branches
depend on. The deploy wrapper writes the resulting relay URL back to the root `.env`.

## Headless CLI OAuth application

The `phoenix connect` commands authorize a headless environment with a separate Clerk OAuth
application. This uses an OAuth public client with PKCE, so the CLI stores no client secret.

In **Clerk Dashboard > OAuth applications**:

1. Create a public OAuth application for the Phoenix CLI, using authorization-code exchange with PKCE.
2. Add **both** allowed redirect URIs:
   - `http://127.0.0.1:34338/callback` for the loopback listener;
   - `https://app.t3.codes/connect/callback` for the hosted out-of-band flow. This is
     `connectCallbackUrl(DEFAULT_HOSTED_APP_URL)` from `packages/shared/src/connectAuth.ts`, so a
     custom `T3CODE_HOSTED_APP_URL` means `$T3CODE_HOSTED_APP_URL/connect/callback` instead.
     Omitting it breaks headless and SSH authorization.
3. Enable the `openid`, `profile`, and `email` scopes.
4. Set `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` in the repository-root `.env` file and release build
   environment to the generated public client ID.

Both CLI flows start at the hosted `/connect` page (`buildConnectAuthorizeRequestUrl` in
`packages/shared/src/connectAuth.ts`), which waits for a Clerk session and then forwards the request
to Clerk's `/oauth/authorize`. The CLI never opens `/oauth/authorize` directly: a signed-out browser
sent there goes through Clerk's sign-in redirect, which drops the authorize query parameters and
fails the flow with `unsupported_response_type` or an empty `state`. The loopback flow marks the
request with a `port` fragment parameter so the hosted page asks Clerk to redirect the authorization
code straight to `http://127.0.0.1:<port>/callback`; the out-of-band flow omits it and uses the
hosted `/connect/callback` page instead. The CLI derives Clerk's frontend API URL from the
publishable key and calls only the `/oauth/token` endpoint directly. The relay is not involved in
the OAuth handshake; it only validates the issued Clerk bearer token when the CLI manages an
environment link.

The connect command group is:

```sh
phoenix connect            # default: onboarding
phoenix connect login
phoenix connect link       # --publish-only
phoenix connect status     # --json
phoenix connect publish    # --disable
phoenix connect unlink
phoenix connect logout
```

`phoenix serve` is a separate top-level command, not a connect subcommand.

`phoenix connect login` opens the Clerk authorization flow and stores the CLI credential without
enabling cloud exposure. `phoenix connect link` installs the pinned managed `cloudflared` binary
when needed, authorizes when needed, and records durable intent to expose the environment. It works
without a running Phoenix server. The next `phoenix serve` or `phoenix start` reconciles the relay
link and launches the managed tunnel. `phoenix connect unlink` records disabled intent immediately,
stops a reachable running connector, and attempts to revoke the relay-side environment record. It
retains the stored CLI authorization so `phoenix connect link` can re-enable exposure without
another browser flow. `phoenix connect logout` performs the same cleanup and removes the stored CLI
authorization.

The background service has an independent lifecycle. Connect setup may offer to install it, but
logout leaves it running; manage it with `phoenix service status`, `install`, `update`, and
`uninstall`.

### Headless and SSH authorization

The loopback OAuth callback listener binds to port `34338`. That path only works when a browser on
the same machine can reach it, so `authorizeCli` in `apps/server/src/cli/connect.ts` automatically
selects the out-of-band flow when `--headless` is passed or when it detects SSH through
`SSH_CONNECTION` or `SSH_TTY`. The out-of-band flow prints the hosted `/connect` authorization URL
and accepts a pasted authorization code, so no port is involved.

Port forwarding is therefore optional, not required. Forward the port only if you specifically want
the loopback flow over SSH:

```sh
ssh -L 34338:127.0.0.1:34338 <host>
```

## JWT template

Create a Clerk JWT template named `t3-relay` with claims:

```json
{ "aud": "t3-code-relay" }
```

Set `T3CODE_CLERK_JWT_TEMPLATE=t3-relay` for clients and
`CLERK_JWT_AUDIENCE=t3-code-relay` for the relay. The production relay deployment environment
also defines `CLERK_JWT_TEMPLATE`. The audience stays the same across relay stages; the relay
URL selects the deployment.

## Desktop OAuth redirects

Enable Clerk's Native API and add the desktop redirects to its SSO redirect allowlist:

```text
phoenix-dev://app/
phoenix://app/
```

Add the corresponding origin to the Clerk instance's Backend API `allowed_origins` array.
Development uses `phoenix-dev://app`; production uses `phoenix://app`. Update the array with
`PATCH https://api.clerk.com/v1/instance` using the Clerk secret key, preserving existing entries:

```sh
curl -X PATCH https://api.clerk.com/v1/instance \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  -d '{"allowed_origins":["phoenix://app"]}'
```

Never put `CLERK_SECRET_KEY` in the desktop app, a client-facing environment file, or a build
artifact. The Clerk Electron integration handles token persistence and system-browser callback
delivery for initial sign-in and linked-account flows.

The current mobile UI uses Clerk's native authentication view. If a future mobile browser OAuth
flow uses a custom redirect URI, add that exact URI to the same allowlist.

## Android native sign-in redirects

Clerk's native Android SDK uses `clerk://<applicationId>.callback`. In the Clerk instance selected
by the app's publishable key, add each supported package to **Native applications > Allowlist for
mobile SSO redirect**:

| Variant     | Callback                                        |
| ----------- | ----------------------------------------------- |
| Development | `clerk://com.goodbird.phoenix.dev.callback`     |
| Preview     | `clerk://com.goodbird.phoenix.preview.callback` |
| Production  | `clerk://com.goodbird.phoenix.callback`         |

Preserve existing entries. These callbacks are separate from the `phoenix-dev` / `phoenix-preview` /
`phoenix` navigation schemes. A private development build using the production Clerk key still
needs its development callback allowed by that instance's administrator; rebuilding the same package
does not change the allowlist.

## Sign-in surfaces

Signed-in users manage T3 Connect under **Connections**. The settings sidebar also has dedicated
controls, rendered by `SettingsSidebarNav.tsx`: `T3ConnectSidebarSignIn` in the footer shows a
**Sign in to T3 Connect** button while signed out, and `T3ConnectSidebarAvatar` shows a Clerk
`UserButton` account control while signed in. Both are gated on cloud public configuration.
Desktop renders the same web bundle, so it has them too. The waitlist enrollment flow from the
private beta was removed when Connect went GA; sign-up is open unless a Clerk restriction below is
enabled.

## Restricting sign-ups

For a closed deployment where all permitted users are known in advance, restrict sign-up to
permitted email addresses or domains:

1. In **Clerk Dashboard > Restrictions > Allowlist**, add each permitted email address or email
   domain.
2. Enable the allowlist and save.
3. Alternatively, enable **Restricted mode** when all new users must be explicitly invited or
   manually created.

Do not enable an empty allowlist: it blocks all new sign-ups.

Clerk allowlists control who can sign up. They do not revoke an existing user's active cloud
access. To remove an already-created user's access, ban that user in Clerk so their active
sessions are ended and future sign-ins are rejected.
