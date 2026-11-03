# HUNTZONE — Beta implementation plan

**Owner scope:** all six modes are required in the eventual beta. The phases below are dependency ordered; a phase is not complete because its screens or mocks exist. Provision no paid infrastructure without a separate budget approval.

## Milestone 0 — Audit and scope (completed in this change)

- Inventory the local frontend and distinguish simulation from services.
- Record six mode proposals and unresolved rule choices in [BETA-SCOPE.md](BETA-SCOPE.md).
- Compare backend options and record the framework recommendation in [TECHNICAL-DECISIONS.md](TECHNICAL-DECISIONS.md).
- Define target repository packages, HTTP/WebSocket contracts, database plan, GPS plan, and acceptance gates here.
- Keep the existing root Vite app deployable to Cloudflare Pages; GitHub Pages deployment is disabled because the repository Pages service is not configured. Keep its base-path build script as compatibility validation.

## Milestone 1 — Framework-independent game core (in progress)

### Delivered first slice

- `packages/game-core` has no React, browser, database, network, or provider imports.
- Versioned mode registry for all six requested IDs. Each is marked `proposal`, not executable.
- Strict common match-configuration validation with explicit player, radius, duration, and schema checks.
- Pure lobby creation/join/ready transitions with monotone revision, expected-revision checks, and command-ID deduplication.
- Unit tests exercise every registry entry and lobby boundary/error behavior.

### Policy extension delivered in this milestone

- Validated policy shapes for RAGGIO, PIN and AUTOMATICA without choosing gameplay thresholds.
- Server-held GPS evidence eligibility with age, sequence, accuracy, conservative range and optional automatic-dwell checks; the evaluator never decides a capture outcome and returns no coordinates.
- A pure PIN attempt gate with expiry, configured finite attempts and one-use invalidation; no PIN generation, plaintext storage, credential delivery or real authentication exists yet.
- Exact role-slot validation, injected-random assignment, manual host-only pre-start assignment with READY invalidation for changed players, and secret-role projection.
- Tests cover these transitions and policy failure cases. All six mode rules remain proposals and cannot be started.

### Still required

- Owner approval of mode-specific rules and numeric bounds.
- Server-seeded role assignment, immutable mode-version pinning, start/countdown/active/pause/resolve transitions, timers, terminal evaluation, capture/conversion/elimination, and authorized projections.
- Tests for every approved mode's normal, edge, duplicate, timeout, disconnect, and simultaneous-event behavior.
- Backend enforcement, CSPRNG binding, PIN hashing/rate limiting, durable attempts and authenticated per-player projections.
- Durable idempotency and checkpoint/replay belong to the backend integration, not in a client store.

## Milestone 2 — Backend protocol and persistence

### Proposed transport contract

All commands are authenticated guest/session intents. JSON is schema-versioned and rejects unknown fields. A command envelope is:

```json
{
  "protocolVersion": 1,
  "commandId": "opaque-client-generated-id",
  "matchId": "opaque-match-id",
  "expectedRevision": 12,
  "type": "player.ready",
  "payload": { "ready": true }
}
```

The server validates membership, actor, lifecycle, expected revision, payload bounds, idempotency, rate limits, and mode compatibility; then commits before acknowledging. A repeat `commandId` returns the original committed result. A stale revision receives a conflict and authorized snapshot reference, never a client-side merge.

Proposed HTTP endpoints:

- `POST /v1/guest-sessions` — issue short-lived guest credential; store only a verifier/hash.
- `POST /v1/lobbies` — create a private lobby and return a one-time/shareable invite code.
- `POST /v1/lobbies/{code}/join` — join subject to throttling and roster limits.
- `GET /v1/matches/{matchId}` — return the caller's authorized snapshot only.
- `POST /v1/matches/{matchId}/commands` — HTTP fallback for commands where WebSocket is unavailable.

Proposed WebSocket: authenticated `wss://.../v1/matches/{matchId}/stream`. Client messages are command envelopes; server messages are `command.ack`, `match.snapshot`, `match.delta`, `match.paused`, `match.ended`, and bounded structured errors. A reconnect supplies last acknowledged revision; server sends a contiguous authorized delta or fresh per-player snapshot. Hidden roles, missions, and exact locations are omitted from unauthorized projections. GPS samples use a separately typed message and are never echoed.

### Proposed durable records

PostgreSQL is the system of record; PostGIS is used only for vetted match geometry and spatial predicates. Tables: `guest_sessions` (hashed credential, expiry, status); `matches` (mode/engine version, lifecycle, revision, config, area/radius, deadlines); `participants` (membership, role/team state, ready/connection state); `match_events` (revisioned virtual events, no coordinates); `match_checkpoints` (versioned virtual state, no coordinates); `processed_commands` (unique match/actor/command ID and committed result); `match_results` (minimal outcome summary); and `consents` (purpose/policy/version and grant/withdraw timestamps). Add foreign keys and unique `(match_id, revision)` and `(match_id, actor_id, command_id)` constraints.

