# HUNTZONE — Human multiplayer mode rules

**Implementation baseline, 7 November 2026.** These rules define the first server implementation target requested by the owner. They are not evidence of field balance or a release approval. All effects are virtual, a player may stop and leave, and physical safety takes priority over game outcomes.

## Shared rules

- Only authenticated human sessions in a server-owned lobby are participants. There are no bots, fill players, simulated positions, or client-only matches.
- The server accepts 3–30 participants unless the mode row narrows that range. The host occupies one real participant slot.
- The lobby selects a whole-number play-area radius from 100–3,000 m, a duration from 10–120 minutes, and one capture policy: RAGGIO, PIN, or AUTOMATICA. Initial capture defaults are 20 m, maximum reported accuracy 15 m, maximum sample age 5 s; AUTOMATICA requires 5 continuous seconds. These are conservative engineering defaults for controlled trials, not field-validated balance values. PINs are generated and hashed by the server, are match-scoped, one-use, expire after 90 seconds, and allow three attempts per hunter/target pair. A failed GPS-quality check does not consume a PIN attempt.
- A capture can resolve only when both players gave active-match location consent and the server has fresh, in-sequence observations within the selected accuracy limit. Conservative distance uses reported separation plus both accuracy radii. An uncertain observation is rejected. RAGGIO is a request by an authorized hunter; PIN also requires a valid temporary target PIN; AUTOMATICA requires continuous eligible proximity. A PIN never establishes location or capture on its own.
- A server-issued countdown is 10 seconds. Before it begins, every connected participant must be READY and the host must confirm the roster and role assignment. Editing a role/team clears READY for changed players. Once countdown starts, roster, roles and teams are frozen.
- The server timer uses an absolute deadline. A database or authoritative service interruption pauses location-dependent outcomes. A disconnect or app suspension is never a capture. During a 2-minute reconnect grace period the player retains their virtual state; after expiry they become withdrawn, not captured. If the host disconnects, the match pauses and host controls transfer to the longest-connected remaining participant. If no host returns within 5 minutes, the match is cancelled without a winner.
- Location sharing stops on completion, cancellation, withdrawal, or consent revocation. Revocation clears the volatile sample immediately and withdraws that participant. Precise coordinates are not persisted or included in events, checkpoints, logs, snapshots for other players, or results.
- Role assignment is server-random by default. MANUAL assignment is allowed only before start and requires an explicit host acknowledgement that assigned secret roles become visible to that host. Secret roles are otherwise private.

## CLASSIC HIDE & SEEK — `classic-hide-and-seek`

- **Roster:** 3–30. One seeker, all others hiders. The host is eligible for either role.
- **Opening:** 60-second hider head start. The seeker sees the selected field boundary but no hider locations. Location tracking begins only after each participant's explicit consent and match start.
- **Actions:** only the seeker can request RAGGIO/PIN capture or trigger an eligible AUTOMATICA capture against a hider. Captured hiders become virtual spectators and stop sharing GPS. No rescue in the first rules version.
- **Win:** seeker wins when every hider is captured or withdrawn; hiders win when the deadline expires with at least one active hider. If all hiders withdraw, the match is cancelled without a winner. A seeker's withdrawal pauses for host transfer, then cancels if no eligible seeker remains.

## MANHUNT — `manhunt`

- **Roster:** 4–20. Hunters are `ceil(roster / 4)`, at least one; remaining participants are fugitives.
- **Opening:** 60-second fugitive head start. Hunters know the field boundary only.
- **Actions:** hunters may capture fugitives under the lobby's selected capture policy. Captured fugitives spectate; they are not converted or reassigned.
- **Win:** hunters win when no active fugitives remain; fugitives win at the deadline if any remain. If every fugitive withdraws, cancel without a winner. A hunter withdrawal does not count toward captures; if all hunters withdraw, pause for host transfer and cancel if none can resume.

## INFECTED — `infected`

- **Roster:** 5–20. One initial infected; all others begin as survivors.
- **Opening:** 60-second survivor head start. Infected cannot capture another infected player.
- **Actions:** a valid capture converts its target to infected after a 10-second visible conversion countdown. The target can continue moving and sharing only with continuing consent; virtual conversion never restrains movement. No immunity or revival in the first version.
- **Win:** infected win when no active survivors remain; survivors win at the deadline if any remain. If all survivors withdraw, infected win only if an eligible active infected remains; otherwise cancel. An infected withdrawal never creates a conversion.

## TEAM HUNT — `team-hunt`

- **Roster:** 6–24. Two teams, alternating assignment for balanced counts; MANUAL assignment must leave each team with at least three players.
- **Opening:** 30-second simultaneous preparation. Team members see their own team roster; opponents' exact positions remain hidden.
- **Actions:** capture opponents only. Friendly capture requests are rejected. Captured players are eliminated from active play and spectate; no revival or capture score in version one.
- **Win:** the last team with an active participant wins. At the deadline, compare active participants per team; a tie is a draw. If all active participants withdraw, cancel without a winner.

## SURVIVAL — `survival`

- **Roster:** 3–16. Free-for-all; every participant is an eligible captor and target while active.
- **Opening:** 30-second simultaneous preparation.
- **Actions:** a player can request capture against any other active player under the selected policy. Self-capture and repeated capture are rejected. Captured players spectate; no lives or revival in version one.
- **Win:** the last active participant wins. At the deadline, the sole remaining active player wins; multiple active players produce a draw. Withdrawals reduce active roster but never count as captures.

## TASKS & DECEPTION — `tasks-and-deception`

- **Roster:** 6–18. One secret saboteur, all others crew. The saboteur is assigned server-side; the host sees the role only if they explicitly used MANUAL assignment.
- **Opening:** 30-second preparation. The server assigns each crew member three private, virtual tasks from a versioned safe task catalogue; no public chat, physical object, restricted land, or unsafe real-world destination is required.
- **Actions:** crew submit task-completion intents for server validation and share aggregate progress. The saboteur may spend one of two sabotage charges to pause task progress for 60 seconds, with a 180-second cooldown; the effect is virtual and disclosed as an event without revealing the saboteur. Direct capture is disabled in version one. A crew report can start a 30-second anonymous vote; a correct majority vote reveals and removes the saboteur virtually, while a wrong vote costs the crew one task point. Voting is optional and can be disabled by the lobby.
- **Win:** crew win after the roster's configured task threshold (default 3 completed tasks per crew member) or a correct majority vote. The saboteur wins if the deadline expires first or if active crew count reaches parity with the saboteur after withdrawals. If the saboteur withdraws, crew win; if fewer than four crew remain, cancel without a winner.

## Public readiness state

**Readiness (November 2026):** the server enables CLASSIC HIDE & SEEK only. It enforces three or more connected, READY participants; area selection; per-player GPS consent; fresh server-validated location samples; the host-only countdown and private roles; RAGGIO/PIN captures; automatic proximity captures; withdrawal; and deadline results. Live coordinates stay in process memory and are not included in snapshots, events, or checkpoints. The browser tracker requires the page to remain in the foreground. These code paths still need the PostGIS-backed CI run and a real three-device field session before the mode can be called field-validated or publicly playable. The other five modes remain **IN SVILUPPO** and cannot start.
