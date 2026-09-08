# Review environments

Open **Environments** from the bottom of the web or desktop sidebar to see the machines running your
Phoenix environments. On mobile, open **Settings → Environment performance**.

The sidebar keeps every configured environment visible. Connected environments show host CPU,
memory, storage, and Phoenix process usage. Offline environments remain in the list without stale
performance readings. If an environment runs an older Phoenix server, update that server before its
metrics can appear.

Select an environment and open **Overview** to see:

- whole-host CPU and memory pressure;
- how much CPU, memory, process count, and I/O this Phoenix environment contributes;
- capacity for the filesystems holding the server's working directory and Phoenix data, combined
  when they share a volume;
- operating system, architecture, logical CPU count, RAM, and uptime;
- a live CPU and memory trend covering up to 15 minutes.

The environment list refreshes slowly. The selected Overview updates about once per second.
Opening another tab stops its live metrics subscription.
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
see the CPU model and detailed operating-system version. The Overview does not expose interface names, mount paths, process command lines, or environment
variables. Connection endpoints appear in the sidebar and Connections tab.

## Projects, providers, connections and access

The web and desktop Environments page has five tabs. Selecting an environment here does not switch
an open conversation to another machine.

- **Projects** lists that environment's workspaces with their project images, root paths and thread counts. Search by name or
  path, or choose **Add project** to register a workspace on the selected environment. Open a workspace
  to start a thread, or open its project settings. Branch and checkout management stays in the
  workspace's source control tools.
- **Providers** shows enabled provider accounts, installed versions, status and authentication.
  Use **Add provider** to create an account or enable a disabled account with its saved configuration. Configure an
  account using General, Environment variables, Configuration and Models tabs. Save applies the
  shared draft; Cancel discards it. Runtime updates are available when the provider supports them.
  Changing provider configuration requires Operate tasks permission.
- **Connections** shows the selected endpoint, connection status and editor handoff settings.
  Hosting, Tailscale, WSL and T3 Connect controls depend on the hosting desktop and platform.
  For a remote environment, open Phoenix on its host to change host-level networking.
- **Access** shows pairing links and authorized clients when your session has View access
  permission. Manage access permission allows creating links with selected permissions and revoking
  links or clients. These actions apply immediately. Revoking your current client disconnects it.
  Only active pairing links are listed. Used, expired and revoked invitations are not an access history.
  Sharing shows a QR code only when a reachable host address is available; otherwise copy the code
  and use the host’s network address.

## Add and edit environments

Use the sidebar's **+** button to add a remote environment using a pairing URL or a host and pairing
code. Desktop clients can also connect using SSH, including hosts discovered from SSH configuration.
Choose a laptop, desktop or server icon when adding an environment.

**Edit environment** lets you change the display name and icon on this client. The chosen icon
appears in the sidebar, environment title and Usage's environment table. The working directory
sets the starting folder for adding projects on that environment; it does not move existing projects.

For saved connections, **Reconnect automatically** controls whether Phoenix reconnects at startup.
Turning it off leaves the current connection running. Pairing the same environment again preserves
this preference and immediately adopts the new link’s granted permissions. **Disconnect** stops the connection while
keeping it saved; **Reconnect** restores it. **Remove environment** forgets the connection on this
client and requires pairing again. It does not delete projects, threads or files on the host.
Primary and platform-managed connections retain their platform's connection controls.

Search by name or endpoint, and combine status, connection-type and provider-account filters.
Filters combine within each category and narrow across categories. **Clear filters** keeps your
search text. **Show selected environment in list** clears both search and filters.
