# HUNTZONE — Database design

## Storage principles

PostgreSQL is the durable system of record. PostGIS supports match polygons, forbidden areas and spatial checks where needed. A spatial index helps bounded-area queries; use geography-aware distance functions where distances are in metres and validate the coordinate reference system. Do not persist a detailed location trail by default. Live exact observations should be short-lived, access-restricted server state; if persistence is operationally necessary, define a short TTL and document the purpose before implementation.

The client never connects directly to the database. Authorization is enforced in the service layer for every object read/write; database row-level security may provide defense in depth where practical.

## Main entities

| Entity | Important fields | Purpose |
|---|---|---|
| `users` | id, created_at, locale, status | Durable account; no location fields |
| `guest_sessions` | id, token_hash, expires_at, upgraded_user_id | Temporary guest identity and account upgrade |
| `profiles` | user_id, display_name, avatar_id, privacy settings | User-controlled profile data |
| `mode_definitions` | id, owner_id, visibility, moderation_state | Mode identity and ownership |
| `mode_versions` | mode_id, version, schema_version, engine_version, config_json, published_at | Immutable validated rules/configuration |
| `matches` | id, host_id, mode_version_id, engine_version, status, revision, starts_at, ends_at, area geometry, radius_m | Match lifecycle, pinned rules and current committed revision |
| `match_participants` | match_id, player_id, role, state, joined_at, left_at | Roster and server-assigned role/state |
| `match_events` | id, match_id, revision, event_version, type, actor_id, command_id, payload, created_at | Minimal durable lifecycle/game events; no raw coordinates |
| `match_checkpoints` | match_id, revision, engine_version, state_json, checksum, created_at | Protected, server-only recoverable virtual state |
| `processed_commands` | match_id, actor_id, command_id, result_revision, result_code, created_at | Retry deduplication; unique match/actor/command key |
| `match_leases` | match_id, owner_id, fencing_revision, lease_until | Single active writer when multiple match workers are introduced |
| `match_results` | match_id, outcome, summary, completed_at | Durable result summary |
| `friendships` | requester_id, recipient_id, state | Optional later social graph |
| `reports` | id, reporter_id, subject_id, match_id, category, status | Safety/moderation workflow |
| `consent_records` | subject_id, purpose, policy_version, granted_at, withdrawn_at | Evidence of purpose-specific consent, not a substitute for legal review |

IDs should be opaque and unguessable at public boundaries. Use foreign keys, uniqueness constraints and explicit deletion behavior. Store only the profile and progression fields required for a feature. Do not add a `location_history` table without a reviewed consent, retention and deletion design.

## Geometry and coordinates

Represent a match's selected boundary as a validated polygon or centre point plus configured radius, according to the chosen area UX. Store a suitable SRID and validate bounds/geometry validity. Store forbidden zones only where lawful and operationally supportable. PostGIS `ST_Within` and distance predicates such as `ST_DWithin` can use spatial indexes when used appropriately; benchmark the exact query and coordinate type.

Ephemeral position observations can be held in a volatile store keyed by match and participant, with server timestamp, accuracy, sample sequence and expiration. If an implementation chooses Redis, avoid persistence/backups for exact live coordinates unless a reviewed requirement demands it. Do not put coordinates in logs, analytics events, exception reports or ordinary match event payloads.

## Match recovery records

For the MVP's 3–30-player games, keep transient exact samples in the single match-owning service's volatile memory; do not introduce Redis just for GPS. A process failure discards samples, and players must provide fresh observations after recovery. Persist at most a sample sequence high-water mark and a coarse quality classification, never position or a coordinate-derived exact distance, bearing, route or tile address. Never include coordinates in logs, analytics, checkpoints or event payloads.

`match_checkpoints.state_json` is an internal, schema-versioned snapshot, not a client API. It includes phase, roles, virtual player states, objective/mission progress, absolute timer and cooldown deadlines, active events/zones, ability state, deterministic RNG seed/counter, command sequence high-water marks and revision. Role secrets remain server-side. Validate checksum and schema before restore. Keep one current checkpoint and optionally a small bounded rollback set; prune old checkpoints only after a newer checkpoint and its required event tail are verified.

Persist a checkpoint at match creation/start, every 15 seconds or every 50 accepted state transitions while active (whichever occurs first), and immediately after role/team assignment; capture/elimination/revival; score or mission outcome; pause/resume/end; event/zone/ability activation or removal; host transfer; or any effect whose replay could otherwise be ambiguous. These are starting proposals: measure transaction latency and recovery time in the 30-player pilot and adjust. Do not persist every GPS sample. Persist each committed state-transition event before acknowledging it; checkpoint cadence bounds replay length, while the event log closes the gap.

Append a committed event, advance `matches.revision` and store an eligible checkpoint in one transaction. Enforce unique `(match_id, revision)` for events and `(match_id, actor_id, command_id)` for processed commands. A repeated command returns its original result without reapplying effects. Store retry results without private location data. Use absolute server deadlines so recovery does not restart a timer or cooldown. Pin engine, mode and event schema versions; recover by loading the newest compatible checkpoint and replaying the contiguous event tail. A missing, invalid or unsupported event pauses the match for recovery; never guess the state. Backups are for database disaster recovery, not normal worker restart.

## Retention and deletion

- Guest credentials expire automatically; upgrading a guest account follows an explicit account-linking flow.
- Exact transient positions expire at match end and on cancellation; recovery logic must not resurrect them.
- Checkpoints and events contain no precise GPS and follow the reviewed match/audit retention schedule.
- Match results and minimal events have a retention schedule to be set before launch.
- Account deletion cascades or anonymizes records according to a documented policy and applicable law.
- Consent withdrawal stops future collection; define how it affects an active match before the player opts in.
- Backups, exports and support tooling must follow the same deletion and access policy.

## Indexes and integrity

Index participant lookups by match and player, match status/start time, mode owner/visibility, report status and event `(match_id, revision)`. Add GiST indexes to queried geometries. Use unique `(match_id, revision)` and idempotency keys for command/event handling. Partition high-volume event tables only after measured volume supports the operational cost. Keep large JSON configuration documents schema-versioned and validate them in the service before persistence.

## Open choices

Confirm account provider and guest-to-account merge behavior; exact match/checkpoint/event retention; username uniqueness; public-mode review workflow; database provider/failover and RPO/RTO; and whether any location ever needs durable storage. Default remains no precise location history. These decisions affect privacy and migrations and should precede schema implementation.
