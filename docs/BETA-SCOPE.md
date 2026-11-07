# HUNTZONE — Beta scope and pending rule decisions

**Status: evolving implementation scope.** The owner requires all six human-player modes and has requested a complete first rule baseline. See [MODE-RULES.md](MODE-RULES.md). Those written rules are implementation targets; they are not field-validated and no mode is live or server-authoritative. Old proposal rows below remain historical input where their choices have not been replaced by the new baseline.

## Beta boundary

The beta target is a controlled, private, consenting-adult playtest. It includes a web client, a Kotlin Android client for an explicitly started location session, authenticated HTTP/WebSocket services, one authoritative game core, PostgreSQL/PostGIS persistence for durable virtual state, a real licensed map source, and all six modes. The design excludes public matchmaking, public custom modes, open chat, social discovery, persistent GPS history, monetization, and iOS.

The existing `huntzone-review.pages.dev` frontend remains a static Cloudflare Pages site and keeps building from repository root with `npm run build` to `dist`. It does not call an unfinished API or receive backend secrets. A backend will be a separately deployed service only after a provider, budget, and operational owner are approved. No paid service or Cloudflare resource is created by this milestone.

## Confirmed invariants from product documents

- A match has one logical server owner; clients send intents and render authorized projections.
- Match roster is between 3 and 30, with mode-specific bounds below still proposed.
- Radius is any integer from 100 to 3,000 metres inclusive.
- Exact GPS is collected only after explicit in-context consent during an active match. Precise samples are volatile, short-lived server state and never appear in logs, checkpoints, events, or result records.
- Stale, inaccurate, out-of-sequence, or boundary-uncertain samples cannot cause capture or elimination.
- Captures and hazards are virtual. Tracking can be stopped; withdrawal follows the configured pause/neutralization rule.
- Guest identity, invite access, commands, hidden roles, missions, results, timers, and reconnect state are server-authoritative.
- Mode rules are bounded, versioned data. No arbitrary user-authored code is evaluated.

## Owner-approved capture and role-assignment systems — 2026-11-03

These system choices are approved. They do **not** approve a mode's role permissions, numeric values, or win conditions; those remain open below.

### Capture system selected per match

| System | Approved behavior | Still open |
|---|---|---|
| **RAGGIO** | An authorized player requests a virtual capture. The server checks both players' server-held GPS observations, range, accuracy and freshness before adjudicating. | Distance threshold, accuracy/freshness thresholds, confirmation/dispute flow and compatible roles per mode. |
| **PIN** | Each player gets a personal temporary match PIN. A hunter enters a target's PIN, but the server must also verify GPS proximity; PIN alone never captures. Expiry, limited attempts and one-use invalidation are required. | PIN length/format, expiry, attempt count, delivery/display, recovery and capture distance/quality values. |
| **AUTOMATICA** | The server evaluates opposing players' proximity and makes the virtual capture only after configured range, GPS-quality and minimum-dwell conditions are met. | Range, quality thresholds, dwell duration, hysteresis and compatible roles per mode. |

Clients submit intent only. No client can adjudicate capture, derive a trusted distance, or bypass GPS with a PIN. An uncertain sample returns a retry/indeterminate state, never an assumed capture. Exact coordinates stay volatile and are not included in logs, durable state, events, results, or other players' projections.

### Role and team assignment selected per lobby

- **RANDOM:** the server generates and validates the assignment under that mode's role/team slots. The client cannot seed or alter the result. Secret roles are visible only to authorized recipients.
- **MANUAL:** the lobby administrator assigns every participant's role/team before the start. The UI must warn that this reveals the secret roles they assign. The server validates all slots; only affected READY confirmations are cleared after an assignment change. Start freezes the complete assignment, and later arbitrary edits are rejected.
- Player-facing snapshots are authorization-filtered. A manually assigning host is an explicitly informed exception for secret roles they assigned; a host does not gain hidden roles solely by being host when RANDOM is used.

