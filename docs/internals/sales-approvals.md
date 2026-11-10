# Sales approvals

An approval in Phoenix makes an email go to a stranger, so nothing an agent can
reach may make one. Agents run on the machine that runs the Phoenix server, use
its tools, and can change code it serves. The design follows from that.

## The server cannot approve

The server holds the engine's action token, and the token approves nothing on
its own. An approval is a signature from a device key, and the engine checks it
against a key it enrolled only after a person pressed Approve device on the
key's Slack card. The server only carries signed items to the engine
(`SalesEngineApi.approve`). No MCP tool, scheduled task or other server path
approves, and adding one would need a key the server must never hold.
Unapprove, Edit and Discard take the token alone, because none of them can make
anything go.

## The key never leaves the client

Keys are made with WebCrypto as non-extractable P-256 keys, and the private
half is stored as a `CryptoKey` in IndexedDB
(`packages/client-runtime/src/sales/devices.ts`, `apps/web/src/state/sales.ts`).
A key is only as safe as the code that holds it, so a key must never live in a
client whose code a Phoenix server serves or can change. `salesDeviceBlockedReason`
(`apps/web/src/state/salesDeviceGuard.ts`) refuses both enrolment and signing on
web whenever the client has a `PrimaryConnectionTarget` (a `phoenix` server
served the page), and on desktop whenever a local backend (the primary or a
`local:` one) reads the same engine, or has not reported its settings yet. Keys
are per engine, so the check looks at every environment, not the one on screen,
and signing checks again right before it signs. It cannot see a remote
connection that happens to reach the same machine. The engine plans a
user-verified passkey to make the press itself provable.

## The client hashes what it shows

The engine reports a `contentHash`, and a signature approves exactly that
version. A server that has been tampered with could show one text and pass on
the hash of another. So the client computes the hash itself, from the hash
inputs (`hashInput`) that it also renders, and refuses to sign when the result
differs from the engine's hash or the engine names an algorithm it does not know
(`verifyDisplayedVersion`). Traps that follow from this:

- **Decode the hash inputs untouched.** `SalesHashInput` uses plain strings with
  no trimming, so the text shown is byte for byte the text hashed.
- **Render the hash inputs, not the preview fields.** `displayedDraft` is the
  only source for the approval screen's subject and body.
- **A batch signs only what its review step shows.** A tick records the row's
  hash, and the list hides a tick once the row's hash moves on. Approve N opens
  a review step that reads each ticked draft again and shows its recipient,
  subject and full body from `hashInput`. A draft is signed only when the hash
  recomputed from that text equals both the engine's hash and the ticked one
  (`verifyReviewedVersion`). Any other is shown as changed, unticked, and never
  signed. One confirm press signs the rest. The list's preview fields are never
  evidence of what the person saw.
- **A subject is one line.** A subject with a line break is refused, since a
  one-line field would show it without the break.
- **Never sign again for the person.** A `stale_hash` answer re-reads the card
  and shows it. The next signature needs a new press.
