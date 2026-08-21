# Research sourcing: what the prospect-research flow can and cannot see

Measured on the 2026-08-21 batch (ElevenLabs, Figma, Jobber, Xsolla, Airwallex)
plus the 2026-08-20 Wispr and Viktor runs. This documents where person-level
hooks actually come from, so the next person tuning `prospect-research`
doesn't re-derive it.

## The short version

Person-level hooks came back thin in three of five runs. The cause is not one
blocked site — it is that **the best material is usually recent, and recency is
exactly what third-party indexes are worst at**. The sweep that works is
enumeration (fetch the index, sort by date); the sweeps that fail are the ones
that rely on someone else's ranking.

## What works

**First-party blog enumeration — the highest-value sweep.** On the Wispr run
the agent was given only company, domain, contact name and title. It found
Daniel McCallum's blog index, enumerated all six of his posts, took the most
recent ("I used to have ten ideas and could only pick one", 22 Jul 2026), and
that became the run's best hook. It worked because the skill says to fetch the
blog index or sitemap and filter, rather than trust a search ranking.

Worth stressing: that post was *not* findable by search. Only two of
McCallum's LinkedIn posts are indexed, and neither is that one. Enumeration
beat search outright.

**Podcast and long-form transcripts.** The Figma run's best hook was a 2 Jul
2026 podcast episode. Reading the transcript rather than citing the title is
what makes these usable.

## What does not work

### LinkedIn — the real gap

Three separate access paths were tested. All three fail:

| Path | Result |
| --- | --- |
| Direct profile fetch | `HTTP 999` — LinkedIn's anti-bot block (hit on the Airwallex run) |
| Web search for posts | Only sporadically indexed. `site:linkedin.com/posts "<name>"` found posts for ElevenLabs and Viktor, nothing for Jobber or Airwallex |
| Clay | Cannot read posts at all — see below |

Clay is excellent for identity resolution, role history and email. It is **not**
a LinkedIn reader, despite tool documentation that suggests otherwise. Asked
directly for a contact's recent LinkedIn posts, it returned:

> "LinkedIn pages often require authentication and may block scraping […] If
> you can provide public post links, grant access, or supply LinkedIn session
> cookies, I can extract the requested recent posts."

And for a contact known to have posted weeks earlier, it reported "no recent
posts found" — a false negative, not an empty profile. Clay's
`Find Thought Leadership` data point is a web search wearing a LinkedIn-shaped
label; it returns a sampled top-three, not a recency-ranked enumeration. On the
Wispr control it returned two blog posts and one LinkedIn post, and missed the
one that mattered.

### Why this matters less than it looks — and where it matters a lot

For someone who publishes on a company blog, LinkedIn is a **pointer layer, not
a content layer**. A LinkedIn post about an article is worth much less than the
article: the blog index gives you full text, a date, and the person's whole back
catalogue to rank. Losing LinkedIn there costs a redundant second route.

The gap is real for people with no first-party byline. Nadine Liverpool
(Jobber) has no post on the Jobber blog, a personal site that returned `503` on
every attempt, no indexed LinkedIn posts, and Clay's thought-leadership search
surfaced only decade-old material. If she publishes, it is on LinkedIn and
nowhere else reachable. **That is the case any LinkedIn solution should be
judged against — not the blog-publishing case, which already works.**

### A hazard to keep in mind

Clay's thought-leadership results are not filtered for appropriateness. For one
contact it returned a personal podcast interview about surviving intimate
partner violence. Nothing from a general content search should be piped
straight into a draft email; there must be a relevance-and-appropriateness
judgement between retrieval and drafting.

## Proposal: an agent-browser session for LinkedIn activity

**Not built. Design only.**

The insight that makes this cheap: we don't need to read LinkedIn posts
properly. We need the **outbound links** from recent activity. The substance
lives on blogs, podcasts and articles, all on domains we can already fetch. So
the browser's job is link harvesting, and it degrades gracefully — a bare list
of URLs and dates is most of the value.

Sketch:

1. A dedicated browser profile, logged into LinkedIn once, driven by the
   `agent-browser` skill.
2. Open the contact's recent-activity page. Harvest outbound URLs and post
   dates. Ignore post prose.
3. Fetch and read each linked artefact at its source, where normal tooling
   works.
4. Consolidate, rank by recency, dedupe against what the blog sweep already
   found.

Run step 2 **only when the first-party sweep comes back thin**, so the cost and
the exposure land on the minority of prospects that need it.

### The trade-off, stated plainly

Automating a logged-in session is against LinkedIn's User Agreement, and the
exposure is a real account rather than an anonymous IP — which matters, because
the CRM is keyed on LinkedIn URLs throughout. Harvesting links from profiles a
human would visit anyway, at human-ish pace, on a fallback basis, is a much
smaller footprint than a scraping service. It is not zero. This is an operator
decision, not a technical one, which is why the design stops here.

A scraping service was considered and rejected: same terms problem, a permanent
anti-bot arms race, and it would not have found the Wispr hook anyway, since
that hook was never on LinkedIn.

## Ceiling

Some prospects are simply quiet. Clay confirmed Emily Rosales (Airwallex) has
no discoverable email and no published content anywhere. No tool fixes that.
When the person sweeps come up empty the flow should say so and fall back to
company-level hooks, which is what the Xsolla run did correctly and
unprompted.
