# HUNTZONE — Roadmap

Sequence is dependency-based; dates and estimates follow discovery and team capacity. The original phased mode rollout below has been superseded by the owner's confirmed beta target: all six modes must be playable before the beta gate. Earlier sequencing remains historical rationale for dependencies, not permission to ship a Classic-only beta.

## Current status — 2026-11-03

- The root React/TypeScript/Vite frontend is a local simulation, not a multiplayer client.
- `packages/game-core` contains capture-policy validation/evidence checks, bounded PIN attempt transitions, random/manual role-slot assignment, READY invalidation and secret-role projections, alongside lobby commands. No mode can start because gameplay rules are not approved; these primitives are not connected to a server.
- Milestone 0 and owner-approved capture/assignment scope are documented in [BETA-SCOPE.md](BETA-SCOPE.md), [GAME-DESIGN.md](GAME-DESIGN.md) and [BETA-IMPLEMENTATION-PLAN.md](BETA-IMPLEMENTATION-PLAN.md).
- The mobile-first Create screen now has a real MapLibre/Stadia EU map, geodesic area selection and an optional foreground-only GPS picker. GPS is requested only after a user action, remains in volatile screen memory, and is not connected to a match/backend. The policy selectors remain an unapplied local preview; lobby and gameplay remain simulated.
- Next gate: owner review of the prioritized rules and thresholds before completing the mode engine; in parallel, define backend identity/session and deployment ownership without creating paid resources. Verify Stadia domain authentication on the deployed preview before considering the map provider operationally confirmed.

## Phase 0 — Validate the foundation

- Review architecture, privacy, age policy, safety constraints and open product choices.
- Run paper prototype and usability sessions for join/start, roles, location consent and capture.
- Spike map provider fit and real-world location behavior; document costs and licenses.
- Define numeric targets for one 3–30-player pilot match and a test venue.

**Gate:** approve the MVP mode/rules, location visibility model, capture policy, account approach, hosting budget and launch audience.

## Phase 1 — Web MVP foundation, controlled private matches

- Responsive web app, guest join, private room code/link and basic profile.
- All six beta modes are required. Build a shared server-authoritative lifecycle and game engine, then implement and test the six approved mode policies; do not stop at Classic-only delivery.
- Map with either host-GPS-centred (after consent) or manually pinned centre, boundary, and arbitrary 100–3,000 m integer radius.
- Foreground browser location only, consent and clear degraded/stale states.
- One safe default capture rule, minimal host controls, pause/cancel, forbidden-area exclusions and report.
- Durable match checkpoint/event recovery in PostgreSQL; discard volatile GPS on process recovery and require fresh samples.
- Operational metrics, rate limits, retention/deletion basics and a small closed pilot.

**Explicit MVP limits:** no promise of web screen-off tracking; no public matchmaking or user-generated public modes; no persistent location history; no monetization; no advanced social graph.

**Playable means:** at least one real end-to-end private match flow has been field exercised with the supported browser/location behavior, server adjudication, reconnect and result recovery. Paper prototypes or mocks alone do not meet this gate. Use a safe controlled public venue and consenting adult participants for the first pilot unless a reviewed age/safeguarding plan says otherwise.

## Phase 2 — Reliability and approved mode completeness

- Improve recovery, observability, load handling and host handoff.
- Complete all six approved beta modes as validated configurations of the shared engine. The mode list in this older phase description is not a deferred release gate.
- Add saved quick-editor variants and mode version pinning; keep advanced visual composition for Phase 4.
- Evaluate moderation operations before enabling broader public rooms.

## Phase 3 — Native Android client

- Implement native Kotlin location session and foreground service with the required notification and permission UX.
- Use the shared API and game protocol for crossplay with web.
- Test screen-off behavior, process recreation, power use, permission withdrawal, reconnect and platform policy.
- Publish only after the background-location use case and store requirements are reviewed.

