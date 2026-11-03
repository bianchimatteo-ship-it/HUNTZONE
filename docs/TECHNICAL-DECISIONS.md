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

## Owner-approved capture and assignment systems — 2026-11-03

**Decision owner:** HUNTZONE product owner. **Status:** systems approved; per-mode compatibility and numeric tuning remain open.

- Every compatible match selects **RAGGIO**, **PIN**, or **AUTOMATICA**. Each capture requires authoritative server validation of fresh, accurate position evidence for the involved players. PIN is a short-lived personal credential with a bounded attempt count and one-use invalidation; PIN alone never captures. Automatic capture also requires configured dwell time.
- Every compatible lobby selects **RANDOM** or **MANUAL** role/team assignment. RANDOM is generated server-side. MANUAL is host-controlled before countdown, warns that the host will know roles assigned, validates complete slots, clears READY for changed players, and freezes assignments at countdown. Unauthorized snapshots omit secret roles.
- Client actions express intent only; the server decides the outcome. Exact coordinates remain volatile and are excluded from durable records, logs and result payloads.

The pure game-core now contains policy/config validators, GPS evidence eligibility, a PIN-attempt state transition, slot assignment, manual READY invalidation and role-view projection. It is not backed by API authentication, a CSPRNG adapter, hashed credential storage, persistence, GPS ingestion or network authorization. Numeric ceilings in the validator are explicitly temporary schema guardrails; see [BETA-SCOPE.md](BETA-SCOPE.md). These systems do not approve any of the six proposed rulesets.

## Beta architecture decision — 2026-11-03

**Status:** architecture direction accepted for implementation planning; deployment provider, region, budget and operational owner remain open. Do not provision paid services in this milestone.

### Backend runtime comparison

| Option | Fit for HUNTZONE | Operational cost/limits | Decision |
|---|---|---|---|
| Fastify on supported Node.js LTS | TypeScript-first HTTP/WebSocket service; plugin encapsulation; direct integration with PostgreSQL/PostGIS and the TypeScript core. Small, explicit service boundaries fit the current team and keep runtime portable. | Own deployment, health, scaling, TLS, WebSocket draining, connection pooling, secrets, alerts and recovery. Compute/database cost depends on concurrent matches, update rates, region and retention; model before purchase. | **Recommended for API/realtime.** Keep one logical match actor per match; persist accepted transitions before ACK. |
| NestJS on Node.js | Modules, dependency injection, guards and conventions can help a larger team organize a broad service. WebSocket gateways and a Fastify adapter are available. | More framework conventions and learning/maintenance overhead for a small service; adapters still need explicit lifecycle and persistence design. It does not remove the need for an authoritative actor or transaction boundaries. | Viable if the team grows or the service becomes multi-team. No need to adopt it solely for theoretical scale. |
| Cloudflare Workers + Durable Objects | A Durable Object can be one coordinator per match and supports WebSockets, including hibernation while connected clients remain open. It is a credible match-local state alternative. | Runtime CPU/memory/subrequest limits; hibernation evicts in-memory state, requiring restoration; storage, global identity, PostgreSQL/PostGIS integration, backup and transaction boundaries need a separate design. Cost varies with requests, CPU, storage and plan; estimate against real load/idle patterns. | **Not selected for this beta backend.** The existing Cloudflare Pages frontend does not make Workers/DO the default. Revisit after a technical spike and cost model if evidence supports it. |

Fastify is the first API recommendation because it preserves Node/PostgreSQL portability, keeps the TypeScript engine independent, and has less framework ceremony than NestJS for the initial service. This does not select a hosting vendor. The database/API hosting provider remains open; no account, paid resource or secret is created here.

Cloudflare documents Durable Object WebSocket hibernation and coordinator use, but hibernation evicts in-memory state and requires explicit restoration; the runtime has finite CPU and memory limits. Reassess current limits/pricing before an implementation spike: [Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/). Fastify and Nest references: [Fastify TypeScript plugins](https://fastify.dev/docs/latest/Reference/TypeScript/), [Nest platform adapters](https://docs.nestjs.com/techniques/performance).

### Repository boundary

The long-term target is `apps/web`, `apps/api`, `apps/android`, `packages/game-core`, and `packages/contracts`. The root Vite app stays in place during this review because active Pages integrations build from `/`; move it only with a reviewed Cloudflare/GitHub Pages settings change. `packages/game-core` begins independently and imports no browser, framework, network, or database APIs.

### Data and protocol direction

Use versioned strict JSON contracts. HTTP creates short-lived guest sessions/lobbies and provides snapshots/fallback commands; authenticated WebSocket commands carry `commandId`, `matchId`, `expectedRevision`, type and bounded payload. The server verifies actor/membership/phase, commits event + revision + checkpoint transactionally, then ACKs and publishes filtered deltas. Repeated command IDs return the committed outcome. PostgreSQL is durable source; PostGIS supports vetted boundaries. Exact coordinates remain volatile match-owner memory and are omitted from durable records and logs. See [BETA-IMPLEMENTATION-PLAN.md](BETA-IMPLEMENTATION-PLAN.md) for the proposed endpoints and schemas.

### GPS/mobile boundary

Web uses consented foreground `watchPosition()` only during an active match and exposes accuracy/age/degraded state. Android starts a location foreground service from a visible user action with an ongoing notification. Do not request Android background-location permission unless a tested requirement cannot otherwise be met and a current Play policy review supports it. Recheck current rules before implementation/submission: [Android location permissions](https://developer.android.com/develop/sensors-and-location/location/permissions), [foreground-service start restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start), [background-location guidance](https://developer.android.com/develop/sensors-and-location/location/background).

### Web map/GPS implementation choice — 2026-11-03

For the web area picker and local-match map, use MapLibre GL JS 6.16.0 through `src/map/stadiaMapProvider.ts` and Stadia Maps Alidade Smooth Dark on the EU endpoint. `src/map/configureMapLibreWorker.ts` configures the MapLibre 6 worker once with Vite's `?worker&url` asset before app mount. Chrome E2E on localhost verified the worker HTTP 200, style and vector tile loads, actual map render, and browser `Origin`/`Referer` headers; no API key or request-header transform is used. The page policy is `strict-origin-when-cross-origin`. A browser 401 is distinguished from worker, style, network and tile failures. The public build must be checked again after Cloudflare serves this commit; the last inspected Pages response was still an older build. This web provider choice neither approves commercial terms nor selects a native/mobile auth method.

The explicit GPS action remains setup/demo consent, not active-match consent; it does not contact a game backend. `LocationProvider` keeps one foreground watcher and sample across Create→Lobby→Game, stopping on STOP, abandonment or Results. Selected centre/radius travel with the local demo match in volatile React state and remain through Results. Stadia tile requests may reveal the approximate viewed area; disclose this before activation and review the privacy notice before a beta. No simulated participant positions are rendered on the real map; geocoding and routing remain absent.
