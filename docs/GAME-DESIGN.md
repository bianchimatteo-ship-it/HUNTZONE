# HUNTZONE — Game design

## Match model

A match has a host, a versioned mode configuration, a defined area, a roster, one authoritative server state and a lifecycle: `LOBBY → COUNTDOWN → ACTIVE → RESOLVING → COMPLETED` (or `CANCELLED`). Only the server changes lifecycle and outcome. Players submit actions and location observations; clients render the server's authorized view.

Target roster is 3–30. A creator chooses an arbitrary whole-metre radius from 100 through 3,000 inclusive. The default value and how the area is placed (host-centred, selected point or drawn shape) remain prototype decisions. Safe-area validation and the ability to exclude unsuitable ground take priority over geometric precision.

## Launch mode: CLASSIC HIDE & SEEK

Recommended first playable rules, pending playtest:

- One seeker and the remaining players as hiders. The server assigns roles at match start and announces them privately.
- A configurable hide phase gives hiders time to move within the boundary. The seeker receives no exact hider positions unless the chosen rule enables a limited scan.
- A capture is a server-verified game action subject to a configured proximity threshold and freshness/accuracy requirements for both position samples. The host selects manual confirmation or an automatic rule; false positives can be disputed and reviewed.
- Captured players enter a virtual spectator/captured state. They are never physically restrained. A mode may instead allow a timed release or teammate rescue.
- Hiders win if at least one remains uncaptured when time expires; seekers win if the configured capture goal is reached. Tie and disconnect handling must be explicit in the selected mode.

Exact timing, capture distance, confirmation workflow, role ratio, boundary buffer and sample freshness are tunable prototype parameters, not universal constants. Validate them in stationary and walking trials before public use.

## Mode catalogue

| Mode | Team shape | Distinctive loop | Suitable follow-up |
|---|---|---|---|
| MANHUNT | Hunters vs. fugitives | Search and evade, with configurable capture/escape goals | Yes |
| INFECTED | One or few infected; captured players convert | Pressure compounds as the infected team grows | Yes |
| TEAM HUNT | Multiple teams | Find and capture opposing teams, score by objective | Yes |
| SURVIVAL | Everyone for themselves | Avoid capture or survive to the deadline | Yes |
| TASKS & DECEPTION | Mixed public and secret roles | Complete tasks, gather evidence and expose a saboteur | Later; requires moderation review |
| Original modes | Defined by the approved mechanic set | Composed combinations and new rule presets | Ongoing |

These are presets over a common engine, not separately hard-coded applications.

## Configurable mechanics

### Approved capture and assignment choices

