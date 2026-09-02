# Birdhouse runtime retired

The birdhouse service is retired: no claim endpoint, no result callback, no job queue, no workflow or run tables, no maintenance loop. A Schedule triggers a thread whose workspace is the birdhouse checkout, so the thread reads the workflow's SKILL.md straight off disk and no definition needs serving; deduplication and outcome-recording belong to each workflow inside the domain it already writes to, where the evidence a run happened lives anyway; and a Schedule's own unacknowledged failure is the only runtime health signal Phoenix keeps.
