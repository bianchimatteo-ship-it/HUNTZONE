# HUNTZONE — Custom modes and rule engine

## Goals and boundaries

Creators need a quick way to tune presets and a visual way to compose new experiences. Both produce a validated, versioned declarative configuration for the same server-authoritative engine. The editor never accepts or evaluates user-authored source code, expressions, network requests or plugins.

## Two editor levels

**Quick editor:** starts from a published preset, exposes safe mode-specific settings with defaults, ranges and plain-language previews, then saves a private copy. It supports player/team counts, roles, duration, radius, win conditions, capture, visibility/radar, abilities, tasks, events, eliminations, revival, penalties and restrictions when relevant.

**Advanced editor:** a visual sequence/flow of allow-listed triggers, conditions and effects. It offers templates, compatibility hints, a live rules summary and validation errors before save. Examples include hide-and-seek plus tasks and a saboteur; or radar plus temporary zones and cooldown-limited abilities.

## Proposed configuration contract

Illustrative shape only; implementation should define a versioned schema and typed domain model before clients are built:

```json
{
  "schemaVersion": 1,
  "engineVersion": "1",
  "baseMode": "classic-hide-and-seek",
  "limits": { "minPlayers": 3, "maxPlayers": 12, "radiusMeters": 512, "durationSeconds": 900 },
  "roles": [{ "id": "seeker", "assignment": "random", "count": 1 }],
  "rules": [{ "id": "capture", "when": { "event": "capture.requested" }, "if": [{ "op": "withinMeters", "value": 8 }], "then": [{ "effect": "capturePlayer" }] }],
  "mechanics": { "radar": { "enabled": false }, "missions": { "enabled": false } }
}
```

The actual schema must distinguish player-authored settings from trusted server mechanics. Operators are selected from a finite catalogue; there is no general-purpose script, arbitrary SQL, reflection, unbounded nesting or user-defined code execution.

## Validation and execution

The owner-approved lobby policy has two explicit selectors: capture method (`radius`, `pin`, or `automatic`) and role/team assignment (`random` or `manual`), subject to an approved mode's compatibility rules. PIN verification always requires server GPS evidence, has finite expiry/attempt state, and is invalidated after successful use. Manual assignment is complete before start, is host-authorized, invalidates READY for changed assignments, and freezes at countdown. These policy primitives do not approve the mode's gameplay rules or numeric settings. The game core validates their shapes; a server adapter must supply CSPRNG, credential hashing/comparison, persistent attempt limits, authentication, GPS ingestion and transport authorization.

Validate in layers: schema/version; type and numeric bounds; cross-field consistency; mechanic compatibility; safety rules; estimated event/action budgets; then authorization and publishability. Reject unknown fields and unsupported versions. Normalize units. Enforce maximum rule count, nesting, evaluation steps, event fan-out and output size. Detect unreachable rules and conflicting terminal outcomes where feasible. Return field-addressable errors for editor display.

At publish time, compile the declarative document into a canonical intermediate representation (IR). The server runs only IR operators shipped and reviewed with the game engine. Inputs are typed, actions are deterministic given the match state and server event, and outputs are bounded. Randomness uses server-owned seeds and is recorded as an event outcome. Rule evaluation runs within the match actor's bounded tick/action budget; over-budget rules fail closed and are reported without blocking the whole server.

Each match pins an immutable mode version and engine compatibility version. Editing creates a new draft/version; active matches do not change underneath players. Retire unsafe or incompatible definitions without rewriting match history. Presets can be curated and community modes reviewed before public listing.

## Event and action vocabulary

Initial event candidates: `match.started`, `timer.elapsed`, `player.entered_zone`, `capture.requested`, `task.completed`, `scan.activated`, `cooldown.ready`, `player.disconnected`, `event.spawned`. Initial effects: assign/convert role, capture/release, award non-purchasable score, reveal an approved location approximation, spawn a virtual event/zone, start timer, grant/remove an ability, notify a permitted audience, end/pause match.

