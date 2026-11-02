# HUNTZONE — GPS and mobile clients

## Shared location contract

Location is requested in context, with an explanation, after the player chooses to join/start a match that needs it. Collect only during an active, opted-in match; stop on completion, cancellation, withdrawal or leaving. Send latitude/longitude, observation time, reported horizontal accuracy, monotonic sample sequence and client/platform metadata needed for diagnostics. Reject malformed, stale, implausible or out-of-order samples. Treat all client measurements as claims, not proof.

Choose update frequency dynamically: lobby and stationary states need little or none; active play can request more frequently while moving; poor network should batch/coalesce obsolete samples. Balance capture fairness, battery, radio traffic, server load and permission policy using field trials. Do not hard-code a promise of exact GPS accuracy.

If a player withdraws location consent during a location-dependent match, stop collection immediately, clear their volatile exact samples and send a withdrawal state to the server. Do not continue location-dependent capture or mission checks for them. The mode must declare a neutralized/withdrawn state; if it does not, pause so the host can remove that player or cancel without a winner. Do not silently treat withdrawal as capture/elimination or pressure a player to re-consent. Tell the lobby that the roster changed or play paused without exposing the reason beyond the player's privacy choice.

### Optional future route history

Default behavior stores no precise route and deletes volatile exact samples at match end, cancellation, leave or withdrawal. A future route-history feature requires separate, unticked opt-in distinct from match GPS consent; a plain-language purpose and visibility statement; controlled access limited to the player and recipients they explicitly authorize; encryption; export/deletion controls; a fixed retention period; and deletion from replicas/backups on a documented schedule. Do not store route history in checkpoints or use it for anti-cheat, analytics, advertising or leaderboards by default. It remains outside MVP pending privacy/legal review.

## Web MVP

Use the browser Geolocation API over HTTPS after an explicit user action. Browser permission, device settings, accuracy and lifecycle are outside HUNTZONE's control. A web session can lose updates when backgrounded, suspended, offline or the screen is off. The site should show permission denied/unavailable, last sample age and reduced-confidence states; pause or disable location-dependent actions when data is stale. Do not promise continuous background tracking from a page or PWA.

## Android native client

Implement location collection natively in Kotlin. During an active match, start a user-visible foreground service with the location service type, persistent notification and clear stop control. Request foreground permission first; request background access only if the supported use case truly requires it and after explaining the separate settings flow. Android versions impose foreground-service type, runtime-permission and background-start restrictions; validate the current target SDK and Google Play policy when implementation and submission occur. Handle revocation, approximate-only permission, battery restrictions, process death, reboot, force-stop and loss of connectivity explicitly. A notification is not a promise that every sample is delivered instantly.

The user starts a match location session from a visible screen. App recovery may resume only an already authorized, active session consistent with the system rules; never silently restart tracking after match end or user stop. Keep foreground notification text localized and identify HUNTZONE as actively sharing location for a match.

## Future iOS client

Use native Core Location behind the same location-provider interface and backend protocol. Request authorization only when the feature is used. Background updates require the correct capability/session and user disclosure; iOS may suspend apps and queue updates, so timely delivery is not guaranteed in every state. Prefer When In Use when it satisfies the product. If testing proves continuous background operation is essential, evaluate the minimum authorization and background session needed, App Store review expectations and battery impact before committing to Always access.

## API and anti-cheat handling

The server stores a bounded recent sample window in volatile state, calculates freshness and quality flags, and applies a mode-specific policy. Cross-check impossible jumps, repeated coordinates, poor accuracy, clock/sequence anomalies and mismatch with match boundaries. Combine signals over time and provide an appeal/review path; GPS spoofing cannot be declared impossible, and heuristics produce false positives. Do not automatically ban based on one anomaly.

Capture checks use server-known samples and configured tolerance. If either player's sample is too old or inaccurate, return an indeterminate/retry outcome rather than a false capture. Use hysteresis or dwell time near boundaries to reduce GPS jitter. Any manual confirmation is still server-validated and rate-limited.

## Map rendering

Render street, satellite and other supported styles through a provider adapter. Confirm attribution, regional coverage, caching, offline behavior, geocoding terms, privacy and cost before selecting a vendor. Do not transmit exact player coordinates to a third-party tile/geocoding service unless necessary and disclosed. Support high-contrast boundaries, forbidden areas, player markers with accuracy rings and a reduced-motion mode.