Every lobby selects one compatible capture policy: **RAGGIO** (authorized player requests a capture, server verifies both fresh/accurate positions and distance), **PIN** (target's temporary personal PIN plus the same mandatory server GPS verification, limited attempts and one-use invalidation), or **AUTOMATICA** (server-confirmed proximity maintained for a configured dwell period). A PIN alone is never a capture. The server owns the result; clients submit intent and cannot decide distance or outcome. Exact coordinates remain volatile server state.

Each lobby also selects **RANDOM** or **MANUAL** role/team assignment where its approved mode permits it. RANDOM is generated server-side and cannot be client-seeded. MANUAL lets the lobby administrator assign each participant before start; disclose that the administrator will know the secret roles they assign. Validate complete role/team slots on the server, clear READY only for participants whose assignment changes, and freeze assignments once countdown starts. Unauthorized player views never receive secret roles; a host does not learn secret RANDOM roles simply by hosting.

The systems are approved; numeric thresholds, per-mode compatibility and gameplay outcomes are not. See [BETA-SCOPE.md](BETA-SCOPE.md) for the ordered owner decisions. The current core evaluates evidence and policy state but does not adjudicate a match or issue real PINs.

Mode configuration may enable: manual or automatic capture, distance validation, radar scans, proximity alerts, abilities, virtual freeze, temporary boosts, decoy GPS pings, missions, extraction points, dynamic zones, eliminations, revival, penalties and random events. Every mechanic declares its parameters, permissions, cooldown, duration, visibility and compatible match states.

Freeze blocks virtual actions only. It never blocks physical movement. A decoy ping is a clearly defined in-game false signal; it must not alter, spoof or write device location. Scans and alerts disclose only the minimum information allowed by the mode. Effects should be brief, visible to affected players and testable by the server.

## Mission design and lifecycle

Missions are optional and can be disabled per mode. The editor distinguishes these categories:

| Mission type | Audience and example | Verification / completion rule |
|---|---|---|
| Simple public | Everyone sees an objective, such as activating a virtual relay | Server checks allowed interaction and match phase; visible progress |
| Team | A team shares progress toward two checkpoints | Server aggregates member contributions under one objective ID |
| Secret | One player privately receives a task such as scan a zone | Only assignee sees it; server verifies the approved predicate without disclosing location |
| Individual | Each player has a personal non-secret task | Per-player progress and reward; cap assignments per match |
| Sabotage | Authorized hidden role disables a virtual relay | Server checks role, charge, cooldown and target; repair/expiry is explicit |
| Timed | Complete a task before a server deadline | Deadline is an absolute server timestamp; late claims are rejected |
| Competitive | Teams race to complete a threshold first | Contributions serialize by match revision; tie behavior is declared |

At match start or a configured server trigger, mission generation filters by mode version, phase, player/team eligibility, role, active-mission cap and prior assignments. Use a persisted server seed/counter for random choices or a deterministic rotation for fairness. Assignment is committed before the authorized audience receives it. The client may submit a claim and opaque evidence token; it cannot set progress, rewards or completion directly. The server verifies the claim against committed match state and fresh eligible samples where the predicate needs location. It commits completion, reward and progress atomically and idempotently. Expiry, disconnect, capture, elimination, role conversion and cancellation follow explicit mode policies. Completing an already-expired/terminal mission is rejected.

The simplest first official mode can omit missions entirely. For later modes, add one or two server-verifiable public/team mission types before secret tasks or sabotage. Do not make a physical real-world object or entering an unsafe/private location a required mission condition.

## Dynamic events

Examples include ASTEROID IMPACT (a marked virtual event area), FRACTURE ZONE (a temporary virtual hazard), temporary reveals, power-ups, safe-area changes and surprise missions. Each event specifies eligibility, trigger conditions, probability, duration, area, effect, audience, cooldown, stacking behavior and cancellation behavior. The server chooses the outcome and publishes a sanitized event. Do not send players to a real-world impact point or require them to enter a hazard zone; virtual elimination never maps to real danger.

## Disconnect, reconnect and end states

On connection loss, keep the roster slot for a configurable grace period and retain authoritative match state on the server. Reconnecting players receive a fresh authorized snapshot and resume from server state. Expired disconnects follow the mode's published rule (for example, neutralized/withdrawn); do not silently credit a capture. Host disconnect transfers control according to an explicit policy or pauses/cancels the match. A match end stops location collection immediately and clears transient exact-position state. Process recovery restores committed virtual state and absolute deadlines but deliberately requires new GPS samples; see [technical architecture](TECHNICAL-ARCHITECTURE.md).

## Fairness and safety constraints

- The server validates roles, captures, mission completion, score and event timing.
- Boundary, forbidden-zone, speed and teleport heuristics flag uncertainty; they do not silently prove cheating.
- No mechanic rewards crossing roads, entering private/restricted land, running blindly or disabling device safety features.
- Players can stop sharing and leave. The match communicates the consequence before start.
- Provide a pause/cancel path for unsafe conditions and a simple report flow before public matchmaking.

## Balance and research questions

Test role asymmetry, map readability, GPS drift near the capture threshold, low-end devices, battery impact, accessibility, mixed web/native lobbies and disconnection recovery. Do not finalize numerical balance settings from paper design alone. See [the roadmap](ROADMAP.md).
