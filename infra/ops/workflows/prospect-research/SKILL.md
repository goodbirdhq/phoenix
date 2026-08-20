# Prospect research

## Objective

Research one prospect and produce three things:

1. A dossier: what the company does, what they're doing in creator/influencer
   marketing, and what's worth mentioning about the specific person.
2. A skeleton outreach email, saved as a Gmail draft — never sent.
3. A record of both, so Gabriel can find them without digging through a
   transcript.

This is for Goodbird outreach. Goodbird runs creator marketing for B2B tech
companies. The prospect is usually the person who owns influencer or
creator-marketing decisions at a target company — sometimes marketing more
broadly if there's no dedicated owner.

## Inputs

You'll get a run input shaped like:

```json
{
  "prospect": {
    "company": "Acme Corp",
    "domain": "acme.com",
    "contactName": "Jordan Lee",
    "contactTitle": "Head of Influencer Marketing",
    "linkedinUrl": "https://linkedin.com/in/jordanlee"
  },
  "notionPageUrl": "https://notion.so/..."
}
```

Only `prospect.company` is guaranteed. Everything else — domain, contact
name/title, LinkedIn — may be missing; find what you can, don't fail because
a field is empty. `notionPageUrl` points at an existing prospect page to
update; if it's absent, you're creating one from scratch.

## Steps

### 1. Research the company

Web search. You're looking for:

- What they sell and who they sell it to.
- Any creator/influencer marketing activity: sponsored posts, ambassador
  programs, YouTube/podcast sponsorships, affiliate programs.
- Recent news that's a plausible conversation opener — funding, a product
  launch, a rebrand, a marketing hire.

If they're clearly not doing any creator marketing, that's a finding too —
it's a reason they might want Goodbird, or a reason this isn't a fit yet.

### 2. Research the person

Web search first — LinkedIn profile and posts, podcast appearances,
articles, conference talks. If the Clay MCP is available, use it to enrich
what you already have (role history, verified contact details) rather than
as your primary source — it's better at confirming facts than finding a
narrative.

You're looking for something specific enough to reference, not just "they
work in marketing." A talk they gave, a post they wrote, a campaign they ran
elsewhere.

### 3. Write the dossier

Structure:

- **Company snapshot** — what they sell, who to, recent creator/influencer
  activity.
- **Person snapshot** — role, background, anything specific and recent.
- **Hooks / angles** — one to three concrete openers for outreach, each
  tied to something you found, not generic.
- **Risk flags** — anything that should slow this down: they just laid off
  their marketing team, a competitor already has this contact's ear, the
  company's too small/large for the ICP, etc. Leave this section empty if
  there's nothing worth flagging — don't invent a risk to fill it.

Write this into the **Goodbird CRM** in Notion (parent page
`3c2ada73-e530-81e1-97ab-e7d50523c82c`):

- **Accounts** (data source `99e47d6b-a6dd-457d-bf01-1c2e2d8dbcd8`): upsert
  the firm — search by name/domain first, never create a duplicate. Fill
  firmographics (Industry, Employees, HQ, ICP, Sponsorship evidence) and set
  Stage to "Researching" if it's currently "New".
- **Contacts** (data source `402355f7-31d6-4e17-8611-3c8a4d05d125`): upsert
  the person, relate them to the Account, and write the dossier as the
  contact page's **body** (update `notionPageUrl`'s page if you were given
  one). Set Status to "Researched", then "Draft ready" once the Gmail draft
  exists, and put the draft link in "Gmail draft".
- **Activity** (data source `01eb2982-56b2-440e-8ae4-4f71b3e2235a`): do NOT
  log research here — Activity rows are real touches (emails actually sent,
  replies, meetings), created when they happen, "Logged by" = Agent.

If Notion is unreachable, don't fail the run: include the full dossier in
the run result instead, and say plainly in the result that Notion wasn't
reachable so it doesn't get lost.

### 4. Draft the email

Short: 5–8 sentences, no more. One hook from your research — the best one,
not all of them. No flattery that isn't earned by something you actually
found ("I loved your recent post" is fine if you read it and can say what
was in it; "I've been following your work" is not). Leave `[PERSONAL
TOUCH]` markers wherever Gabriel's own voice should go — the close, and
anywhere a generic line would otherwise sit.

Create it as a Gmail draft via the Gmail MCP `create_draft` tool. Never send
it, never use `send_message`. This is scaffolding for Gabriel to rewrite,
not a finished email.

### 5. Report the result

Post the run result to the callback exactly as the ops hub's own
instructions (appended after this skill in your prompt) describe — don't
duplicate that protocol here, just follow it. Include in the result:

- The Notion page URL (or the inline dossier, if Notion wasn't reachable).
- The Gmail draft id.
- A one-line summary of the best hook you found.

## Constraints

- **Never send email.** Draft only. If you're ever unsure whether an action
  counts as sending, don't do it.
- **Shadow mode means no writes at all.** If the run prompt says you're in
  shadow mode, don't create the Notion page or the Gmail draft — write out
  what you would have created (the dossier text, the email text) in the
  result's `shadowedEffects`, as instructed by the shadow-mode instructions
  in your prompt.
- **Budget: ~15 tool calls.** This is a research task, not an investigation.
  If you're at call 12 and still don't have enough for a hook, write down
  what you have and move on — a thin dossier beats a burned budget.
- **UK English** in everything you write (dossier, email, result).

## Tuning notes for Gabriel

The knobs you'll most likely want to turn:

- **Dossier depth** — step 3 above is deliberately light. If dossiers come
  back too thin, add detail to what "hooks" or "risk flags" should cover.
  If they come back bloated, cut sections rather than asking for brevity in
  the abstract — the model follows structure better than instructions to
  "be concise."
- **Email voice** — step 4 gives the shape (length, one hook, `[PERSONAL
TOUCH]` markers) but not a voice. If drafts read wrong, the fix is
  probably a short example email pasted straight into this file, not more
  rules.
- **Source priority** — right now web search leads and Clay confirms. If
  Clay turns out to have better narrative data than search for your ICP,
  swap the order in step 2.
- **Which Notion database** — the Goodbird CRM (Accounts / Contacts /
  Activity) created 2026-08-20; ids are in step 3. If you restructure the
  CRM, update the ids and conventions there.

To edit this workflow: change this file and `manifest.json` directly, they're
plain files under version control. To add a schedule (e.g. run nightly on
unresearched rows), add an entry to `manifest.json`'s `schedules` array:

```json
{ "cron": "0 6 * * 1-5", "timezone": "Europe/London" }
```

That's 6am UK time, Monday to Friday. The scheduler picks up manifest
changes on its next tick — no restart needed. New workflows (this one
included) start in `shadow` mode; see the README's "Adding a workflow"
section for how to flip it live once you trust the output.