## Play-area selection and validation

The creator chooses a centre in either of two MVP ways: (a) use current device GPS after a clear permission request, then adjust the pin; or (b) pan/zoom and place a map pin without granting location. A later editor may allow drawing a polygon. Keep the selected centre distinct from the creator's live location: it is a match setting, not proof of where the host is. Radius accepts any integer from 100 through 3,000 metres inclusive. Display an approximate footprint and require host confirmation before the lobby starts.

The server stores the selected centre/radius and vetted forbidden polygons. Validate geometry, coordinate bounds, radius and containment. A circle is the MVP default; drawn polygons follow later because editing and validation need more design. Map data does not prove public access or safety. The host must choose a suitable area and can exclude roads, water, construction, private land and other unsuitable areas. Reject a zone that cannot satisfy the configured minimum playable area after exclusions; do not silently shrink or relocate it.

### Boundary uncertainty and virtual signals

Evaluate entry/exit using the latest eligible sample's reported accuracy and server receipt age. If the accuracy circle overlaps the edge, mark `boundary-uncertain` and do not penalize or eliminate; require a fresh sample or configured dwell/hysteresis. Keep a configurable grace band and warning delay. Do not imply meter-level certainty. Forbidden areas override normal play geometry; any boundary, event or mission placement inside one is invalid.

Keep device GPS and virtual in-game signals as separate typed data. A decoy ping is a server-generated, labeled false marker; it never changes device location, location API payload, boundary evaluation, capture distance or anti-spoofing input. Radar returns an authorized approximation (presence, bearing band or zone) and cannot expose enough precision to reconstruct a coordinate.

## Map provider and international coverage strategy

Map rendering and geographic data are separate choices. Use a renderer adapter (MapLibre-compatible is the current recommendation), then select tile/data services after testing intended pilot locations.

| Option | Strengths | Limits and obligations | HUNTZONE fit |
|---|---|---|---|
| Commercial hosted provider (such as Google Maps Platform or Mapbox) | Managed infrastructure, styles, support, product-specific geocoding and published regional coverage | Usage-based cost and changing terms; coverage varies by product/country; attribution, caching, data use and privacy requirements; vendor coupling | Good candidate for fast international pilot if budget and terms fit; keep provider adapter and spend alerts |
| OSM-derived hosted provider | Multiple regional styles/data options and broad community mapping | Local completeness varies; provider SLAs and terms differ; attribution and license duties; geocoding is a separate service | Candidate where street/park detail is good and commercial tile terms are acceptable |
| Direct OSM Foundation standard tiles | Simple interactive prototype and open map data | Best-effort with no SLA; policy restricts bulk/offline use, requires attribution/caching/identification; not a production capacity commitment | Do not rely on it for global commercial production or offline map downloads |
| Self-hosted OSM-derived tiles | Control of availability, style, caching and data locality | Import/update pipeline, storage, serving, monitoring, regional extracts and license compliance; global coverage is operationally costly | Consider when measured traffic, offline need or data residency justifies operations |

For international release, maintain a city/country pilot matrix: inspect street and pedestrian paths, parks, sensitive/restricted boundaries, language and labels, satellite availability, tile latency, geocoding coverage and local privacy/data-residency constraints. Map data is not a safety or land-access authority. Let hosts review the actual area and exclude unsafe places; do not promise equal detail in every city. Keep attribution visible. Never bulk-download community tiles without explicit permission.

## Field validation checklist

- Walk and remain stationary in open sky, dense urban streets and near buildings/trees.
- Compare web foreground behavior with Android screen-off and process-recovery behavior.
- Test approximate permission, permission denial/withdrawal, low battery, airplane mode and reconnection.
- Measure sample age, accuracy, data volume, battery drain and capture false-positive/negative rates.
- Test area radii at 100 m, non-round values and 3,000 m, including boundary jitter.
- Test GPS-centred and manually pinned areas, forbidden-zone rejection and map labels/tiles in each intended pilot city.
- Verify withdrawal stops collection and invokes the documented neutralized/pause behavior.
- Do not run tests in traffic or private/restricted places; use a safe, controlled public venue.