## Phase 4 — Advanced editor and social modes (post-beta)

- Add validated visual rule composition, bounded IR, test/simulation preview, save/version/share and moderation controls.
- Pilot TASKS & DECEPTION and dynamic events with private groups.
- Add public discovery, chat/communications or user publishing only with abuse response and moderation capacity.

## Phase 5 — Progression and expansion

- Add cosmetic progression, badges, stats and opt-in leaderboards with anti-abuse controls.
- Consider seasons/tournaments and non-pay-to-win monetization.
- Add iOS client using native Core Location and the existing backend contract.
- Scale regions or partition match ownership only when telemetry demonstrates the need.

## Critical path

Product and safety decisions → server-authoritative match protocol → privacy-filtered location model → web private MVP → controlled field pilot → Android native client → public/social features. The rule schema and versioning contract must precede advanced editor work. Public matchmaking must not precede moderation readiness.

## Design now vs implementation later

| Define before beta gameplay | Implement in beta | Keep as a compatible extension point; implement later |
|---|---|---|
| Approved rules for six modes; match lifecycle, command/revision/idempotency contract; checkpoint/event versioning and recovery; immutable mode/engine versions; privacy-filtered projections; role/team model; bounded rule vocabulary; no-coordinate persistence policy | All six approved modes; lobby, timer, real map, consented browser GPS, server-validated outcomes, reconnect and results; single-region PostgreSQL/PostGIS persistence and recovery; native Android foreground location client; basic forbidden-area exclusions | Advanced visual editor UI; public mode publishing; public matchmaking/social features; progression; iOS; distributed event bus and multi-region sharding |

Do not build generic abstractions for hypothetical mechanics. Define the state/version and extension boundaries now, then add operators and screens only when their phase is funded and specified. Recovery should work in the first web MVP, not be deferred to a later reliability phase.

## Definition of MVP readiness

- A private 3–30-player match starts, survives reconnects, resolves results on the server and ends cleanly.
- Radius accepts any whole-metre value within the documented bounds.
- Location disclosure is understood and limited to the active match; end/withdraw paths stop collection.
- Stale or uncertain samples do not trigger automatic captures.
- Playtest shows controls and map are usable without encouraging unsafe movement.
- Data deletion, report response, operational alerting, backups and incident ownership are documented and exercised.
- Killing the match process after a durable commit restores the last committed virtual state exactly once; the game pauses during recovery and accepts fresh GPS only after restore.
- Database unavailability does not produce acknowledged uncommitted outcomes; clients receive a clear pause/error and retry behavior.
- Test plan acceptance criteria in [TEST-AND-ACCEPTANCE.md](TEST-AND-ACCEPTANCE.md) pass for the agreed pilot scope.

## Open decisions before implementation

1. Does the implemented centre-selection flow (GPS action, optional recenter, use-as-centre, manual map tap) behave clearly in usability tests? Drawn boundaries remain later.
2. Which role configuration, hide time, match duration and capture distance should the first pilot use?
3. Is capture automatic, host-confirmed or player-confirmed for MVP, and how is a dispute resolved?
4. Are players adults-only for the initial launch? What is the age and guardian policy?
5. Which identity provider, if any, is used when a guest upgrades?
6. Stadia Maps is selected for the current web preview with its EU endpoint. Which provider/terms, hosting region and monthly spend ceiling are acceptable for beta/commercial operations?
7. What match-result and audit-event retention periods are needed?
8. What moderation staffing and response times exist before public rooms or custom-mode publishing?
9. What operator-owned maximum recovery window should pause before the match is cancelled? The default recovery behavior is restore committed virtual state, discard exact GPS, require fresh samples, then resume or cancel if validation fails.
10. What is the initial event/checkpoint retention period and database provider's measured recovery-point/recovery-time objective?

Record accepted answers in [technical decisions](TECHNICAL-DECISIONS.md) before they become code or migrations.
