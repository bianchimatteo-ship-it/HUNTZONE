# HUNTZONE — Technical decisions and alternatives

Status labels: **Recommended** means a proposal for review; **Open** means evidence or owner input is still needed. No implementation stack or vendor has been installed or provisioned.

| Topic | Options considered | Recommendation | Reason / trade-off | Status |
|---|---|---|---|---|
| Web client | React/TypeScript; Vue; native-first | React + TypeScript, framework selected at implementation | Broad ecosystem and one language with the proposed server/core; Vue remains viable if team experience favors it | Recommended |
| Backend/realtime | TypeScript service + WebSockets; Elixir/Phoenix Channels; managed realtime/BaaS | TypeScript service with HTTP and WebSockets; keep framework open pending a short spike | Shares types and domain code with web and rule engine; Phoenix has strong channel/process primitives but adds a second language; BaaS authority, custom match actor behavior and location access need careful validation | Recommended |
| Game engine | Rules embedded in each client; server-only framework logic; independent domain package | Framework-independent, server-executed TypeScript core and bounded declarative IR | Keeps rules testable and clients thin while avoiding client authority; package is not shipped with privileged server logic as a source of truth | Recommended |
| Durable data | PostgreSQL; document DB; BaaS | PostgreSQL, with PostGIS for supported spatial operations | Relational integrity for rosters, versions and outcomes; spatial extension fits geometry needs; operations remain simpler than a geo-specific multi-store design | Recommended |
| Realtime fan-out | Polling; WebSockets; WebRTC peer mesh | Authenticated WebSockets | Server authority and private per-player views require a trusted relay; polling is inefficient for active play and peer mesh complicates trust/privacy | Recommended |
| Ephemeral presence | In-process only; Redis; durable DB | Start in match-owner memory with durable checkpoints; add Redis when routing/presence needs justify it | Avoids early infrastructure; process loss needs explicit recovery; Redis is a transport/cache, not durable game truth | Recommended |
| Maps | Google Maps; Mapbox; MapLibre with a tile provider; self-hosted OSM stack | MapLibre-compatible client and provider adapter; select provider after current terms/cost/coverage review | Reduces renderer/provider coupling; self-hosting adds tile operations; proprietary providers offer integrated services but create pricing, terms and data-flow dependencies | Open vendor |
| Android GPS | Web/PWA; native Kotlin; cross-platform wrapper | Native Kotlin location service | Required for the user-visible, policy-compliant background location behavior; web remains foreground-oriented | Recommended |
| iOS GPS | Reuse web; cross-platform plugin; native Core Location | Native Core Location client if/when iOS is funded | Platform lifecycle/authorization behavior is OS-specific; backend remains shared | Future |
| Mode editor | Arbitrary scripts; custom DSL; visual builder over fixed operators | Visual builder emitting validated versioned JSON/IR over allow-listed mechanics | Supports creativity without arbitrary code execution; limits expressive power and requires engine/operator governance | Recommended |
| Hosting | One regional container service; Kubernetes/microservices; managed game platform | Small one-region container deployment + managed PostgreSQL for pilot | Low operational overhead at 3–30 players per match; evolve using measured concurrency and latency | Open provider/budget |
| Match recovery | In-memory only; periodic full snapshots; snapshots plus committed events in PostgreSQL | One match-owning process, PostgreSQL checkpoint + append-only transition events, idempotent commands, fresh GPS after restore | Avoids a separate event platform; bounds replay and handles process restart; database outage pauses game transitions; initial 15 s/50-event checkpoint threshold needs pilot validation | Recommended, interval provisional |
| Exact route history | Always-on history; ephemeral match GPS; separate optional history | Ephemeral GPS only by default; future route history requires separate explicit opt-in and deletion/retention controls | Minimizes sensitive data; history may aid personal replay but adds substantial privacy and breach risk | Confirmed default; future feature open |
| Auth | Guest first; mandatory account; social login first | Guest entry with later account upgrade | Reduces join friction; needs secure expiring credentials and careful merge flow | Recommended |

## Architecture consequences

- Web and native clients share protocol and server; Android/iOS location capture remains platform-native.
- The game core owns deterministic state transitions and receives normalized inputs; it does not own networking, persistence or rendering.
- The server is the only authority for roles, captures, score, dynamic events and results.
- The database stores durable match configuration/version/outcome; exact positions are transient by default.
- New modes use schema-versioned configurations and approved mechanics. Active matches pin immutable versions.
- Infrastructure expansion is driven by measured match concurrency, update rate, fan-out and reliability needs.

## Decision log template

For each material change, record: ID/date, decision owner, context, options, evidence, chosen option, consequences, privacy/security implications, migration/rollback implications and status. Revisit only when evidence or constraints change. This file captures recommendations, not approvals by the product owner.

## External references

- Android location permissions and foreground location: [Request location permissions](https://developer.android.com/develop/sensors-and-location/location/permissions), [Foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types).
- iOS background location and power use: [Handling background updates](https://developer.apple.com/documentation/corelocation/handling-location-updates-in-the-background), [Efficient location access](https://developer.apple.com/documentation/xcode/accessing-the-device-s-location-efficiently).
- Browser permission and secure-context behavior: [MDN Geolocation API](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation/getCurrentPosition).
- Spatial predicates and indexes: [PostGIS spatial index FAQ](https://postgis.net/documentation/faq/spatial-indexes/), [ST_Within](https://postgis.net/docs/ST_Within.html).
- Phoenix channels alternative: [Phoenix Channels documentation](https://phoenix.hexdocs.pm/channels.html).
- International map coverage is product-specific: [Google Maps Platform country coverage](https://developers.google.com/maps/coverage).
- MapLibre provides separate [web GL JS](https://maplibre.org/maplibre-gl-js/docs/) and [native platform renderers](https://maplibre.org/maplibre-native/docs/book/introduction.html); it does not itself guarantee tile data or global detail.
- OpenStreetMap's standard tile endpoint is best-effort and has explicit [usage, attribution, caching and offline restrictions](https://operations.osmfoundation.org/policies/tiles/). OSM data availability does not mean the community tile server is a production SLA.
- Map provider use can be metered differently by product; see [Mapbox map product billing overview](https://docs.mapbox.com/help/getting-started/maps/). Recheck current provider prices, terms, coverage and regional constraints before contracting.

Recheck platform rules, app-store policies, provider terms and current service pricing at the time of implementation and release.
