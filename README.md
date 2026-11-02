# HUNTZONE

**GPS Hide & Seek Games.** HUNTZONE is a cross-platform platform for real-world pursuit, hiding, team strategy and social-deduction games. Players move in the real world while the game runs as a server-authoritative virtual match.

The first product is a responsive website. A native Android client follows for reliable background location during an active match; iOS is a later client. All clients use the same backend and game rules. The intended feel is tense and competitive, with an arcade layer that keeps real-world play understandable and safe.

> **Working slogan:** *Hide. Hunt. Outlast.* It is a direction for evaluation, not an approved brand asset.

## Product at a glance

- Private and public matches for 3–30 players, with room to scale beyond a single match server.
- CLASSIC HIDE & SEEK as the first mode; MANHUNT, INFECTED, TEAM HUNT, SURVIVAL and TASKS & DECEPTION as later mode configurations.
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

This repository contains the product and architecture foundation only. No game client, server, database schema, dependencies or deploy configuration has been implemented. Decisions that need product, legal, operational or usability review are called out in the documents. HUNTZONE is the working project name; domain, store listing and trademark availability must be checked before commercial publication.

## MVP direction

The first milestone is a playable private web match of CLASSIC HIDE & SEEK: create/join, lobby, roles, timer, map, browser GPS, server-validated capture, results and reconnect. Android background location and advanced/public mode creation follow later. The initial engine must persist match outcomes safely and reserve versioned extension points for future mechanics, without implementing those later features prematurely.

## Working with AI coding tools

Treat this README and `docs/` as the accepted project brief. Before implementation, read the open questions in [the roadmap](docs/ROADMAP.md), record decisions in [technical decisions](docs/TECHNICAL-DECISIONS.md), and preserve the constraints in [security and privacy](docs/SECURITY-AND-PRIVACY.md). Do not implement background GPS using a web page or PWA, execute user-authored code, or trust the client to determine captures, scores or match outcomes.
