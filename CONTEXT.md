# Phoenix Product Domain

Phoenix lets users direct coding agents inside environment-owned projects. This glossary fixes the product language used while shaping Phoenix behavior.

## Scheduling

**Schedule**:
A named, saved agent prompt owned by one Environment and assigned to one of its Projects, together with a one-time or recurring timing rule interpreted in an explicitly saved user time zone. Its Environment cannot change, recurring rules have a minimum interval of five minutes, and each occurrence starts a new Thread.
_Avoid_: Scheduled, cron job, pending task

**Occurrence**:
A time at which a Schedule becomes due to trigger a Scheduled run, either from its timing rule or from the user choosing Run now.
_Avoid_: Cron tick, invocation

**Enabled Schedule**:
A Schedule whose timing rule can produce new Occurrences.
_Avoid_: Active Schedule

**Paused Schedule**:
A Schedule whose timing rule produces no Occurrences until the user resumes it. Resuming begins with the next future time and does not catch up the paused period; a one-time Schedule whose time passed while paused requires a new future time or Run now.
_Avoid_: Disabled Schedule

**Completed Schedule**:
A one-time Schedule that has triggered. It retains its configuration and history but produces no more timed Occurrences.
_Avoid_: Finished task, expired Schedule

**Failed Schedule**:
A one-time Schedule whose Occurrence failed before it could trigger. It retains its configuration and error for inspection or a manual Run now.
_Avoid_: Failed run

**Scheduled Run**:
The agent work started by successfully triggering an Occurrence. Scheduled runs may overlap; serialization applies to triggering them, not to their execution.
_Avoid_: Scheduled task, job

**Scheduled Thread**:
The new Thread created by a Trigger. Its title combines the Schedule name with the local trigger time; after creation it follows the same lifecycle as any manually created Thread and remains after its Schedule is deleted.
_Avoid_: Schedule history

**Schedule history**:
The compact record of a Schedule's Occurrences, failures, and links to the Threads it triggered. Deleting the Schedule removes this record but not the linked Threads.
_Avoid_: Archive, run log

**Trigger**:
The durable creation of a new Thread and acceptance of its first Turn for an Occurrence. Failures after this point belong to the new Thread rather than to the Schedule.
_Avoid_: Completion, execution

**Missed Occurrence**:
An Occurrence that became due while its Schedule could not trigger. Only the newest Missed occurrence of each Schedule remains eligible to run; older ones are skipped.
_Avoid_: Backlog

**Failed Occurrence**:
An Occurrence Phoenix could not trigger. It records a visible failure without creating a Scheduled run.
_Avoid_: Failed run

**Runnable environment**:
An Environment whose server is online and capable of accepting new work.
_Avoid_: Available environment