The core now contains pure validators/evaluators for these policy shapes, a capped PIN-attempt state transition, role-slot assignment, manual READY invalidation and role projections. They are reusable policy primitives, not a running service. The mode registry remains `proposal`; the current local UI only saves a selection in browser storage and explicitly labels it as an unapplied preview.

## Concrete mode proposals

The current prototype's concept-card player ranges inform the proposals; they are not approved limits. Shared values and outcomes must be confirmed before a mode can be marked executable. The current game-core registry labels every entry `proposal` and is not a playable ruleset.

| Mode | Proposed roles and loop | Proposed outcome | Open owner decisions |
|---|---|---|---|
| CLASSIC HIDE & SEEK (3–30) | One randomly assigned seeker, remaining players hiders. A capture is a server-verified virtual action. | Hiders win at timeout if at least one remains uncaptured; seeker wins when the configured capture goal is reached. | Capture goal (all hiders or threshold), hide phase, confirmation/dispute policy, role reveal, capture radius/freshness, timeout tie handling. |
| MANHUNT (4–20) | Hunter team searches for a fugitive team. Proposal: hunters are one quarter of the roster, rounded up, with at least one fugitive. | Fugitives survive until the deadline or hunters capture the configured target. | Team ratio, target threshold, hide phase, whether captured players spectate, tie/disconnect handling. |
| INFECTED (5–20) | Proposal: one initial infected player; an eligible capture converts a survivor into infected. | Survivors win if any remain at timeout; infected win at full conversion. | Starting infected count, conversion delay, protection/cooldown, whether converted players retain location consent, timeout and disconnect policy. |
| TEAM HUNT (6–24) | Proposal: two balanced teams; teams capture opponents. | Last team with active players wins. At timeout compare active-player counts; equal counts produce a draw. | Team count/capacity, balance policy, capture target, timeout score, friendly-fire, revival and team-disconnect behavior. |
| SURVIVAL (3–16) | Proposal: free-for-all; each player can request a virtual capture subject to the server's verified proximity policy. | Last active player wins; at timeout the highest active count is a draw unless the owner chooses a score-breaker. | Capture role/authorization model, lives/revival, timeout scoring, minimum sample quality, leave/elimination behavior. |
| TASKS & DECEPTION (6–18) | Proposal: one server-assigned saboteur and a crew. Server issues private, verifiable virtual tasks; no public chat. A bounded accusation/vote action may be considered. | Proposal: crew wins by completing a selected objective threshold or correctly identifying the saboteur; saboteur wins if the objective deadline expires. | Task types and count, whether voting exists, evidence, reveal timing, sabotage effect, tie policy, secret projection, captured-player participation. |

These proposals are intentionally specific enough to review, but remain **unconfirmed**. No values or loop above should be treated as accepted merely because it appears in the registry or implementation plan.

## Cross-mode policy proposals

- Proposed duration input range: 60–7,200 seconds. The prototype's 8–20 minute presets are not a product decision.
- Proposed role assignment uses a server-owned seeded RNG and records the seed/version only in protected server state; it never uses client randomness.
- A reconnecting player receives a fresh authorized snapshot and may resume only while the match's mode policy permits it. A disconnect is not an automatic capture.
- If required location consent is withdrawn, clear volatile samples immediately and neutralize the player or pause the match. The per-mode fallback is still to be approved.
- If GPS quality makes an action indeterminate, reject the action without penalty and explain the retry state.
- A timeout with equal eligible outcomes returns a draw; this is a proposal pending per-mode review.
- Account age policy, initial test group, hosting region, match-result retention, incident owner, and operational pause window remain release gates.

### Temporary policy-schema guardrails (not gameplay approvals)

The current validator caps capture distance/accuracy at 3,000 m, sample age and automatic dwell at 3,600 s, PIN expiry at 86,400 s and attempts at 10. These are defensive schema ceilings to reject unbounded inputs, not recommended match settings or owner-approved gameplay thresholds. Confirm or replace them before a deployed API treats them as product constraints.

