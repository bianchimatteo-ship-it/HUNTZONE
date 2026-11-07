# HUNTZONE local multiplayer services

The local database is PostgreSQL 16 with PostGIS 3.6. Compose binds it to `127.0.0.1:54329` and keeps data in the named `huntzone-postgres` volume. The credentials in `compose.yaml` are for local development only and must never be used for a deployed service.

## Prerequisites

- Node.js 22 and npm.
- Docker Engine/Desktop with the Compose plugin.

## Start the database and API

```sh
npm ci
npm run db:up
DATABASE_URL=postgres://huntzone:huntzone_local_only@127.0.0.1:54329/huntzone npm run api:dev
```

The API listens on `http://127.0.0.1:8787`. In a second terminal, run `npm run dev -- --host 127.0.0.1`; set `VITE_API_BASE_URL=http://127.0.0.1:8787` in an untracked `.env.local` before starting Vite. For a browser origin other than the defaults, configure `CORS_ORIGINS` on the API with exact origins, separated by commas.

`api:dev` applies the idempotent schema migration before starting. To stop PostgreSQL without deleting its data, run `npm run db:down`. `docker compose down` also keeps the named volume; do not use `docker compose down -v` unless you intentionally want to erase the local database.

## Build and run the API production bundle locally

```sh
DATABASE_URL=postgres://huntzone:huntzone_local_only@127.0.0.1:54329/huntzone npm run api:build
DATABASE_URL=postgres://huntzone:huntzone_local_only@127.0.0.1:54329/huntzone npm run api:start
```

`api:start` applies the schema before launching the compiled Fastify server. A deployed API must supply its own private `DATABASE_URL`, `CORS_ORIGINS`, `PUBLIC_APP_ORIGIN`, `API_HOST`, `API_PORT`, and `NODE_ENV=production`; use HTTPS, a single backend instance, and a database in the same region. The frontend receives only `VITE_API_BASE_URL`. Never put a database URL or session credential in a frontend build variable.

Production browser sessions use Secure, HttpOnly, SameSite=None cookies and require exact credentialed CORS origins. For reliable browser cookie behavior, serve the API on a same-site HTTPS domain where possible. Local sessions use HttpOnly SameSite=Lax cookies. WebSocket connections authenticate using the same cookie and an allow-listed Origin.

## Tests

```sh
npm run test
DATABASE_URL=postgres://huntzone:huntzone_local_only@127.0.0.1:54329/huntzone npm run api:test:integration
npm run typecheck
npm run api:typecheck
npm run api:build
npm run build
```

The integration suite requires `DATABASE_URL` and a reachable PostGIS database; CI supplies an isolated PostgreSQL/PostGIS service. It creates and truncates tables in that configured test database. Never point it at production or a database with data to preserve.
