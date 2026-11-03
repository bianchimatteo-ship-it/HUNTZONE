# HUNTZONE — Test and acceptance plan

## Purpose and policy

This is the verification plan for later implementation, not evidence that software exists or has passed tests. Separate deterministic automated checks, device/platform checks and safe field trials. Record build/version, mode/engine version, test venue category, device/browser/OS, sample cadence, network conditions, expected result, observed result and defects. Use synthetic coordinates and fixtures for automated tests. Field tests require informed adult participants, a safe permitted venue and a stop/pause plan.

The owner has confirmed all six modes are beta requirements. See [BETA-SCOPE.md](BETA-SCOPE.md) for proposals that remain unapproved. A mode is not accepted from a passing configuration test alone: the complete authoritative lifecycle, multi-client behavior, GPS policy, result persistence and field criteria must pass.

Do not invent throughput, latency, battery or accuracy targets before collecting a baseline. For each performance threshold below marked **set from pilot**, first record a baseline on the intended deployment and representative devices, agree a service/user target, then make it a release gate. Functional invariants such as “no duplicate outcome” are hard acceptance criteria immediately.

## Test layers

1. **Game-core unit/property tests:** state transitions, role authorization, rules, timers and invariant preservation with deterministic RNG.
2. **Persistence/recovery integration tests:** real transactional database behavior, checkpoint restore, event replay, duplicate commands and crash boundaries.
3. **API/realtime contract tests:** auth, versioning, idempotency, reconnect snapshots/deltas and per-player privacy projections.
4. **Web UI/browser tests:** permission prompts, map creation, lobby, stale state, responsive controls and ordinary flow.
5. **Platform/device tests:** browser GPS, Android native background service in its later phase, permission withdrawal, OS process lifecycle, battery and reconnect.
6. **Field playtests:** consenting groups in a safe controlled area; inspect human comprehension, location quality, capture fairness and safety behavior.
7. **Security and load tests:** abuse cases, data access, rule limits, WebSocket fan-out, database outage and recovery under agreed pilot load.

## Functional acceptance matrix

