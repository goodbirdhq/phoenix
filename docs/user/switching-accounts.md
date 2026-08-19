# Switching accounts mid-thread

This guide is for people who run more than one subscription in Phoenix — two Claude accounts, a
Claude and a Codex, or any mix — and want a thread to keep going when an account runs out of
room. For adding a second account, see [Claude](./providers-claude.md) and
[Codex](./providers-codex.md).

## Move a thread to another account

Open the model picker on any thread and pick a model from a different account or provider.
Phoenix migrates the thread in place: the conversation, history, and checkpoints stay exactly
where they are, and the next turn runs on the account you picked. The migration is recorded in
the thread's history so you can always see which account did which work.

When you migrate, Phoenix asks how to hand the conversation over:

- **Replay** rebuilds the conversation from Phoenix's own record and hands it to the new
  account. It always works, even when the old account is fully rate-limited.
- **Brief** asks the agent on the old account to write a short handoff summary first, then
  starts the new account from that summary. It reads better on very long threads, but it
  spends one more turn on the old account — so it's only offered while that account still has
  credit.

Migration waits for the current turn: while an agent is actively working you can't pull the
thread out from under it. Interrupt the turn first, or let it finish.

## When an account hits its limit

If a turn fails because the account behind it hit its usage window, the thread shows what
happened and offers the way out:

- **Switch and retry** moves the thread to the account you choose and re-runs the failed turn.
- **Switch only** moves the thread and leaves the next step to you.
- **Switch all chats on this account** moves every active thread off the limited account in
  one go.

The message includes when the window resets, so you can also just wait it out.

## The early warning

When an account passes 90% of a usage window, threads bound to it show a small warning with
the account name and the reset time. That's your cue to hand off with a brief while the
account can still write one, or to finish the turn you're on before the wall.

## Failover groups

If you keep interchangeable accounts — say two Claude subscriptions that are both yours —
put them in a failover group. When a grouped account hits its limit mid-thread, Phoenix
switches the thread to the group member with the most room left, retries the failed turn,
and leaves a note in the chat saying what it did. No click required.

Groups are deliberately narrow:

- Only accounts of the same provider can share a group.
- Accounts you never group never switch automatically. Keep work and personal accounts
  ungrouped and they will only ever move when you move them.
- After the limited account's window resets, threads stay where they landed. Migrating back
  is one trip to the model picker.

Auto-failover only fires on a genuine usage limit. Any other kind of error still shows as an
error — Phoenix won't burn a second account retrying a turn that failed for a different
reason.
