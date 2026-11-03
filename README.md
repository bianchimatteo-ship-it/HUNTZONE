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

The repository contains a React/TypeScript/Vite frontend prototype and an independent `packages/game-core` policy foundation. The frontend's lobby, roster, roles, map, timer, captures and results are local simulations; only CLASSIC is playable in that demo. The core now validates capture-policy shapes, evaluates server-held GPS evidence, gates temporary PIN attempts, validates random/manual role slots, invalidates affected READY states, and builds role visibility projections. The registry still marks every mode `proposal`; the package does not start or adjudicate matches, and these primitives are not connected to a service.

There is no multiplayer backend, database, WebSocket service, real GPS integration, authentication service, real map provider, or Android client yet. Do not describe the current site as a real game or beta. Product, rules, privacy, legal, operational and playtest decisions remain open and are listed in [BETA-SCOPE.md](docs/BETA-SCOPE.md). HUNTZONE is the working project name; domain, store listing and trademark availability must be checked before commercial publication.

### Run the local prototype

Use Node.js 22 and npm:

```bash
npm ci
npm run dev
npm run test
npm run typecheck
npm run build
```

The browser UI is a local demo only. `npm run build` targets `/` for local use and Cloudflare Pages. `npm run build:github-pages` targets `/HUNTZONE/` for the project site. See [the beta implementation plan](docs/BETA-IMPLEMENTATION-PLAN.md) for the staged backend, GPS, Android and six-mode work.

## Beta direction

The beta target is a controlled private multiplayer release with all six modes, an authoritative server, durable virtual state, consented real GPS, web and native Android clients, reconnect, and safety/privacy controls. It follows the gates in [BETA-IMPLEMENTATION-PLAN.md](docs/BETA-IMPLEMENTATION-PLAN.md); no single milestone or mock screen satisfies the beta definition. Public matchmaking, chat, public custom modes, iOS, monetization and GPS history remain out of scope.

## Working with AI coding tools

Treat this README and `docs/` as the accepted project brief. Before implementation, read the open questions in [the roadmap](docs/ROADMAP.md), record decisions in [technical decisions](docs/TECHNICAL-DECISIONS.md), and preserve the constraints in [security and privacy](docs/SECURITY-AND-PRIVACY.md). Do not implement background GPS using a web page or PWA, execute user-authored code, or trust the client to determine captures, scores or match outcomes.
