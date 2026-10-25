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
vp install
docker compose -f apps/cloud/compose.yaml up -d
```

Run the database migration and start the app from the repository root:

```sh
vp run --filter @phoenix/cloud db:migrate
vp run --filter @phoenix/cloud dev
```

The package filter and script names are provisional until the cloud app's
package manifest is finalized.

To stop this database, run `docker compose -f apps/cloud/compose.yaml down`.
This keeps the named data volume so the database is available the next time
you start it. Do not add `-v` unless you intend to delete the local database.