The exact catalogue is an implementation contract to finalize before coding. Location predicates receive server-normalized observations and expose only approved predicates (for example, distance band or entered/exited zone); user rules cannot query raw location history or other players' private data.

## Mechanic catalogue (proposed v1 operator contract)

The table is the approved-design proposal for a first visual editor catalogue. Values marked `owner-only` are host setup controls; `server` means the effect is adjudicated by the authoritative engine. Numeric defaults and ranges must be finalized in the schema and playtested before launch. All durations are virtual match time. A mechanic omitted from a mode is disabled. An editor may hide incompatible options but must explain why.

| Mechanic | Description and parameters | Requirements and compatibility | Server effect, cooldown/duration, limits and permissions | Conflict behavior |
|---|---|---|---|---|
| Role assignment | Named role, count or ratio, random/host-assigned assignment, visibility and team | Requires enough players; counts must sum to roster; hidden roles need private projections | Server assigns once at start; host may configure before start but cannot read hidden role secrets after assignment unless the mode authorizes it | Reject impossible counts; freeze assignment after start except explicit conversion |
| Teams | Team IDs, capacity, friendly-fire/capture policy, team objective | Requires at least two teams; compatible with team missions, shared lives and team scoring | Server owns membership; no cooldown; roster bounded by match cap | A role's team must be explicit; reject roles with contradictory team membership |
| Public mission | Objective visible to all or an audience; type, target count/zone, reward, deadline | Requires mission verifier and allowed objective type; compatible with all modes that permit objectives | Server creates/assigns and verifies completion; one-shot or configured repeat limit; creator can enable before match | Competing identical objectives deduplicated by ID; no reward if terminal match state already committed |
| Team mission | Shared progress for one/all teams; target, threshold, deadline, reward | Requires teams; can coexist with individual tasks | Server aggregates authorized contributions; expiry is explicit; per-team active count bounded | Progress is serialized per objective; cancellation does not erase an already committed reward |
| Secret mission | Private objective and reward for one player/team; assignment policy and deadline | Requires private delivery and server-verifiable objective; hidden role/mission support | Server sends only to assignee; finite active slots, no client-authored completion; optional cooldown between assignments | Secret task cannot reveal protected player location; role changes revalidate or cancel mission by configured policy |
| Individual mission | Personal objective, target and reward | Requires player-specific verifier; compatible with any living/active role | Server tracks per-player progress; configured cap per player; completion is idempotent | If player is captured/eliminated, pause, fail or preserve progress according to explicit mode setting |
| Sabotage mission | Hidden objective that disrupts a virtual objective/system; sabotage type and severity | Requires saboteur/traitor role or explicitly public sabotage; requires repair/mitigation rule where reversible | Server applies bounded virtual effect; finite charges, cooldown and duration; no physical device interaction or real-world target | Multiple sabotages of same target either refresh to capped duration or are rejected; policy fixed in mode config |
| Traitor/saboteur role | Hidden faction or role with allowed sabotage actions; count, assignment, reveal and win relation | Requires secret-role delivery, mission/sabotage operators and deception-safe UI | Server assigns and authorizes actions; no arbitrary impersonation; role change event is private except when reveal rule fires | Incompatible with hidden assignment disabled or automatic public role broadcast; false/rejected actions do not reveal identity |
| Capture | Manual request or automatic proximity rule; distance threshold, sample freshness/accuracy, confirmation and dispute policy | Requires active location observations for involved players and an allowed role relation | Server evaluates latest eligible volatile samples; one capture per target per life; cooldown prevents repeat attempts; captured is virtual state only | Stale/poor GPS yields `indeterminate`; capture and elimination are mutually exclusive terminal outcomes unless explicit revive rules permit transition |
| Elimination | Virtual removal, spectator state, respawn eligibility, lives and scoring | Requires win-condition behavior for eliminated players; may be independent of GPS | Server changes virtual state; no physical restriction; optional finite respawn window | Elimination wins over concurrent non-terminal reward only by committed event order; cannot silently erase a capture record |
| Ability/power | Named allow-listed action, target scope, charges, range predicate, cooldown and duration | Requires a registered ability and role/team permission; must declare whether location freshness is required | Server validates charge, permission, cooldown and target; cooldown starts on committed activation; duration expires by server deadline | Same exclusive ability group cannot stack; choose reject, replace or refresh in immutable config |
| Virtual freeze | Blocks specified game actions for target(s); duration and blocked-action list | Requires active player target; compatible with capture, missions and timer only if each blocked action is listed | Never blocks physical movement or OS interaction; server ignores blocked game commands; strict duration cap and immunity policy; permission via role/ability/event | Repeated freeze follows capped refresh policy; immunity/resistance wins over freeze; match-end always clears effect |
| Radar/scan | Reveals an approved approximation (presence, bearing band or zone) to an audience; range, accuracy class, duration, cooldown | Requires location sharing and a mode visibility policy; compatible with decoy pings only if signal type is labeled | Server computes output from current eligible samples; never emits raw coordinates; charge/cooldown and maximum target count bounded | A decoy signal may be shown as a candidate, not converted into true location; stale sample returns no result |
| Virtual decoy ping | Creates a false in-game location signal, signal type, area offset rule, audience, lifespan | Requires radar/scan or map signal display; explicitly does not alter device GPS | Server generates a bounded virtual marker from a server seed/config; lifetime and active-marker count capped; only authorized roles may deploy | Does not affect boundary, capture, safety, GPS validation or any true-location API; true player state always wins for authoritative mechanics |
| Bonus/power-up | Temporary or charged benefit; type, eligibility, spawn/award rule, duration and cap | Requires registered effect; may be time/zone/event spawned | Server grants finite inventory or virtual modifier; expires on deadline or match end; no paid competitive advantage | Same modifier stacks only if declared; otherwise reject duplicate or replace by configured priority |
| ASTEROID IMPACT | Announced virtual impact marker/zone and effect; eligible area, warning time, radius, duration, chance | Requires dynamic-zone support and safe-area constraints; no real-world hazard | Server selects a legal in-bounds location, announces warning, then applies virtual effect; active count and cadence capped | Never spawn in forbidden/excluded geometry; if no safe placement exists, skip and log the virtual event |
| FRACTURE ZONE | Temporary virtual penalty area; geometry, duration, warning, effect and recurrence | Requires boundary geometry and safe area; may coexist with objectives | Server applies only configured virtual scoring/action effects; bounded size/lifetime/count; no physical danger language | Intersecting zones merge only under explicit rule; otherwise higher-priority event controls effect and both remain visually distinguishable |
| Dynamic safe zone | Changes permitted game area; target geometry/radius, shrink schedule, warning and boundary grace | Requires an initial area and no-go geometry; incompatible with a fixed-boundary-only mode | Server changes virtual eligibility on a deadline; warning sent first; hysteresis/grace reduces GPS jitter | Safe area must remain inside creator boundary and outside forbidden zones; reject invalid geometry rather than relocate players physically |
| Extraction point | Virtual exit objective; locations/placement method, eligible role/team, dwell/interaction condition, quota and deadline | Requires objective/win-condition operator and safe in-bounds point | Server validates approach using fresh location and optional stopped dwell; completion is virtual; no real-world race/speed requirement | Competing extraction claims serialized; if zone becomes forbidden/unsafe, disable it and trigger configured fallback or cancel match |
| Timed event | Trigger at elapsed time or deadline; event, audience, repeat interval and limits | Requires registered event and legal match phase | Server scheduler emits once per event key; cooldown/repeat cap; owner sets schedule before start | Same event key is idempotent; event after match terminal state is discarded |
| Random event | Weighted event pool, eligible phases, probability/interval, exclusions and seed policy | Requires at least two compatible registered events and server RNG | Server selects from allowed pool using persisted seed/counter; hard cap on draws and active events | Filter incompatible options before draw; if none remain, skip draw; never retry-until-success without a bounded attempt limit |
| Win condition | All/any configured terminal predicates, priority/tie policy, deadline outcome | Requires at least one terminal path and an explicit no-winner/tie result | Server evaluates after committed state transitions; only one terminal outcome per match | If multiple predicates become true in one revision, use declared priority then stable predicate ID; record all satisfied predicates for audit |

