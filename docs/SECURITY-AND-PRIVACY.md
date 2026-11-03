# HUNTZONE — Security and privacy

## Threat model

Protect players from location exposure, account/session takeover, unauthorized match access, manipulated roles/scores/captures, abusive public content, mode-rule resource exhaustion and accidental tracking beyond a match. Assume web/mobile clients, network timing and GPS samples can be manipulated. A user may also share screenshots or invite links outside the intended group.

## Location safeguards

- Ask for explicit, purpose-specific consent in the match flow; show who can see what and when tracking stops.
- Collect location only for an active match and only at the cadence needed by that mode.
- Keep precise coordinates visible only to the trusted server and only for a justified rule/recipient. Other clients receive an approved approximation, bearing, zone or no location according to mode settings.
- Stop collection and delete transient samples at match end, cancellation, leave or withdrawal. Do not collect continuously for profile, advertising or analytics.
- Do not record raw coordinates in application logs, telemetry, crash reports, event history or support dashboards.
- Provide account data access/deletion and a documented retention schedule. Restrict support access and audit exceptional access.
- Future route history requires a separate, inactive-by-default opt-in, stated purpose, access controls, retention deadline, user deletion/export and backup-erasure policy; it is out of MVP scope.
- Withdrawal during a location-dependent match stops collection and clears transient samples immediately. The affected player becomes neutralized/withdrawn, or the match pauses/cancels if no such mode rule exists. Never count withdrawal as capture/elimination or continue tracking.

This design is not a substitute for jurisdiction-specific privacy review. Determine controller/processor roles, lawful basis, notices, child-safety obligations, data-subject workflows, international transfers and retention before launch.

### Data lifecycle

| Data | During active match | Default at match end | Future optional route history |
|---|---|---|---|
| Exact GPS observation | Volatile server memory, short expiry, authorized rule use only | Clear on end/cancel/leave/withdrawal; never restore from checkpoint | Only under separate reviewed opt-in; encrypted, access-limited, fixed retention and deletion path |
| Web GPS sample | Volatile React memory only after explicit ATTIVA POSIZIONE action; displayed on the user's own map during the local match flow | Clear on STOP, match end or abandoning the flow; never sent to game server or saved in storage/URL | Not a route-history or active-match consent substitute |
| Match checkpoint | Protected database snapshot of virtual state; excludes coordinates | Retain per match/audit schedule | Still excludes precise route unless separately redesigned and approved |
| Match event/result | Minimal server outcomes and IDs; no raw coordinates or precise distance | Retain per defined schedule; support deletion/anonymization | Never repurpose for route reconstruction |

### Web map request data flow — 2026-11-03

The optional Create-screen GPS action keeps the browser's exact sample in a root `LocationProvider` for the foreground Create→Lobby→Game flow. The selected play-area centre/radius are copied into the local in-memory demo match and remain through Results. Neither data is written to local/session storage, URL, logs, analytics or a backend; the watch/sample stops and clears on STOP, match completion or leaving the flow. Stadia Maps is a separate recipient of map style, sprite, glyph and vector-tile requests for the current viewport. Those requests reveal the approximate viewed area and carry normal browser connection metadata, including IP and browser-generated `Origin`/`Referer`; when a player recentres the viewport on GPS, requested tiles can reveal the nearby area. Tile requests are routed to the configured EU Stadia endpoint. This is disclosed before the GPS action. A map point can be selected without GPS. Include this provider transfer in the user-facing privacy notice and assess it before beta; the web preview does not itself define the eventual legal basis or retention terms.

## Authorization and account safety

Use short-lived signed guest credentials and rotate/revoke them on upgrade or suspected compromise. Use a proven identity provider for permanent accounts when selected. Require authorization on every match, participant, mode and report operation; do not rely on unguessable IDs alone. Private matches require membership; link-only access is revocable and rate-limited. Apply code-entry throttling, invite expiry, join limits and abuse detection. Protect cookies/tokens against XSS, CSRF, replay and leakage; never put long-lived secrets in URLs or client bundles.

## Server authority and anti-cheat

Clients send commands; server code checks membership, legal state transitions, cooldowns, role permissions, sample freshness, range, geometry and resource budgets. Derive score and results only from server outcomes. Use idempotency keys, sequence numbers, replay-resistant sessions and audit events for moderator/host control actions. Validate telemetry as untrusted; anomaly detection supports review and temporary safeguards but is not proof of spoofing. Keep appeal/remediation procedures for false positives.

## Communications and abuse

Treat public rooms, names, chat, custom mode text and links as untrusted. Rate-limit messages and invites, provide block/report/mute controls, sanitize rendered text and disallow active content. Public matchmaking requires a staffed moderation/response plan, report triage, enforcement policy and appeals before release. Private sessions still need host controls and a leave/report path.

## Custom mode sandbox

Accept a strict schema of allow-listed rule operators and bounded values. Reject arbitrary source, regular expressions with unbounded work, external calls, unknown fields and unsupported versions. Limit rule count, nesting, evaluation steps, fan-out, message size and per-player action rate. Compile to a canonical IR and execute only server-owned mechanics with bounded time and memory. Pin immutable versions to matches and audit publish/unpublish actions.

## Platform and operational controls

Use TLS, secure headers, input validation, dependency updates, secret management outside source, least-privilege service accounts, encrypted backups and tested restore. Separate production from development data. Monitor authentication failures, invite enumeration, location access anomalies, message floods, mode evaluation limits and database access. Define incident response for accidental location disclosure and compromised accounts before public launch.

## Minors and safety

The initial product should target adults until age policy, guardian/consent flows, discovery boundaries, communication safeguards, retention and legal review are complete. Do not enable open public tracking or direct messages for minors by default. Provide clear safe-play guidance, visible match radius/boundary, forbidden-zone controls and an immediate stop/pause path. Do not frame virtual hazards as real hazards or reward risky movement.

## Review gates

Before a public beta: privacy impact assessment; data-flow and access-control review; retention/deletion exercise; abuse-report tabletop; location permission UX review; mode-editor adversarial tests; backup/incident drill; and current platform/store policy review. Record outcomes and owners before release.
