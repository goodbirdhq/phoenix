# Review environments

Open **Environments** from the bottom of the web or desktop sidebar to see the machines running your
Phoenix environments. On mobile, open **Settings → Environment performance**.

The overview keeps every configured environment visible. Connected environments show host CPU,
memory, storage, and Phoenix process usage. Offline environments remain in the list without stale
performance readings. If an environment runs an older Phoenix server, update that server before its
metrics can appear.

Select an environment to see:

- whole-host CPU and memory pressure;
- how much CPU, memory, process count, and I/O this Phoenix environment contributes;
- capacity for the filesystems holding the server's working directory and Phoenix data, combined
  when they share a volume;
- operating system, architecture, logical CPU count, RAM, and uptime;
- a live CPU and memory trend covering up to 15 minutes.

The environment list refreshes slowly. The selected environment updates about once per second.
Collection is demand-driven and stops when no Environments or Diagnostics view is observing it.
Trend samples live only in server memory and are never written to the Phoenix database.

Phoenix reports each environment independently. If two environments run on the same physical
machine, their host readings may describe the same hardware while their Phoenix footprints describe
different process trees. Containers and WSL environments report the host resources visible from
inside that runtime.

CPU warnings require every current sample to stay above 90% for 30 seconds instead of reacting to
normal build spikes. When the native collector is available, Phoenix uses its cross-platform
available-memory reading. Linux also has a `MemAvailable` fallback, and Windows' portable reading
represents available physical memory. Free-only fallbacks are labeled as free memory and do not
raise low-memory warnings because they exclude reclaimable caches. Storage warnings show the exact
remaining capacity. Phoenix does not collapse those signals into a single health score.

Ordinary paired clients receive capacity and utilization values. Administrative sessions can also
see the CPU model and detailed operating-system version. Phoenix does not expose hostnames, network
addresses, interface names, mount paths, process command lines, or environment variables on this
page.
