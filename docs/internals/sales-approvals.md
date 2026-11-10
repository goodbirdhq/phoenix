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
A key is only as safe as the code that holds it, so a client the agents' machine
can change must not enrol one: the web UI that machine serves, or a desktop app
whose own backend is that machine. `salesEnrolmentBlockedReason` refuses
enrolment when the Sales environment's connection is local. It cannot see a
remote connection that happens to reach the same machine. The engine plans a
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
- **A batch signs from the list.** Each checked row is read again and signed
  only when it still has the listed hash and its preview agrees with the hashed
  body (`listedVersionMatches`).
- **Never sign again for the person.** A `stale_hash` answer re-reads the card
  and shows it. The next signature needs a new press.