### Compatibility matrix

Legend: **Y** supported together when each row's requirements are met; **C** supported with explicit conflict/priority configuration; **N** reject the combination in schema validation. Matrix groups are defaults for v1; individual mechanic details above take precedence. Rows/columns: `R` roles/teams, `M` missions (all kinds), `D` deception/traitor/sabotage, `C` capture/elimination, `A` abilities/freeze, `S` radar/decoys, `E` timed/random events and hazards, `Z` dynamic zones, `X` extraction, `W` win conditions.

| | R | M | D | C | A | S | E | Z | X | W |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| R | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| M | Y | Y | C | Y | C | C | C | C | Y | C |
| D | Y | C | Y | C | Y | C | C | C | C | C |
| C | Y | Y | C | C | C | Y | C | C | C | C |
| A | Y | C | Y | C | C | C | C | C | C | C |
| S | Y | C | C | Y | C | C | C | C | Y | C |
| E | Y | C | C | C | C | C | C | C | C | C |
| Z | Y | C | C | C | C | C | C | C | C | C |
| X | Y | Y | C | C | C | Y | C | C | C | C |
| W | Y | C | C | C | C | C | C | C | C | Y |

Hard rejects: arbitrary code; a mechanic that requires location when location is disabled; traitor/sabotage without private-role delivery; team mission without teams; decoy pings that feed capture or boundary validation; extraction outside permitted geometry; freeze interpreted as physical immobilization; terminal conditions without tie/priority behavior. `C` means the saved mode must declare stacking, priority, audience, terminal handling and fallback; otherwise validation rejects it.