Exact GPS remains in bounded volatile match-owner memory, with receipt timestamp, accuracy and sequence. Never store it in tables, checkpoints, events, analytics, logs, or result summaries. At recovery, discard exact samples and require new samples. Proposed checkpoint: at match start, every 15 seconds or 50 transitions, and after critical state changes; validate this interval under pilot load before adoption.

### Backend build tasks

1. Create `apps/api` with Fastify, auth/session boundary, HTTP schema validation and WebSocket gateway.
2. Integrate the pure core as a dependency; API layer owns persistence/transactions and authorized projections.
3. Add Postgres migrations, transaction/outbox or post-commit publish, command uniqueness, checkpoint and recovery tests.
4. Add rate limits, join-code throttling, input size caps, security headers, secret management, metrics, retention/deletion, backups, and incident procedures.
5. Run no paid deployment until owner approves provider, region, spend ceiling, and operational owner.

## Milestone 3 — Web GPS and real map

### Delivered web map and foreground GPS picker — 2026-11-03

- The Create screen uses a MapLibre GL JS provider adapter with Stadia Alidade Smooth Dark over EU endpoints, visible attribution and a provider error/retry state.
- MapLibre 6's Vite worker is set once before app mount; root and `/HUNTZONE/` builds emit their own worker asset. Runtime diagnostics distinguish auth, style, worker, WebGL2, network, timeout, tile-degraded and fatal states; a tile error after initial render does not hide the map.
- Optional GPS starts only after **ATTIVA POSIZIONE**. A root provider keeps the single foreground watch/sample through Create→Lobby→Game and clears it on STOP, match completion or abandoning the flow.
- The chosen centre/radius are carried in the in-memory local match through Results; Lobby, Game and Results display the true map, area and device accuracy ring. No demo participants are presented as real locations.
- Chrome E2E verified localhost worker/style/vector tiles, browser `Origin`/`Referer`, rendering, touch pinch, mouse selection/zoom, 401 retry recovery and nine responsive widths. No API key is used and no physical GPS permission/device test was run.

### Still required for beta

- Integrate GPS consent and samples into an active authenticated match over HTTPS; the setup picker itself is not match consent and never sends GPS to a server.
- Re-run real browser checks on Cloudflare after the new build is deployed; the last live response had old asset hashes. Complete physical-device and privacy-notice review.
- Keep background GPS in the later native Android foreground-service milestone. Do not show fictitious player markers in beta mode; browser suspension remains visibly degraded.

## Milestone 4 — Native Android

- Add `apps/android` in Kotlin after API contracts and permission copy are approved.
- Start a location foreground service from a visible, user-initiated match screen, with `location` service type, persistent notification, explicit stop, consent/revocation, approximate-vs-precise states, and reconnect behavior.
- Do not request `ACCESS_BACKGROUND_LOCATION` by default. Reassess if a tested core use case cannot work with a foreground service started while the activity is visible. Review current Android platform and Google Play policy before submission.
- Test process death, screen off, battery saver, permission withdrawal, network loss, and server recovery on representative physical devices.

## Milestone 5 — Approved six-mode gameplay

After BETA-SCOPE decisions are confirmed, implement each mode as versioned data/policies in the common core, not a separate application. Implement server role assignment, scoring, capture/conversion, tasks, timer outcomes, leave/disconnect policy, and private projections. Unit/property tests run against the same conformance suite for all six modes. No public chat/social features are required.

## Milestone 6 — Beta gate

- Browser and Android clients connect to the same deployed backend.
- All six mode suites pass, including multi-client lifecycle, reconnect, idempotency and result persistence.
- GPS consent, withdrawal, stale-sample rejection, retention and deletion are reviewed and exercised.
- Perform threat model, cross-player authorization, invite-guessing, WebSocket replay, database failure and recovery tests.
- Run safe controlled field tests with informed adult participants, permitted venue, stop plan and incident owner.
- Checkpoint accepted release evidence, device/browser matrix, Android signing, provider/license/cost, privacy review, operational alerting, backups and support/moderation.

## Suggested target repository layout

```text
apps/
  web/                 # eventually move the existing root Vite frontend
  api/                 # HTTP, WebSocket, identity/session and persistence adapters
  android/             # native Kotlin location client
packages/
  game-core/           # pure state/config/rules engine (first slice exists)
  contracts/           # shared versioned HTTP/WebSocket schemas
```

Do not move the current root Vite frontend until the Cloudflare Pages root/build settings and GitHub Pages base path can be changed in the same reviewed commit. Root `npm run build` remains the static frontend build; GitHub Pages uses `npm run build:github-pages`.
