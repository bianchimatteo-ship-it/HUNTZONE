# HUNTZONE

**GPS Hide & Seek Games.** HUNTZONE is a cross-platform platform for real-world pursuit, hiding, team strategy and social-deduction games. Players move in the real world while the game runs as a server-authoritative virtual match.

The first product is a responsive website. A native Android client follows for reliable background location during an active match; iOS is a later client. All clients use the same backend and game rules. The intended feel is tense and competitive, with an arcade layer that keeps real-world play understandable and safe.

> **Working slogan:** *Hide. Hunt. Outlast.* It is a direction for evaluation, not an approved brand asset.

## Product at a glance

- Private and public matches for 3–30 players, with room to scale beyond a single match server.
- All six modes are in the confirmed beta target: CLASSIC HIDE & SEEK, MANHUNT, INFECTED, TEAM HUNT, SURVIVAL and TASKS & DECEPTION. Their detailed rules remain subject to the owner decisions in [the beta scope](docs/BETA-SCOPE.md).
- A fast editor for changing a mode and a visual advanced editor built from safe, allow-listed rules.
- Player-selected play radius from 100 to 3,000 metres, entered as any whole-metre value.
- Explicitly opt-in location, collected only for an active match and stopped when it ends.
- Virtual captures and hazards only. No mechanic asks a player to run, cross a road, enter private property or ignore their surroundings.

## Foundation documents

1. [Product vision](docs/PRODUCT-VISION.md)
2. [Game design](docs/GAME-DESIGN.md)
3. [Custom modes and rule engine](docs/CUSTOM-MODES.md)
4. [Technical architecture](docs/TECHNICAL-ARCHITECTURE.md)
5. [Database design](docs/DATABASE-DESIGN.md)
6. [GPS and mobile](docs/GPS-AND-MOBILE.md)
7. [Security and privacy](docs/SECURITY-AND-PRIVACY.md)
8. [UI and UX](docs/UI-UX.md)
9. [Roadmap](docs/ROADMAP.md)
10. [Technical decisions](docs/TECHNICAL-DECISIONS.md)
11. [Test and acceptance plan](docs/TEST-AND-ACCEPTANCE.md)

## Project state

The published client entry point is now a real multiplayer lobby client. It creates hashed-token guest sessions, creates/joins invite-code lobbies, sets READY through authenticated HTTP, and receives participant snapshots over WebSocket. PostgreSQL/PostGIS migrations, Fastify API routes, rate limits, command idempotency and lobby audit events are in `apps/api`. Every displayed participant is backed by a session accepted by the server. The browser-local player factory, local match simulation and synthetic result screens have been removed from the app bundle and source path.

This is an early multiplayer foundation, **not a playable match or beta**. PostgreSQL is not configured in this checkout, so the app currently reports service unavailable and disables create/join; no lobby, account or match can be created here. The backend supports guest sessions, lobby creation/join, READY and realtime presence only. The pure game-core now has a first tested rules engine slice for six role layouts, capture authorization, conversion, task actions, sabotage, votes, withdrawal and timeout resolution; it is not connected to the API. Start/countdown, role privacy projections in the service, GPS evidence production, capture PIN lifecycle, mission adjudication, active-match GPS, durable result/checkpoint recovery, Android and public backend deployment remain open. All six modes are marked in development; their first implementation rules are recorded in [MODE-RULES.md](docs/MODE-RULES.md), with conservative values still requiring safe field validation. No paid infrastructure has been provisioned.

### Run the local prototype

Use Node.js 22 and npm:

```bash
npm ci
npm run dev
npm run test
npm run typecheck
npm run build
npm run test:e2e
npm run api:typecheck
```

For local real-lobby development, configure PostgreSQL with PostGIS and copy `.env.example` to `.env`, then run `npm run api:migrate`, `npm run api:dev` and `npm run dev` in separate terminals. Without the database, the API returns HTTP 503 and the web UI keeps lobby actions disabled. `npm run test:e2e` checks this unavailable state and responsive layouts; it exercises two browser clients only when explicitly enabled against a local API with `HUNTZONE_E2E_ALLOW_ONLINE=1`. Browser fixtures are test clients and never ship in the product. These checks do not count as a real-device field test. `npm run build` targets `/` for local use and Cloudflare Pages. `npm run build:github-pages` targets `/HUNTZONE/` for the project site. See [the beta implementation plan](docs/BETA-IMPLEMENTATION-PLAN.md) for remaining server, GPS, Android and six-mode work.

## Beta direction

The beta target is a controlled private multiplayer release with all six modes, an authoritative server, durable virtual state, consented real GPS, web and native Android clients, reconnect, and safety/privacy controls. It follows the gates in [BETA-IMPLEMENTATION-PLAN.md](docs/BETA-IMPLEMENTATION-PLAN.md); no single milestone or mock screen satisfies the beta definition. Public matchmaking, chat, public custom modes, iOS, monetization and GPS history remain out of scope.

## Working with AI coding tools

Treat this README and `docs/` as the accepted project brief. Before implementation, read the open questions in [the roadmap](docs/ROADMAP.md), record decisions in [technical decisions](docs/TECHNICAL-DECISIONS.md), and preserve the constraints in [security and privacy](docs/SECURITY-AND-PRIVACY.md). Do not implement background GPS using a web page or PWA, execute user-authored code, or trust the client to determine captures, scores or match outcomes.