| Area | Required scenarios | Acceptance criteria |
|---|---|---|
| Multiplayer and lobby | 3-player minimum; 30-player cap; concurrent joins; duplicate invite; full/closed lobby; host disconnect; private code guessing | Roster never exceeds configured cap; only authorized participants join; duplicate join is idempotent; host control follows declared handoff/pause policy; no match starts below min-player rule |
| Match lifecycle | Lobby/countdown/active/paused/resolving/completed/cancelled transitions; invalid transition requests | Only server-authorized transitions succeed; terminal result committed once; commands after terminal state are rejected; each transition carries increasing match revision |
| Persistence | Checkpoint recovery at start, periodic threshold and critical state; event-tail replay; corrupt/unsupported checkpoint; missing event | Restored roles, virtual states, objective progress and absolute deadlines equal committed state; invalid history pauses/cancels explicitly; no GPS coordinate is present in DB checkpoint/event fixtures |
| Crash windows | Kill worker before DB commit, after commit before acknowledgement, after acknowledgement before socket publish, during replay | No uncommitted result is acknowledged; retry with same command ID returns same result; committed transition appears exactly once after reconnect; recovery does not resume play before restore validation |
| Database failure | Connection timeout, read/write unavailable, failover/restart, backup restore exercise; actor survives vs actor crashes during outage | New matches and unpersistable state changes are rejected/paused; no client is told an uncommitted outcome succeeded; surviving actor shifts deadlines by measured monotonic pause before resume; if pause duration is unknown after crash, match stays paused or cancels; service returns with consistent event revision; RPO/RTO assessed against chosen provider, not assumed |
| Reconnection | Drop socket before/after committed commands; stale client revision; reconnect within and beyond grace period; session revoked | Client gets fresh authorized snapshot or contiguous events; no repeated capture/score/mission reward; expired participant follows published rule; secrets remain filtered |
| GPS permissions | Grant/deny/approximate, disable system location, revoke during lobby and active match, change browser tab/screen state | Permission requested only in context; denied/unavailable states are actionable; withdrawal stops collection and removes volatile samples; match pauses/neutralizes according to mode; no continued location request after end |
| GPS freshness and accuracy | Old samples, future timestamps, duplicated/out-of-order sequence, poor accuracy, clock drift, no fix, urban multipath | Server uses receipt age and configured freshness/accuracy policy; stale/uncertain input never causes a capture; response exposes a useful retry/degraded state without sharing coordinates |
| GPS spoof/anomaly | Impossible jumps, stationary repeat, simulated location, manipulated client clock, API payload alteration | Anomalies are flagged and rate-limited; no one signal is treated as proof; legitimate poor signal does not trigger automatic ban; client cannot submit authoritative position for another player |
| Capture | Just inside/outside configured threshold; threshold edge with accuracy overlap; stale player; simultaneous claims; duplicate claim; role-ineligible caller; dispute | Only eligible roles and fresh samples can capture; uncertain edge returns indeterminate; one terminal transition per target/life; duplicate command is idempotent; result is server-derived and auditable without stored coordinates |
| Boundaries and forbidden areas | Radii 100 m, 3,000 m, non-round integers; inside/outside/grace band; accuracy circle crossing boundary; invalid geometry; forbidden zone overlaps centre/event | Every integer in range is accepted; values outside range rejected; uncertain edge receives grace, not penalty; invalid or unsafe geometry is rejected; forbidden polygon overrides play/event/mission placement |
| Mission generation | Public/team/secret/individual/sabotage/timed/competitive; insufficient eligible players; duplicate random seed; expiry; disconnect/role conversion | Assignment is committed before private/public delivery; only authorized audience sees secrets; server alone verifies completion; same seed/state reproduces assignment; expired, duplicate or ineligible claims cannot award twice |
| Modes and mechanics | Each enabled catalogue operator; disabled mechanic; invalid parameter; role/team count boundaries; active version edited by creator | Schema validation accepts supported combinations and rejects hard conflicts; active match remains pinned to immutable version; disabled mechanic has no effect; unsupported versions fail clearly |
| Compatibility/editor | Every matrix `Y`, `C`, `N` pair; hidden role without private channel; decoy with capture; freeze, hazard overlap, contradictory terminal rules | Hard `N` combinations reject; `C` requires explicit policy; `Y` obeys declared requirements; invalid config never reaches active engine; editor surfaces field-level errors |
| Events and zones | Timed/random event duplicate trigger; no legal spawn area; event at match end; intersecting zones; zone shrink boundary case | Event key is idempotent; no safe location means event skipped, not relocated unsafely; terminal match blocks later event; stacking/priority matches config; every change has warning and server revision |
| Security/privacy | Cross-player snapshot reads; role/mission enumeration; invite brute force; replay; oversized messages; log scan; DB dump fixture; account deletion | Authorization denies unauthorized reads/actions; secrets are absent from unauthorized projections; rate and size limits apply; no raw GPS in logs/persistent fixtures; deletion follows documented retention/backup path |
| Map/country coverage | Tile/map rendering in pilot cities/countries; road/path/park detail; language; tile provider outage; attribution; geocoding disabled | Test matrix is completed for intended launch markets; attribution remains visible; provider outage produces graceful map-degraded state; unsafe area selection can be rejected; no claim of coverage beyond evidence |
| Responsive UI/accessibility | Narrow phone viewport, sunlight contrast, large text, keyboard/screen reader web, focus, reduced motion | Core create/join/lobby/match/result flow completes without secondary pages; touch actions are large and labeled; status is not color-only; keyboard focus and screen-reader name/state are usable |
| Compatibility | Current supported browsers; later web/Android mixed lobby; protocol version mismatch | Supported matrix is documented; web MVP behaves within browser capabilities; incompatible protocol produces upgrade/rejoin message; a client never becomes authority |
| Performance/load | 30 active players per match; many rooms; reconnect burst; DB checkpoint bursts; slow consumer | Complete the target workload without state loss, unbounded queue growth or duplicate effects. Measure p50/p95 command handling, event fan-out, DB latency, actor lag and reconnect recovery; set numeric release targets after pilot baseline |

## Web GPS/map picker milestone — 2026-11-03

Automated tests mock `navigator.geolocation`; they do not request the operator's physical location. They cover permission denial, unavailable/timeout errors, success and successive samples, invalid coordinates/accuracy, stale age, permission revocation, duplicate-start prevention, watch options and stop/unmount cleanup. Geometry tests cover every-integer radius validation, selected centre/radius changes, geodesic polygons, device accuracy rings, invalid coordinates and antimeridian splitting. Map adapter tests cover Stadia EU style selection, overlays, tap-to-select, separate centre/position markers, retry state and cleanup.

Browser release checks must also verify, on the deployed HTTPS hostname, that Stadia style/tiles load with browser-generated `Origin` and `Referer`, that the configured domain is authorized without an API key, and that provider failures never leave a schematic map in the Create flow. Confirm the response referrer policy is `strict-origin-when-cross-origin`. Localhost keyless access should be exercised separately and may be rate-limited. Do not count an HTTP 200 for the static HTML or a mocked map as successful tile authentication.