## Example custom modes

Examples illustrate supported composition, not final balance settings. Config shorthand below is declarative and must be validated into the versioned IR; it is never executable source.

### 1. BLACKOUT PROTOCOL — hide-and-seek, secret missions, traitors and sabotage

12 players; 2 seekers, 8 runners, 2 hidden saboteurs; 15-minute match; 3 public relay missions and one private objective per player. Saboteurs may disable a virtual relay for 60 seconds, with one action every 3 minutes. Runners win by completing 2 of 3 relays and extracting; seekers win by capturing all runners; saboteurs win if the deadline expires with fewer than 2 relays active. Capture samples must be fresh; scans reveal zones, while a saboteur can plant one false radar ping. This mode uses private role/mission projections, sabotage repair, relay objective, capture, extraction and explicit multi-faction terminal priority.

```json
{"schemaVersion":1,"baseMode":"classic-hide-and-seek","limits":{"minPlayers":8,"maxPlayers":12,"radiusMeters":840,"durationSeconds":900},"roles":[{"id":"seeker","count":2,"assignment":"random","visibility":"private"},{"id":"runner","count":8,"assignment":"remaining","visibility":"private"},{"id":"saboteur","count":2,"assignment":"random","visibility":"private"}],"mechanics":{"missions":{"public":{"enabled":true,"count":3},"secret":{"enabled":true,"perPlayer":1}},"sabotage":{"enabled":true,"charges":1,"cooldownSeconds":180,"durationSeconds":60},"radar":{"enabled":true,"reveal":"zone"},"decoyPing":{"enabled":true,"maxActive":1},"capture":{"enabled":true,"sampleMaxAgeSeconds":10},"extraction":{"enabled":true,"requiredRelays":2}},"winPriority":["seekers_all_runners_captured","runners_extract","saboteurs_deadline"]}
```

