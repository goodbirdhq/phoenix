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

### 0. Resolve the entity

Before researching anything, confirm you have the right company. Same-named
companies are common and getting this wrong poisons the whole run.

- Check the CRM first: search Accounts for the name AND the domain. If a row
  exists, its Domain, Source, and Sponsorship evidence are the anchor — they
  say why this prospect made the list at all.
- If more than one company plausibly matches the name, score each against
  the reason we're calling: which one actually does creator/influencer
  marketing? A prospect sourced from sponsorship data that shows zero
  sponsorship evidence is a red flag that you're looking at the wrong
  company, not proof the prospect is unusual.
- If the evidence contradicts the run input (input says one domain, but the
  ICP signals all point to a namesake), research the company the evidence
  points to and say so explicitly at the top of your result: what the input
  said, what you concluded, and why. Never silently obey an input that the
  evidence contradicts — and never silently override it either.

### 1. Research the company

Web search. You're looking for:

- What they sell and who they sell it to.
- Any creator/influencer marketing activity: sponsored posts, ambassador
  programs, YouTube/podcast sponsorships, affiliate programs.
- Recent news that's a plausible conversation opener — funding, a product
  launch, a rebrand, a marketing hire.

If they're clearly not doing any creator marketing, that's a finding too —
it's a reason they might want Goodbird, or a reason this isn't a fit yet
(but see step 0: for a sponsor-sourced prospect it more likely means you
have the wrong company).

When you find a podcast appearance or conference talk by anyone relevant,
don't stop at the episode title — pull the transcript (YouTube transcripts,
the podcast's own page, or a transcript search) and mine it. A 40-minute
interview about how they run marketing is worth more than ten search
snippets, and it's where the specific, quotable material lives.

### 2. Research the person

Run these sweeps in order — each one has caught hooks the others miss:

1. **First-party content — always run this one, and enumerate rather than
   search.** Fetch the company's blog index or sitemap (`/blog`, `/post`,
   `sitemap.xml`), list *every* post carrying the person's name, sort by
   date, and read the most recent. Only then fall back to
   `site:<domain> "<name>"`. This is the sweep that has produced the best
   hook most often, and enumeration is why: people publish their best
   material on their employer's site, where generic search under-ranks it
   because it's fresh and the page has little authority. A search ranking
   will hand you a popular old post; the index hands you last month's.
2. **Recent activity.** `site:linkedin.com/posts "<name>"` plus a
   recency-bounded search (last ~60 days) for the name. A post they wrote
   last month beats a bio from two years ago — it's what they're thinking
   about right now. Expect this to work perhaps half the time: LinkedIn
   blocks direct profile fetches (`HTTP 999`) and indexes posts only
   sporadically. Treat a miss here as "not visible", never as "they don't
   publish" — see `docs/research-sourcing-limits.md`.
3. **Long-form appearances.** Podcasts, talks, interviews — and per step 1,
   read transcripts, don't cite titles.
4. **Background fill.** Clay, for identity resolution, role history and
   verified contact details — it is fast and reliable for all three, and
   worth calling whenever the email is missing. It is *not* a LinkedIn
   reader: it cannot retrieve posts, and its content search returns a
   sampled handful rather than a recency-ranked list, so treat anything it
   returns as a lead to verify, not a finding. Check dates and topical
   relevance before using anything from it, and never carry personal or
   sensitive material into a hook.

If sweeps 1–3 all come back empty, say so plainly in the dossier and fall
back to company-level hooks. A thin person section that admits it is thin is
worth more than one padded with generic bio facts.

You're looking for something specific enough to reference, not just "they
work in marketing." A post they wrote beats a talk they gave beats a bio
fact; something from the last two months beats all three from last year.

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
  one). Walk Status through the three states as you actually reach them:
  "Contact found" once you've identified the person, "Dossier written" once
  the page body is in place, and "Draft ready" once the Gmail draft exists —
  then put the draft link in "Gmail draft". Don't skip ahead: the states are
  what the CRM's views filter on, and a contact sitting at "Contact found"
  with no dossier is a signal the run died, not a tidiness problem.
- **Activity** (data source `01eb2982-56b2-440e-8ae4-4f71b3e2235a`): do NOT
  log research here — Activity rows are real touches (emails actually sent,
  replies, meetings), created when they happen, "Logged by" = Agent.

If Notion is unreachable, don't fail the run: include the full dossier in
the run result instead, and say plainly in the result that Notion wasn't
reachable so it doesn't get lost.

### 4. Draft the email

Write it in Gabriel's voice. This section is distilled from his actual sent
outreach (July–August 2026) — match it, don't approximate it.

**The shape:**

- Greeting: "Hey <first name>," — never "Hi <full name>" or "Dear".
- Subjects: tiny, lowercase, human. "creator question", "advice for a
  founder", "partnership advice". Never clever, never salesy, no title case.
  (A pun like "Playbook 41" is a rare exception — when in doubt, boring.)
- Opener: one warm, _specific_ line that gives before it asks — genuine
  admiration with a concrete detail, ideally with his own credibility woven
  in naturally: "I'm a big fan of what you've built at Revolut. When I ran
  growth at ClearScore, I regularly nicked your ad formats, so thank you
  for the inspo!"
- The ask is framed as curiosity or advice, not a pitch: "Wondered if I
  could ask you for some advice…", "two quick questions", "a very quick
  favour". He asks for perspective and conversation, never "a call to show
  you how we…". No decks, no demos offered in a first email.
- Sign-off: "Gabriel" — or just "G" once there's rapport. Closers are
  light: "Hope you're well!", "Really looking forward to it,", "Chat soon,".

**The sound:** British, warm, quick. Short sentences and fragments.
Dashes and the occasional ellipsis to set up an ask. Exclamation marks
used warmly, not hypey. His words: "lovely", "nicked", "inspo", "fab",
"no worries at all", "pop a placeholder in your diary", "give this a
quick nudge". Cheerfully honest about rough edges ("this is a work in
progress website", "I owe you an update!").

**Never:** corporate padding ("I hope this email finds you well"),
hype adjectives, "quick call to discuss synergies", bullet-pointed value
props, or more than one ask per email.

**Verbatim examples of real sent openers:**

> Hey Annie, I'm a big fan of what you've built at Moneybox. In fact, I
> regularly nicked your ad formats when I ran growth at ClearScore, so
> thanks for the inspiration! I was wondering if I could ask you for some
> advice…

> Hey Ellie, Loyal Starling customer here. I saw you look after
> partnerships and I know Starling has run finfluencer campaigns before.
> Wondered if I could ask you two quick questions…

> Hey Angel, Big fan of what you're building at Trading 212. I was
> wondering if I could ask you for a bit of advice… You guys are
> everywhere on YouTube, so I figured you'd have a unique perspective.

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

Post the run result to the callback exactly as the birdhouse's own
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
- **Budget: ~30 tool calls.** Spend them on the sweeps in steps 0–2 rather
  than re-searching the same angle. If you're at call 25 and still don't
  have enough for a hook, write down what you have and move on — a thin
  dossier beats a burned budget.
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
- **Source priority** — first-party enumeration leads, search follows, Clay
  confirms facts. This was tested on 2026-08-21 rather than assumed: Clay
  was measured against a known-good hook and missed it, so don't promote it
  to a narrative source without re-testing. The open question is LinkedIn
  activity, which none of the current tools can see; the proposed fix is an
  agent-browser link harvester, designed but not built, in
  `docs/research-sourcing-limits.md`.
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
