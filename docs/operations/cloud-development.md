# Cloud app development

The cloud app uses a local PostgreSQL 18 container for development. Compose
names the project `phoenix-cloud`, publishes PostgreSQL only on loopback port
55433, and keeps its data in a named volume. These settings keep it separate
from Phoenix's other local services.

PostgreSQL 18 is the current stable major in the [official PostgreSQL Docker
image](https://hub.docker.com/_/postgres). PostgreSQL 18 changed the image's
data volume location to `/var/lib/postgresql`; the Compose volume mounts there
as described in the [official image documentation](https://github.com/docker-library/docs/blob/master/postgres/README.md#pgdata).

## First-time setup

From the repository root, copy the app environment example and replace its
placeholder auth secret with a unique random value:

```sh
cp apps/cloud/.env.example apps/cloud/.env
openssl rand -base64 32
```

Paste the generated value into `BETTER_AUTH_SECRET` in `apps/cloud/.env`. Keep
that file local and do not commit it. The example configures
`DATABASE_URL` for the database on port 55433 and `BETTER_AUTH_URL` for the
app on port 3100.

Install dependencies from the repository root, then start only this app's
database:

```sh
vp i
vp run db:cloud:up
```

Run the database migration and start the app from the repository root:

```sh
vp run db:cloud:migrate
vp run dev:cloud
```

Open `http://localhost:3100` after startup.

When opening the app from another machine, set `BETTER_AUTH_URL` in the local
`.env` to the exact origin you will open, then restart the app. The Vite host
allowlist uses that origin's hostname, and Better Auth uses it for authentication.
Use that same origin consistently for signup and login.

This local foundation supports email/password accounts and workspace management.
The Devices page lists installation records; desktop/CLI linking and automatic
tunnels are not connected yet. Email verification and password recovery delivery
also need configuration before a public deployment.

To stop this database, run `docker compose -f apps/cloud/compose.yaml down`.
This keeps the named data volume so the database is available the next time
you start it. Do not add `-v` unless you intend to delete the local database.