## Ordered owner decisions still required

Approved systems above are fixed. The following choices are still proposals; the suggested defaults are for owner review only.

| Priority | Decision | Alternatives | Consequence | Suggested proposal |
|---|---|---|---|---|
| 1 | Per-mode role/team slots, compatibility with each capture system, win thresholds, timer result, and join limits | Approve/replace each concrete mode row; restrict each mode to one capture system or allow all compatible systems | Defines actual match balance, legal actions, and whether a lobby can start | Review each mode's row individually; initially expose only capture systems whose role permissions are fully specified. No mode is startable until its full ruleset is approved. |
| 2 | Capture distance, maximum accuracy, maximum sample age, automatic dwell/hysteresis | Tune in safe stationary/walking pilots; use a conservative first range or offer a small set of presets | Too permissive causes false captures; too strict frustrates play; freshness affects battery/network load | Keep as required, versioned per-mode settings with no silent defaults; pilot conservative values and measure false positives/negatives before fixing them. |
| 3 | PIN format, validity window, tries, display/delivery, recovery | Short numeric PIN vs longer alphanumeric code; per-target cap vs per-match cap; reveal on request vs pre-match | Convenience trades off against guessing, shoulder-surfing and support burden | Use a server-generated, hashed, match-scoped one-use credential; short expiry; small attempt cap; rate-limit actor and match; never store/log plaintext. Numeric values await approval/security review. |
| 4 | RAGGIO confirmation and disputed captures | One authorized hunter action; target acknowledgement; short contest window | Confirmation can reduce false positives but slow play | Begin with one server-validated hunter request and target notification; add dispute flow only if pilot evidence supports it. |
| 5 | Role assignment rules for each mode and host visibility | Mode-specific random counts; balanced random teams; constrained manual choice; allow/disallow host manual setup | Manual setup reveals hidden roles to assigning host; random setup requires auditable server randomness | Keep RANDOM and MANUAL where the approved mode permits; warn the host before manual assignment; use server CSPRNG; filter unauthorized snapshots. |
| 6 | Disconnect, leave, GPS withdrawal and missing-quality behavior per mode | Pause; neutralize/withdraw; host remove; cancel; resume during grace window | Changes fairness and privacy pressure; a disconnect must never silently become capture | Clear exact samples immediately; do not count withdrawal/disconnect as capture; pause or apply explicitly approved neutralized state. Require fresh samples after reconnect. |
| 7 | Gameplay in all six proposed loops (Classic goal/hide phase; Manhunt ratio; Infected conversion; Team Hunt teams/revival; Survival scoring; Tasks objectives/vote/tie) | Approve or replace each mode proposal in the table above | Engine code could encode unintended gameplay and tests could validate the wrong product | Approve each mode-specific rulesheet before marking it executable. Keep Tasks & Deception free of public chat. |
| 8 | Shared duration bounds, roster minimums and result retention | Current prototype bounds vs narrower pilot bounds; minimal result retention vs longer personal statistics | Impacts usability, retention and lifecycle recovery | Confirm bounds and short documented result retention; never retain precise GPS route history by default. |

Until those decisions are recorded, the game-core package may validate configurations and maintain lobby state only. It must reject attempts to start a mode whose `rulesStatus` is not approved.

## Beta acceptance per mode

Each mode must have deterministic unit/property tests for minimum and maximum roster, invalid config, server role assignment, allowed/denied capture or conversion, timer expiry, win/loss/draw, repeated command IDs, simultaneous terminal conditions, disconnect/reconnect, consent withdrawal, stale GPS, and unauthorized snapshots. E2E acceptance requires at least two devices, a server deployment, observed reconnect recovery, persisted results, and a safe controlled field trial. Passing local engine tests alone is not beta evidence.
