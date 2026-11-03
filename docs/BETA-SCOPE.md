# HUNTZONE — Beta scope and pending rule decisions

**Status: design proposal for owner review.** The confirmed product decision is that all six modes belong in the beta. That does not make the rule details below approved. The existing browser application is still a local UI simulation; no mode in this file is live or server-authoritative.

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

## Decisions required before full mode engine implementation

1. Approve or replace each row's role ratios, limits, objective, capture/conversion behavior, timer result and tie rule.
2. Choose Classic capture target and confirmation/dispute path.
3. Confirm whether TEAM HUNT permits revival and how teams are balanced.
4. Confirm TASKS & DECEPTION objectives and whether a non-chat accusation/vote mechanic is in scope.
5. Confirm mode-specific behavior on leave, disconnect, GPS withdrawal, and loss of GPS quality.
6. Confirm the proposed radius/duration bounds and beta roster limits.

Until those decisions are recorded, the game-core package may validate configurations and maintain lobby state only. It must reject attempts to start a mode whose `rulesStatus` is not approved.

## Beta acceptance per mode

Each mode must have deterministic unit/property tests for minimum and maximum roster, invalid config, server role assignment, allowed/denied capture or conversion, timer expiry, win/loss/draw, repeated command IDs, simultaneous terminal conditions, disconnect/reconnect, consent withdrawal, stale GPS, and unauthorized snapshots. E2E acceptance requires at least two devices, a server deployment, observed reconnect recovery, persisted results, and a safe controlled field trial. Passing local engine tests alone is not beta evidence.
