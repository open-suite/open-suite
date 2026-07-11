# Open Suite authentication options

Status: architecture decision input, not an implementation plan.

## Executive conclusion

The current deployment is not literally one application session. It is:

1. one Keycloak realm and browser SSO session;
2. one Open Suite edge session enforced by Traefik `forwardAuth`; and
3. a native session or access token inside each application.

The edge and native layers are now synchronized, but synchronization still has
moving parts. Calling that a double-gate architecture is fair.

We can remove the second browser login/session from several applications by
making the edge identity authoritative. We should **not** force that model onto
every protocol. Matrix clients and Nextcloud DAV/mobile clients need native
bearer tokens or app passwords after the browser is gone.

The recommended target is therefore:

- **one authoritative edge identity for browser traffic**;
- **short-lived, signed identity assertions from the edge to applications**;
- **no app-specific OIDC browser flow for Grist, Portal, Docs, Meet, or the
  selected webmail**;
- **native protocol tokens for Matrix and Nextcloud DAV/mobile clients**; and
- **one immutable Keycloak `sub` as the suite identity, with an explicit
  mapping for applications that internally key users by email**.

This removes visible and behavioral double authentication without pretending
that every protocol is a browser page.

## Required invariant

For any browser request to a private Open Suite application:

> The application must use the identity authenticated by the Open Suite edge,
> or reject the request. It must never select a user from a stale application
> cookie independently of the edge identity.

Corollaries:

- Switching from user A to user B cannot reveal user A's app session.
- A revoked Keycloak session stops new HTTP requests across every app within a
  bounded interval.
- An application cannot accept identity headers supplied by the public client.
- Public links and machine APIs must be explicitly classified rather than
  accidentally opened or blocked.

## Current architecture

```text
browser
  |
  v
Traefik -> Open Suite auth gate -> Keycloak
  |
  | X-Open-Suite-User / Email / Name
  v
application -> its own OIDC/session check -> Keycloak
```

The edge gate covers the user-facing Portal, Grist, Nextcloud, Docs, Meet,
Element, and Messages ingresses. Static assets and protocol backends have
purpose-specific treatment.

The applications do not currently consume the edge identity as their native
identity. They authenticate independently with Keycloak. This gives useful
defence in depth, but creates two session lifecycles. Front-channel logout,
back-channel logout, token refresh, callback paths, and session expiry all have
to agree.

## Do not use raw trusted headers

Configuring every app to trust `X-Open-Suite-User` would be quick but brittle.
The target contract should instead be a signed, short-lived assertion:

```text
X-Open-Suite-Identity: <JWT>
```

Minimum claims:

| Claim | Purpose |
|---|---|
| `iss` | fixed Open Suite auth-gate issuer |
| `aud` | exact destination application |
| `sub` | immutable Keycloak subject; canonical user key |
| `email` | display/contact data, never the primary key |
| `name` | display data |
| `sid` | global edge session identifier |
| `iat`, `nbf`, `exp` | replay window; target lifetime 30-60 seconds |
| `jti` | diagnostics and optional replay detection |

The gate should sign with an asymmetric key and publish an internal JWKS.
Every app gets a distinct audience. Traefik must strip all incoming identity
headers before `forwardAuth` and only copy the gate's response header. App pods
must only be reachable through the trusted ingress or internal callers with a
separate authentication mechanism.

This avoids a network introspection call on every app request. Revocation is
bounded by the edge validation interval because the gate stops issuing new
assertions when its Keycloak session is invalid.

## Options

| Option | Browser UX | Correctness | App patching | Protocol support | Maintenance |
|---|---|---:|---:|---:|---:|
| A. Keep synchronized edge + native OIDC | Good when healthy | Good after current fixes | Low | Excellent | Medium |
| B. Raw forwarded identity headers | Excellent | Fragile | Medium | Poor | High risk |
| C. Signed edge identity for every request | Excellent | Strong | High | Poor alone | High |
| D. Signed edge identity plus native protocol tokens | Excellent | Strong | Medium-high | Strong | Medium-high |
| E. Remove the edge and use native OIDC only | More redirects/errors | Native | Low | Excellent | Low |

