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

`api:start` applies the schema before launching the compiled Fastify server. A deployed API must supply its own private `DATABASE_URL`, `CORS_ORIGINS`, `PUBLIC_APP_ORIGIN`, `API_HOST`, `API_PORT`, `NODE_ENV=production`, and `TRUST_PROXY=true` when it is behind a trusted HTTPS proxy; use HTTPS, a single backend instance, and a database in the same region. The frontend receives only `VITE_API_BASE_URL`. Never put a database URL or session credential in a frontend build variable.

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

## Cloud preview deployment package

`apps/api/Dockerfile` and the root `render.yaml` prepare a separate Fastify/PostGIS backend on Render. The blueprint selects one Node 22 Docker web instance and PostgreSQL 16 in Frankfurt, with private database networking, WebSocket support, HTTPS termination, and `/v1/health` checks. Render Postgres supports PostGIS; the existing migrations enable it. The frontend remains on Cloudflare Pages.

No Render resource has been created by this repository change. Deploying this blueprint creates paid recurring services. The current low-volume beta estimate is about **$27.50/month** before traffic overages and taxes: Render Starter web service $7/month, Postgres 1 GB plan $19/month, and 5 GB database storage at $0.30/GB/month. Check the [current Render pricing](https://render.com/pricing) before creating resources. The free Postgres option expires after 30 days, so it is not suitable for an ongoing playtest.

**Cookie-domain prerequisite:** the current guest-session flow uses secure cookies. `huntzone-review.pages.dev` and a generated `*.onrender.com` API host are cross-site, so browser privacy settings can reject the session cookie even with credentialed CORS. For a reliable phone playtest, use an API hostname under a domain you control (for example, `api.<your-domain>`) and confirm cookie persistence in mobile Safari and Chrome. No custom domain was provided or configured, so the blueprint's generated Render hostname is only a backend package target, not confirmation that browser sessions will work on every device.

When ready to approve the recurring cost:

1. In Render, choose **New → Blueprint** and connect `bianchimatteo-ship-it/HUNTZONE` on `main`; review the proposed service and database in Frankfurt before confirming creation.
2. Wait for `huntzone-api-multiplayer` to deploy and confirm its generated `https://…onrender.com/v1/health` endpoint reports healthy. The generated API hostname is not known until Render creates it.
3. In Cloudflare Pages, verify whether existing project `huntzone-review` is Git-integrated and points to this repository's `main` branch. The currently published `https://huntzone-review.pages.dev` responds, but its HTML still identifies the old interactive demo; this commit has not been verified on the public site. If the existing project is Direct Upload, leave it intact and create a separate Git-integrated Pages project from `bianchimatteo-ship-it/HUNTZONE` on `main`.
4. In the Git-integrated Pages project, set root `/`, Node.js 22, build command `npm run build`, output `dist`, and production build variable `VITE_API_BASE_URL` to the generated API origin (scheme and host only, no `/v1`). Trigger a production build from `main`.
5. Confirm Render has `CORS_ORIGINS` and `PUBLIC_APP_ORIGIN` set to the exact public Pages origin. Those values are prefilled in `render.yaml` for `https://huntzone-review.pages.dev`; update them if the actual Pages custom hostname differs.
6. Confirm the published HTML references the new build and check the site can reach `/v1/health`, create a lobby, and open its WSS stream from a second device. Do not use GitHub Pages as the production API client because its build intentionally has no backend URL.

The estimate uses the published [Render service plans](https://render.com/pricing), [Postgres storage rate](https://render.com/pricing), and the documented [Frankfurt region](https://render.com/docs/regions). Render supports [PostGIS](https://render.com/docs/postgresql-extensions), [WebSockets](https://render.com/docs/websocket), and [Docker-backed web services](https://render.com/docs/web-services). Prices and plan availability can change.