Manual device checklist remains required: iPhone Safari and Android Chrome over HTTPS; grant/deny/revoke permission; stop tracking and leave Create; switch tabs/background and return; rotate the device and open the keyboard; operate pan/zoom and radius with touch; choose a manual centre without GPS; use GPS to centre the view and separately set the play-area centre; inspect accuracy/age/stale status and attribution; confirm no coordinate in local/session storage or URL. Desktop browser: keyboard focus/zoom, denial, unsupported state, map retry, and browser network request headers. This milestone must not claim physical GPS quality or background tracking without those field checks.
| Battery/network | Foreground web and later Android screen-off play; stationary vs moving; poor network; low-power mode | Measure mAh/percent over a controlled session, GPS sample age, bytes/player/hour and OS throttling. Product owner sets acceptable budget after representative-device baseline; adapt cadence and pause fairly when samples stale |
| Crossplay | Same match with web and Android, different location cadence and permission behavior | Shared server rules and results are identical; per-platform capability differences are visible; no client-specific shortcut bypasses server validation |

## Recovery test recipe

For every state-changing command class, inject a worker termination at these boundaries: before transaction; during transaction; immediately after commit; before WebSocket publish; and during checkpoint replay. Restart the worker with the same pinned engine version. Verify revision continuity, command deduplication, exact virtual state restoration, authorized snapshot filtering, timer/cooldown deadlines and explicit pause state. Confirm exact GPS is absent from the checkpoint/event rows before and after recovery and that each player must send a new fresh observation before location rules resume.

Repeat with database connection loss, failover and a restored backup. The backup exercise is a separate disaster-recovery drill; report actual recovery time and data loss, then agree provider-specific RPO/RTO. Do not claim high availability merely because backups exist.

## Field test protocol

1. Use a permitted park/open public site with host-defined excluded roads, water, construction and private land. Do not run near traffic or direct people to hazards.
2. Start with a tabletop walkthrough, then a small consenting adult group, then 3 and 30 participants only when operationally safe and feasible.
3. Test open sky, tree/building obstruction, stationary and walking, browser foreground/background transitions, mobile network loss and reconnect.
4. Record accuracy, age, boundary uncertainty, false capture/rejection, battery, data use and participant comprehension; do not collect route history.
5. Stop the session if a participant enters an unsafe area, loses safe connectivity, or asks to stop. Verify withdrawal/end cleanup.
6. Review incidents and false positives before widening the pilot. No numeric accuracy or battery claim is published until measured across representative devices and locations.

## Six-mode beta gate

All capture and assignment checks also run through the shared core suite: policy validation rejects missing PIN protections/automatic dwell and unknown fields; old, future, out-of-sequence, inaccurate, or insufficiently close GPS evidence is indeterminate; PIN attempts expire, lock at the configured cap, and invalidate after successful use; random roles are complete and use an injected server-owned random source; manual roles satisfy every slot, only the host can edit before countdown, changed players lose READY, frozen roles reject edits, and secret-role projections are private. These tests validate pure policy behavior, not the security of an unimplemented transport or credential store.

Run the shared lifecycle/authorization/idempotency/reconnect/timeout suite against every approved immutable mode version, plus these mode-specific cases:

| Mode | Required mode-specific outcomes |
|---|---|
| CLASSIC HIDE & SEEK | One configured seeker; hider-role privacy; capture threshold/confirmation; remaining-hider timeout win; configured capture-goal win; tie result. |
| MANHUNT | Team assignment and limits; capture authorization; fugitive escape/deadline; hunter target threshold; host/participant disconnect. |
| INFECTED | Initial infected-count boundary; conversion exactly once; no conversion by unauthorized role; survivor timeout and full-conversion outcomes. |
| TEAM HUNT | Balanced team constraints; no friendly capture unless configured; simultaneous team elimination; timeout score and tie resolution. |
| SURVIVAL | Player-specific eligibility; elimination/spectator projection; last-player outcome; timeout rank/tie; no self or duplicate capture. |
| TASKS & DECEPTION | Hidden-role and secret-task isolation; allowed task assignment/completion; invalid/expired/duplicate claims; sabotage limits; authorized accusation/reveal; timeout and tie outcomes. |

Every case remains blocked until its rule proposal is approved and encoded in the immutable config schema. CI should run pure-engine, API/database integration, WebSocket multi-client, browser and Android device suites as those milestones land. The existing local-demo test is not evidence for this gate.

## Release evidence

Attach test run IDs/results to the release candidate; list supported browser/device matrix; record open defects and accepted risks; show recovery and deletion drill evidence; and obtain product, privacy/security and operations sign-off. A test pass is scoped to the tested mode, client and deployment. It does not prove universal GPS accuracy or spoof-proof behavior.
