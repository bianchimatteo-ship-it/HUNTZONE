# HUNTZONE — UI and UX

## Navigation

Keep the primary path to three destinations: **Play**, **Modes**, **Profile**. A signed-in or guest player should be able to create or join a match without exploring settings first. Put active match controls on one map-led screen with a compact status panel.

The ordinary match path is strictly **HOME → CREATION/ACCESS → LOBBY → MATCH → RESULT**. Profile, Modes and Editor are secondary entry points and must never block Create or Join. Advanced Editor is a separate destination reached from Modes; it never appears as a mandatory step in quick creation.

## Core screens

1. **Home / Play:** Create match, join by code/link, and browse public matches when enabled. Explain guest play.
2. **Create match:** Choose mode, player cap/team setup and map area. Quick defaults are visible; advanced controls are optional.
3. **Mode setup:** Search presets, edit allowed settings, save/reuse a copy. Advanced editor starts from a preset or blank template.
4. **Lobby:** Roster, ready state, host controls, mode/radius summary, invitation code/link, location-consent explanation and permission check.
5. **Active match:** Map as primary surface; role/objective, timer, safe boundary, forbidden zones, authorized player indicators and clear action buttons. Show last update age and degraded state.
6. **Results:** Outcome, concise match summary, individual progress and report/rematch controls. Do not show a path replay unless a separately reviewed consent feature is added.
7. **Profile:** Avatar, progression, stats, privacy and account controls.

## Match flow

`Home → Create/Join → Lobby → Role reveal → Active map → Results`.

### Fast path and settings hierarchy

**Home:** two dominant actions, `Create match` and `Join with code`; a single code field accepts typed or pasted code and link entry opens directly into the lobby. Keep public discovery secondary and disabled until moderation is ready.

**Quick creation:** show the selected official preset (CLASSIC HIDE & SEEK by default), a sensible default roster cap, a map centre preview, radius control and `Create lobby`. Do not require profile creation, mode browsing, team setup or editor use. A small `More options` disclosure exposes privacy (private/public if allowed), match duration, role count and location visibility. Keep mode-specific defaults visible as a summary.

**Lobby:** show code/share link, roster/ready state, selected mode, radius/area preview, duration, role-count summary, host start/pause/cancel controls, and location permission status with last-sample age. Before a player opts into GPS, display the short explanation of purpose, recipients and stop behavior. Keep advanced rule configuration absent here; edits return to the separate mode setup flow before match creation.

**Active match:** full-width map with prominent role/objective, timer, one primary game action and connection/GPS status. Secondary actions (ability, report, leave) are grouped in a reachable panel. Hide unrelated profile, progression and mode-management controls.

### Immediately visible vs advanced settings

| Visible in quick flow | In `More options` / advanced setup |
|---|---|
| Mode name and brief objective; player count; centre/map preview; custom radius in metres; private code/share; match duration summary; permission and connection state | Role ratios/assignment; team rules; capture threshold/confirmation; radar and visibility policy; cooldowns/abilities; missions; random events; elimination/revival; boundary grace; forbidden polygons; tie priorities; compatibility diagnostics |

The radius must accept and show any integer from 100 to 3,000; do not make a stepped slider the sole input. Use text input plus slider/map feedback and validation. The centre picker supports `Use my location` only after consent and always permits `Choose on map`. The ordinary creator should not need to understand rule-engine terms.

Before location permission, explain why the current mode needs it, who can see the position, the approximate update behavior and how to stop. Ask at the moment the player enters the location-dependent flow. If denied, offer a clear retry/settings path and explain whether the chosen mode can continue without location. Never disguise a permission request as a generic setup step.

## Visual system direction

Use a dark base, high-contrast text and a small set of semantic accent colors: red for alert/hostile state, green for safe/ready, yellow for attention/timer, neutral for navigation and secondary information. Never encode a role or hazard by color alone. Offer daylight readability, large touch targets, legible map labels, color-vision-safe symbols and reduced motion. Avoid noisy tactical decoration that competes with the map or resembles emergency/public-safety interfaces.

The HUNTZONE wordmark and icon are unapproved. Keep the logo area as a replaceable asset slot until visual identity review.

## States and feedback

Every network- or location-dependent screen needs loading, empty, permission denied, unavailable, stale, reconnecting, error and success states. On the active map, make stale position age explicit and visually distinct from a current observation. Keep host pause/cancel actions easy to find; confirm destructive match cancellation with a concise consequence. For location withdrawal, tell the player what happens to their match slot before confirming.

## Accessibility and outdoor use

Support keyboard navigation and screen readers on web, scalable text, non-color status labels, visible focus, reduced motion and high contrast. Mobile controls should work one-handed while stopped; do not require players to read or tap while walking. Include a short reminder to stop in a safe place before interacting with the map. Avoid flashing effects and audio cues that could be mistaken for public warnings.

## Research questions

Test whether a new player understands role visibility, capture uncertainty, location sharing, boundary size and permission consequences. Compare map-first and objective-first status layouts. Validate controls outdoors in sunlight with intermittent connectivity and with screen readers. Do not settle visual brand assets solely from this text specification.