### Option A: keep the current synchronized gates

Continue using the edge gate as a login wall and native OIDC inside every app.
Improve integration tests, logout propagation, and observability.

Advantages:

- Smallest fork and upgrade burden.
- Each upstream application stays on its supported authentication path.
- Native mobile, DAV, Matrix, WebSocket, and API flows keep working.
- Compromise of the edge is not automatically sufficient to impersonate a
  user inside every application.

Costs:

- Two sources of session state remain.
- Logout and expiry require synchronization.
- Each OIDC implementation can regress independently.
- The architecture keeps the exact class of inconsistency that prompted this
  review, even if tests make recurrence less likely.

This is acceptable as a stable fallback, not the cleanest target.

### Option B: raw forwarded headers

Have the gate emit an email or username and configure/patch apps to trust it.

Grist supports this directly through `GRIST_FORWARD_AUTH_HEADER`; it can also
set `GRIST_IGNORE_SESSION=true` so the forwarded identity is authoritative on
every request. Grist explicitly warns that the proxy must overwrite or strip
the header on every public request. See [Grist forwarded-header
authentication](https://support.getgrist.com/install/forwarded-headers/).

This option is attractive for a pilot but unsuitable as a suite-wide contract:

- a proxy or NetworkPolicy mistake becomes account impersonation;
- headers have no issuer, audience, expiry, or cryptographic proof;
- internal service calls need ad hoc exceptions;
- identity changes are difficult to audit; and
- different apps will normalize email and usernames differently.

Use it only for the Grist pilot, behind strict ingress and NetworkPolicy rules,
then move to signed assertions.

### Option C: signed edge identity everywhere

Patch every app so each browser HTTP request is authenticated from the signed
edge assertion, with no independent app login state.

This is the cleanest browser model. It is not a complete suite model:

- Matrix clients call the homeserver API with Matrix access tokens. The edge
  browser cookie is absent from desktop/mobile clients and federation traffic.
- Nextcloud desktop/mobile and DAV clients use app passwords, bearer tokens,
  or cookies. Nextcloud documents app passwords for external-auth WebDAV
  clients. See [Nextcloud WebDAV authentication](https://docs.nextcloud.com/server/stable/developer_manual/client_apis/WebDAV/basic.html).
- WOPI, LiveKit, webhooks, background jobs, and server-to-server callbacks use
  their own capability or service tokens.
- Long-lived WebSockets are authenticated at connection time; logout cannot
  retroactively change a connection without an explicit disconnect mechanism
  or bounded connection lifetime.

Forcing the edge browser session onto these protocols would create a custom
identity platform and permanent forks of their security-critical code.

### Option D: signed browser identity plus native protocol tokens

Use signed edge identity as the only browser authentication source where an
application can consume it safely. Retain native token issuance where the
client continues operating independently of the browser.

```text
browser HTTP
  -> edge session
  -> per-app signed assertion
  -> app authorization

Matrix / DAV / mobile / service client
  -> protocol-native token
  -> native server validation
```

This is the recommendation. It removes the double gate from ordinary browser
navigation while preserving supported protocol security boundaries.

### Option E: remove the edge gate

Let each app use Keycloak OIDC natively and rely on Keycloak SSO to make most
redirects silent.

This is architecturally conventional and has the lowest patch burden. It does
not meet the product requirement that a new top-level navigation immediately
shows one consistent login wall rather than partially rendered apps, widget
errors, or app-specific login behavior.

## Application-by-application feasibility

### Grist: native support, low effort

Grist already supports forwarded authentication and an authoritative
no-independent-session mode. This makes it the correct pilot.

Target:

- set `GRIST_FORWARD_AUTH_HEADER` to an edge-controlled email header;
- set `GRIST_IGNORE_SESSION=true` and `GRIST_FORCE_LOGIN=true`;
- route Grist logout to the single Open Suite logout endpoint;
- maintain an explicit `sub` to Grist-email mapping because Grist's native
  forwarded-auth contract identifies users by email;
- decide explicitly whether anonymous/public documents remain supported.

Grist does not natively verify the proposed assertion JWT. The production
version therefore needs either a small validating adapter that emits the
Grist email header on a private hop, or an upstream Grist patch. The raw-header
pilot is acceptable only because Traefik overwrites the header and NetworkPolicy
prevents public traffic from reaching Grist directly.

Estimated effort: 1-3 engineering days including deployment and browser tests.

### Portal: owned code, low-to-medium effort

The Portal is an owned FastAPI application with its own OIDC token and session
handling. It can replace the browser OIDC dependency with middleware that:

1. validates the signed edge assertion;
2. constructs the current-user object from `sub` and profile claims;
3. refuses a session whose stored `sub` differs from the assertion;
4. uses Keycloak token exchange or a service credential for downstream API
   calls that currently require the user's OIDC token; and
5. redirects logout to the central gate only.

The hard part is not user identification. It is the Portal's delegated calls
to Nextcloud, Docs, Meet, Grist, and Matrix. A trusted header cannot replace an
OAuth subject token. The gate or a broker must expose narrowly scoped token
exchange for those calls.

Estimated effort: 4-8 engineering days plus integration tests.

### Docs and Meet: shared upstream patch, medium effort

Both La Suite applications use Django session authentication and a shared La
Suite OIDC backend. Their similar structure makes one reusable upstream change
preferable to two local patches.

Add a `TrustedProxyAuthenticationBackend` or request middleware to the shared
authentication package:

- validate the signed assertion and audience;
- get-or-create the user by immutable `sub`;
- update non-authoritative profile fields;
- make `request.user` derive from the current assertion rather than a stale
  Django session;
- retain Django CSRF protection; and
- support the y-provider/WebSocket handshake with the same short-lived
  assertion or a derived collaboration ticket.

Their existing backends provision users from OIDC claims, so most user mapping
logic can be reused. The patch should be feature-flagged and proposed upstream.

Estimated effort: 1-2 weeks for the shared implementation, both deployments,
WebSocket coverage, and upstream-quality tests.

### Nextcloud browser UI: custom app, high effort

Nextcloud has a pluggable user/authentication model, but the deployed
`user_oidc` app is built around native OIDC login and a Nextcloud session. It
also performs provisioning and stores a refresh token used by the Meet calendar
integration. Replacing it is not a configuration-only change.

Build an Open Suite Nextcloud app that:

- validates the edge assertion at the start of browser requests;
- maps `sub` to the existing Nextcloud user without changing user IDs;
- creates or refreshes the Nextcloud request/session identity safely;
- invalidates any session whose `sub` differs;
- obtains delegated Meet tokens through a broker instead of a stored OIDC
  browser refresh token; and
- leaves DAV, app-password, OCS, public-share, cron, WOPI, and mobile-client
  authentication on their native paths.

Nextcloud's official `user_oidc` backend already supports native bearer-token
validation, provisioning, and back-channel logout. Keeping it available for
protocol/API authentication may be safer than deleting it immediately. See
[Nextcloud user_oidc](https://github.com/nextcloud/user_oidc).

Estimated effort: 2-4 weeks plus an ongoing security-sensitive app fork unless
the approach is accepted upstream.

### Element and Synapse: retain native OIDC

Element is a Matrix client. Synapse issues Matrix access and refresh tokens
after OIDC login; subsequent Matrix requests authenticate with those tokens,
not a browser cookie. Synapse supports OIDC and back-channel logout directly.
See [Synapse OIDC and back-channel logout](https://matrix-org.github.io/synapse/develop/openid.html).

Keep Synapse native OIDC. Improve it instead:

- ensure back-channel logout is enabled and reachable;
- set bounded Matrix session and refresh-token lifetimes;
- keep the Portal's silent SSO bootstrap for the Chat widget;
- test logout and user switching; and
- do not put the Matrix client/federation API behind a browser-only gate.

Patching Synapse to exchange edge assertions for Matrix login tokens is
possible, but it would be a new authentication provider with little benefit
over its supported OIDC flow. Estimated effort is at least 4-8 weeks plus a
large long-term security burden. It is not recommended.

### Mail, Roundcube, Stalwart, or La Suite Messages: hybrid by protocol

The mail implementation is still being selected. Its browser UI should consume
the edge assertion if the chosen webmail has a supported proxy-auth extension
or a small maintainable adapter. The mail protocols must remain native:

- IMAP, SMTP submission, POP3, and JMAP clients operate without the browser;
- mailbox credentials, app passwords, OAuth bearer tokens, or JMAP tokens must
  be validated by the mail server;
- the webmail needs a scoped way to obtain the user's mailbox credential or
  delegated token without storing the Keycloak password; and
- logging out of the browser must not silently revoke independent mail clients
  unless that is an explicit administrative policy.

For Roundcube plus a managed IMAP provider, the integration work is mainly a
webmail assertion adapter and secure delegated mailbox credential. For
Stalwart, retain its native OIDC/OAuth support for mail clients and make the
browser SSO bootstrap silent. For La Suite Messages, apply the same shared
Django approach as Docs and Meet if its authentication stack remains aligned.

Estimated effort: 3 days to 2 weeks after the mail architecture is selected;
do not lock the auth contract to the temporary demo mail implementation.

### Collabora, LiveKit, WOPI, static hosts, and callbacks

These are not independent browser identity providers. Keep their native
capability/service tokens and exact routing rules. Do not send the browser
identity assertion to a service that does not need the user identity.

## Recommended target architecture

```text
                         +------------------+
browser ---------------->| Open Suite gate  |<------> Keycloak
                         +------------------+
                           | signed JWT, per-app aud
          +----------------+----------------+----------------+
          v                v                v                v
       Portal            Grist          Docs/Meet      Nextcloud web
    assertion auth   assertion auth   assertion auth   assertion bridge

Element/Matrix ------ native Matrix token ------> Synapse OIDC
DAV/mobile ---------- app password/token -------> Nextcloud native auth
mail clients -------- mailbox/token auth --------> mail server
WOPI/LiveKit -------- capability token ----------> protocol service
```

The gate remains the browser authentication authority. It does not become a
general API gateway or mint every protocol token itself. A small token-broker
endpoint may be added for approved OAuth token-exchange use cases such as the
Portal and Nextcloud Meet integration.

## Migration phases

### Phase 0: contract and threat model

- Specify the signed assertion schema, audiences, key rotation, expiry, and
  clock-skew behavior.
- Specify canonical suite identity as Keycloak `sub`; document stable adapters
  for applications, such as Grist, that internally require email.
- Classify every ingress path as private browser, public browser, native client,
  server callback, or static asset.
- Threat-model header spoofing, confused-deputy token exchange, user switching,
  replay, CSRF, WebSockets, and compromised app pods.
- Add an auth conformance test suite before converting an application.

Exit criterion: another implementation can consume the contract without
reading the gate source.

### Phase 1: Grist pilot

- Enable Grist's native forwarded-auth mode.
- Initially use the current identity header only inside the trusted network.
- Move to the signed assertion once the contract exists.
- Remove Grist's Keycloak browser client only after user-switch, logout,
  public-link, API, and document-permission tests pass.

Exit criterion: Grist has no independent browser login/session identity and no
logout callback exception.

### Phase 2: signed identity infrastructure

- Add asymmetric assertion signing and internal JWKS to the gate.
- Configure Traefik to strip all client-supplied identity headers.
- Add per-app audiences and key rotation with overlap.
- Add structured logs for `sub`, `sid`, `aud`, decision, latency, and reason,
  excluding raw tokens and unnecessary personal data.
- Benchmark verification overhead and keep it local, without per-request
  Keycloak calls from applications.

### Phase 3: Portal conversion and token broker

- Make the assertion the Portal's current-user source.
- Define an allowlisted, audience-restricted token exchange API for downstream
  calls that truly need user delegation.
- Remove the Portal's browser OIDC session and refresh-token store.
- Retain central logout only.

Exit criterion: Portal identity is stateless at the app boundary and delegated
tokens are scoped, short-lived, and audited.

### Phase 4: shared Docs/Meet upstream patch

- Implement one feature-flagged trusted-proxy backend in the shared La Suite
  authentication package.
- Cover REST, Django admin boundaries, CSRF, collaboration WebSockets, room
  creation, document sharing, and user switching.
- Submit upstream before carrying separate local patches.
- Remove the Docs and Meet browser OIDC clients only after both are migrated.

### Phase 5: Nextcloud browser bridge

- Build the smallest possible Nextcloud app for edge-assertion browser auth.
- Preserve existing user IDs and file ownership.
- Split browser routes from DAV/mobile/app-password/public/WOPI routes.
- Replace the Meet calendar's stored login refresh token with brokered token
  exchange.
- Run upgrade tests against every supported Nextcloud release.

Exit criterion: browser requests cannot select a user independently of the
edge, while native Nextcloud clients remain supported.

### Phase 6: protocol hardening and cleanup

- Keep Synapse OIDC and enable/test its native back-channel logout.
- Keep native IMAP/SMTP/JMAP authentication regardless of the webmail choice.
- Bound Matrix, Nextcloud app-password, and collaboration-token lifetimes.
- Delete obsolete Keycloak browser clients, callback routes, gate allowlists,
  and session synchronization code only when no migrated app depends on them.
- Document emergency/admin access separately from normal user authentication.

## Auth conformance tests

Every converted app must pass the same black-box suite:

1. Anonymous top-level navigation reaches the global login page before app UI.
2. One login opens every browser app without a second redirect or button.
3. User A cannot be observed after the edge switches to user B, including with
   an old app cookie, cached tab, or open WebSocket.
4. Global logout makes all new private requests fail within the stated bound.
5. Forged, expired, wrong-audience, wrong-issuer, and unsigned assertions fail.
6. Direct pod/service access without the trusted ingress fails.
7. CSRF protections still reject cross-site writes.
8. Public shares work only on documented routes.
9. Matrix, DAV, mobile, WOPI, LiveKit, and server callbacks work without a
   browser cookie and cannot use the browser assertion outside their audience.
10. Key rotation works with old and new signing keys during the overlap window.

These tests should run in k3s CI and against the demo after deployment. The
results should be recorded as architecture KPIs, not only as app-specific test
cases.

## Cost and decision

Approximate focused engineering effort:

| Work | Estimate |
|---|---:|
| Contract, threat model, conformance harness | 1 week |
| Grist pilot | 1-3 days |
| Gate signing/JWKS and Traefik hardening | 1 week |
| Portal and delegated-token broker | 1-2 weeks |
| Shared Docs/Meet patch | 1-2 weeks |
| Nextcloud browser bridge | 2-4 weeks |
| Matrix native OIDC hardening | 2-4 days |
| Rollout, upstreaming, upgrade automation | 1-2 weeks |

Expected total: roughly 7-12 engineering weeks, dominated by Nextcloud and
security/integration testing rather than the JWT middleware itself.

Recommendation:

1. Do not rewrite all applications at once.
2. Pilot Grist because upstream already supports the model.
3. Build the signed assertion contract before the first custom app patch.
4. Convert owned/shared browser apps in increasing order of protocol risk.
5. Keep Synapse OIDC and Nextcloud native-client authentication.
6. Stop if the Grist pilot does not produce a measurable reliability or UX
   improvement over the now-hardened current architecture.

That produces one browser gate without creating a proprietary replacement for
OIDC, Matrix authentication, WebDAV app passwords, or capability-token
protocols.