### 2. SIGNAL RUN — team missions and competitive extraction

Two teams of 4–10; three public checkpoints represented as virtual objectives; first team to verify two objectives and reach its extraction quota wins. No player capture; scans give coarse presence only. A timed event relocates one objective after warning. Compatible engine features: teams, public/team mission, extraction, radar, timed event, team win condition.

### 3. LAST LIGHT — survival with bounded dynamic zones

6–20 players, free-for-all, 12 minutes. Players gain survival points at scheduled intervals; temporary virtual fracture zones and a warned safe-zone change alter scoring eligibility. No elimination on location loss; stale samples pause eligibility. Winner is highest server score among eligible players, with survival duration and then stable participant ID as tie-breakers.

### 4. INFECTED RELAY — conversion, abilities and team objective

One initial infected converts a captured player; survivors activate two relays to unlock extraction. Infected have a short cooldown after conversion; survivors receive one short virtual freeze-resist ability. Reaching the survivor goal before all convert wins; otherwise infected win at full conversion or timeout according to a declared tie rule. Uses roles, capture, conversion, team missions, ability, extraction.

### 5. ASTEROID TAG — rotating hunter and event dodge

One hunter tags runners; server periodically announces a virtual asteroid-impact zone and spawns a capped bonus outside forbidden areas. Zone effects only change virtual score/visibility. A warned safe area and fixed boundary prevent players being directed toward hazards. Uses capture, role rotation, timed/random event, bonus, safe-zone predicate; excludes physical movement penalty.

### 6. QUIET SIGNAL — radar deception without elimination

Two teams gather scan tokens and identify opposing presence zones. Each team may deploy capped decoy pings; team score comes from correctly verified zone claims. No exact positions are shown and no capture is possible. Wrong claims spend a token. Uses teams, scan, decoy, public mission and score win condition; capture is explicitly disabled.

## Reference lifecycle for a mission

1. At match start or configured trigger, the server filters eligible players/teams by role, capacity, prior assignments and mode version.
2. It selects a mission using a persisted server RNG seed/counter (or deterministic round-robin for non-random allocation), writes `mission.assigned` and updates the checkpoint in the same transaction, then sends only the authorized audience its projection.
3. A client submits a completion claim with mission ID and evidence token/command ID. Location evidence stays transient; the client cannot set progress directly.
4. The server verifies the allowed condition from committed game state and current eligible observations, checks deadline, assignment, idempotency and limits, then commits `mission.completed` or a structured rejection.
5. Reward and progress update in the same state transition. Expiry, role change, disconnect and match end follow the mission's configured policy; no expired mission can be completed retroactively.

## Save, share and operate

Modes have owner, visibility (`private`, `link-only`, `public`), immutable versions, tags, compatibility, moderation state and timestamps. Share links use unguessable identifiers with access checks. Copying a mode creates an owned draft. Public publishing needs report, review, unpublish and audit paths. Track use and safety reports; do not expose creator analytics containing other players' location.

## Acceptance criteria for a future implementation

- Invalid ranges, incompatible mechanics, unknown operators and unsupported versions are rejected with useful editor errors.
- Client edits cannot bypass server validation or affect an active pinned version.
- No arbitrary user code executes.
- Evaluation limits are enforced under adversarial configurations.
- The same input sequence and recorded server randomness reproduce the same mode outcome in a replay harness.
- Private and link-only mode access is enforced for read, edit, copy and publish operations.
- Every catalogue operator declares requirements, compatible states, permission, duration/cooldown or an explicit `none`, limits, effect and conflict policy.
- Compatibility validation rejects hard conflicts and requires explicit policy for `C` combinations.
- Example modes validate without arbitrary code and pin their version to a match.
