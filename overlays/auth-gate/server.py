#!/usr/bin/env python3
"""Open Suite edge auth gate for Traefik forwardAuth."""

from __future__ import annotations

import base64
import hashlib
import hmac
import http.server
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.cookies import SimpleCookie

import ssl

import jwt
from jwt import PyJWKClient

# Local/dev deploys (OPEN_SUITE_TLS_MODE=selfsigned) run every host on
# self-signed certs, so the gate's backchannel calls to Keycloak cannot
# verify TLS. Never set outside a local VM.
if os.environ.get("OIDC_TLS_INSECURE") == "1":
    ssl._create_default_https_context = ssl._create_unverified_context


DOMAIN = os.environ["OPEN_SUITE_DOMAIN"]
AUTH_HOST = os.environ.get("OPEN_SUITE_AUTH_HOST", f"auth.{DOMAIN}")
ISSUER = os.environ["OIDC_ISSUER"].rstrip("/")
CLIENT_ID = os.environ.get("OIDC_CLIENT_ID", "opensuite-auth-gate")
CLIENT_SECRET = os.environ["OIDC_CLIENT_SECRET"]
COOKIE_SECRET = os.environ["COOKIE_SECRET"].encode("utf-8")
COOKIE_NAME = os.environ.get("COOKIE_NAME", "opensuite_auth")
STATE_COOKIE_NAME = os.environ.get("STATE_COOKIE_NAME", "__Host-opensuite_auth_state")
COOKIE_DOMAIN = os.environ.get("COOKIE_DOMAIN", f".{DOMAIN}")
SESSION_TTL = int(os.environ.get("SESSION_TTL_SECONDS", "604800"))
STATE_TTL = int(os.environ.get("STATE_TTL_SECONDS", "600"))
VALIDATION_INTERVAL = int(os.environ.get("OIDC_VALIDATION_INTERVAL_SECONDS", "15"))
REFRESH_SKEW = int(os.environ.get("OIDC_REFRESH_SKEW_SECONDS", "30"))

AUTH_ENDPOINT = f"{ISSUER}/protocol/openid-connect/auth"
TOKEN_ENDPOINT = f"{ISSUER}/protocol/openid-connect/token"
USERINFO_ENDPOINT = f"{ISSUER}/protocol/openid-connect/userinfo"
INTROSPECTION_ENDPOINT = f"{ISSUER}/protocol/openid-connect/token/introspect"
END_SESSION_ENDPOINT = f"{ISSUER}/protocol/openid-connect/logout"
JWKS_ENDPOINT = f"{ISSUER}/protocol/openid-connect/certs"

SESSIONS: dict[str, dict[str, object]] = {}

# Only these public hosts are attached to the gate. Treating an arbitrary suite
# subdomain as a protected destination would turn forwarded-host spoofing into
# an authorization decision and would also permit open redirects after login.
PROTECTED_HOSTS = {
    f"bridge.{DOMAIN}",
    f"docs.{DOMAIN}",
    f"element.{DOMAIN}",
    f"grist.{DOMAIN}",
    f"meet.{DOMAIN}",
    f"messages.{DOMAIN}",
    f"nextcloud.{DOMAIN}",
}

# A realm token is not a suite-wide credential. Direct app tokens identify the
# destination client in azp; exchanged tokens keep the caller in azp and put
# the resource server in aud. Each destination therefore names both its client
# and the callers explicitly allowed to obtain an exchanged token for it.
BEARER_POLICIES = {
    f"bridge.{DOMAIN}": ("bureaublad", frozenset({"bureaublad"})),
    f"docs.{DOMAIN}": ("docs", frozenset({"bureaublad", "docs"})),
    f"grist.{DOMAIN}": ("grist", frozenset({"bureaublad", "grist"})),
    f"meet.{DOMAIN}": ("meet", frozenset({"bureaublad", "meet", "nextcloud"})),
    f"messages.{DOMAIN}": ("messages", frozenset({"bureaublad", "messages"})),
    f"nextcloud.{DOMAIN}": ("nextcloud", frozenset({"bureaublad", "nextcloud"})),
}

# Nextcloud richdocuments endpoints fetched by Collabora without a realm
# session. Keep this narrower than the application's route tree: nearby admin
# and font-management endpoints must remain gated. Nextcloud still validates
# the WOPI/settings token and its own source allowlist after this pass-through.
WOPI_ROUTES = (
    (frozenset({"GET", "POST"}), re.compile(r"^/(?:index\.php/)?apps/richdocuments/wopi/files/[^/]+(?:/contents)?$")),
    (frozenset({"GET"}), re.compile(r"^/(?:index\.php/)?apps/richdocuments/wopi/template/[^/]+$")),
    (frozenset({"GET", "DELETE"}), re.compile(r"^/(?:index\.php/)?apps/richdocuments/wopi/settings$")),
    (frozenset({"POST"}), re.compile(r"^/(?:index\.php/)?apps/richdocuments/wopi/settings/upload$")),
    (frozenset({"GET"}), re.compile(r"^/(?:index\.php/)?apps/richdocuments/settings/fonts\.json$")),
    (
        frozenset({"GET"}),
        re.compile(r"^/(?:index\.php/)?apps/richdocuments/settings/fonts/[^/]+$"),
    ),
    (
        frozenset({"GET"}),
        re.compile(
            r"^/(?:index\.php/)?apps/richdocuments/settings/"
            r"(?:userconfig|systemconfig)/[A-Za-z0-9]{32}/[A-Za-z0-9_-]+/.+$"
        ),
    ),
)

# Keycloak must reach each relying party's logout endpoint without an edge
# session. In particular, back-channel logout is server-to-server and never
# carries the browser's gate cookie. Keep this allowlist exact: only endpoints
# whose sole purpose is clearing an application session bypass forwardAuth.
# Docs v5.3.0 is intentionally frontchannel-only because it hard-codes cache
# sessions. Meet is configured for cached_db; Messages uses database sessions.
LOGOUT_CALLBACKS = {
    f"bridge.{DOMAIN}": {"/api/v1/auth/logout": frozenset({"GET"})},
    f"docs.{DOMAIN}": {"/api/v1.0/logout-callback/": frozenset({"GET"})},
    f"grist.{DOMAIN}": {
        "/o/docs/logout": frozenset({"GET"}),
        "/signed-out": frozenset({"GET"}),
    },
    f"meet.{DOMAIN}": {
        "/api/v1.0/logout-callback/": frozenset({"GET"}),
        "/api/v1.0/backchannel-logout/": frozenset({"POST"}),
    },
    f"messages.{DOMAIN}": {
        "/api/v1.0/logout-callback/": frozenset({"GET"}),
        "/api/v1.0/backchannel-logout/": frozenset({"POST"}),
    },
    f"nextcloud.{DOMAIN}": {
        "/index.php/apps/user_oidc/backchannel-logout/keycloak": frozenset({"POST"}),
    },
}

# Keys are cached ~10 min so a fresh JWKS fetch is not on every request's path.
JWKS_CLIENT = PyJWKClient(JWKS_ENDPOINT, cache_keys=True, lifespan=600, timeout=10)


def token_audiences(claims: dict[str, object]) -> set[str]:
    audience = claims.get("aud")
    if isinstance(audience, str):
        return {audience}
    if isinstance(audience, list) and all(isinstance(value, str) for value in audience):
        return set(audience)
    return set()


def bearer_allowed(claims: dict[str, object], target_host: str) -> bool:
    policy = BEARER_POLICIES.get(target_host)
    if not policy or not isinstance(claims.get("sub"), str) or not claims["sub"]:
        return False
    target_audience, allowed_parties = policy
    authorized_party = claims.get("azp")
    if not isinstance(authorized_party, str) or authorized_party not in allowed_parties:
        return False
    # Direct client tokens do not reliably include their own client in aud.
    # Exchanged tokens must explicitly name the destination resource server.
    return authorized_party == target_audience or target_audience in token_audiences(claims)


def valid_bearer(token: str, target_host: str) -> dict[str, object] | None:
    """Return verified, destination-authorized realm access-token claims."""
    try:
        key = JWKS_CLIENT.get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token,
            key,
            algorithms=["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"],
            issuer=ISSUER,
            options={"verify_aud": False, "require": ["exp", "iss"]},
        )
        return claims if bearer_allowed(claims, target_host) else None
    except Exception:
        return None


def valid_id_token(token: str, nonce: str) -> dict[str, object] | None:
    """Verify the ID token that establishes a gate session."""
    try:
        key = JWKS_CLIENT.get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token,
            key,
            algorithms=["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"],
            issuer=ISSUER,
            audience=CLIENT_ID,
            options={"require": ["exp", "iss", "aud", "sub", "nonce", "sid"]},
        )
        token_nonce = claims.get("nonce")
        if not isinstance(token_nonce, str) or not hmac.compare_digest(token_nonce, nonce):
            return None
        authorized_party = claims.get("azp")
        audiences = token_audiences(claims)
        if authorized_party not in (None, CLIENT_ID) or (len(audiences) > 1 and authorized_party != CLIENT_ID):
            return None
        return claims
    except Exception:
        return None


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def sign(value: str) -> str:
    sig = hmac.new(COOKIE_SECRET, value.encode("utf-8"), hashlib.sha256).digest()
    return f"{value}.{b64url(sig)}"


def unsign(signed: str) -> str | None:
    try:
        value, sig = signed.rsplit(".", 1)
    except ValueError:
        return None
    expected = sign(value).rsplit(".", 1)[1]
    if not hmac.compare_digest(sig, expected):
        return None
    return value


def parse_cookies(header: str | None) -> SimpleCookie:
    cookie = SimpleCookie()
    if header:
        cookie.load(header)
    return cookie


def cookie_header(
    name: str,
    value: str,
    max_age: int | None,
    path: str = "/",
    domain: str | None = COOKIE_DOMAIN,
) -> str:
    cookie = SimpleCookie()
    cookie[name] = value
    cookie[name]["Path"] = path
    if domain:
        cookie[name]["Domain"] = domain
    if max_age is not None:
        cookie[name]["Max-Age"] = str(max_age)
    cookie[name]["HttpOnly"] = True
    cookie[name]["Secure"] = True
    cookie[name]["SameSite"] = "Lax"
    return cookie.output(header="").strip()


def clear_cookie_header(name: str) -> str:
    return cookie_header(name, "", 0)


def state_cookie_header(value: str, max_age: int) -> str:
    # The state/PKCE verifier is needed only at auth.<domain>/callback. A
    # __Host- cookie prevents sibling applications from receiving or replacing
    # it while retaining Path=/ as required by the prefix.
    return cookie_header(STATE_COOKIE_NAME, value, max_age, domain=None)


def clear_state_cookie_header() -> str:
    return state_cookie_header("", 0)


def json_b64(payload: dict[str, object]) -> str:
    encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return b64url(encoded)


def json_unb64(value: str) -> dict[str, object] | None:
    try:
        padded = value + "=" * (-len(value) % 4)
        return json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
    except Exception:
        return None


def single_header(handler: http.server.BaseHTTPRequestHandler, name: str) -> str | None:
    values = handler.headers.get_all(name, [])
    if len(values) != 1:
        return None
    value = values[0].strip()
    return value if value and "\r" not in value and "\n" not in value else None


def forwarded_request(handler: http.server.BaseHTTPRequestHandler) -> tuple[str, str, str] | None:
    """Return Traefik's canonical HTTPS host, URI and method, or fail closed."""
    proto = single_header(handler, "X-Forwarded-Proto")
    raw_host = single_header(handler, "X-Forwarded-Host")
    uri = single_header(handler, "X-Forwarded-Uri")
    method = single_header(handler, "X-Forwarded-Method")
    if proto != "https" or not raw_host or not uri or not method:
        return None
    if "," in raw_host or not uri.startswith("/") or uri.startswith("//"):
        return None
    parsed_host = urllib.parse.urlsplit(f"//{raw_host}")
    try:
        port = parsed_host.port
    except ValueError:
        return None
    host = (parsed_host.hostname or "").lower()
    if (
        parsed_host.username
        or parsed_host.password
        or parsed_host.path
        or parsed_host.query
        or parsed_host.fragment
        or port not in (None, 443)
        or host not in PROTECTED_HOSTS
    ):
        return None
    parsed_uri = urllib.parse.urlsplit(uri)
    if parsed_uri.scheme or parsed_uri.netloc:
        return None
    method = method.upper()
    if not re.fullmatch(r"[A-Z]+", method):
        return None
    return host, uri, method


def request_url(request: tuple[str, str, str]) -> str:
    host, uri, _ = request
    return f"https://{host}{uri}"


def is_wopi_request(request: tuple[str, str, str]) -> bool:
    host, uri, method = request
    if host != f"nextcloud.{DOMAIN}":
        return False
    path = urllib.parse.urlsplit(uri).path
    decoded_path = urllib.parse.unquote(path)
    # Avoid a proxy/backend decoding discrepancy turning an encoded separator
    # or dot segment into a different Nextcloud route after authorization.
    if decoded_path.count("/") != path.count("/") or "\\" in decoded_path:
        return False
    if any(segment in {".", ".."} for segment in decoded_path.split("/")):
        return False
    return any(method in methods and pattern.fullmatch(path) for methods, pattern in WOPI_ROUTES)


def is_logout_callback(request: tuple[str, str, str]) -> bool:
    host, uri, method = request
    path = urllib.parse.urlsplit(uri).path
    return method in LOGOUT_CALLBACKS.get(host, {}).get(path, frozenset())


def allowed_origin(origin: str | None) -> str | None:
    """Return an exact suite Origin, else None."""
    if not origin:
        return None
    parsed = urllib.parse.urlparse(origin)
    if parsed.scheme != "https" or parsed.netloc != parsed.hostname:
        return None
    host = parsed.hostname or ""
    if host in PROTECTED_HOSTS or host == AUTH_HOST:
        return origin
    return None


def safe_redirect_target(raw: str | None) -> str:
    fallback = f"https://bridge.{DOMAIN}/"
    if not raw:
        return fallback
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme != "https" or parsed.netloc != parsed.hostname or parsed.hostname not in PROTECTED_HOSTS:
        return fallback
    return raw


def make_state(rd: str, verifier: str, nonce: str) -> tuple[str, str]:
    state = secrets.token_urlsafe(24)
    payload = {
        "state": state,
        "rd": rd,
        "verifier": verifier,
        "nonce": nonce,
        "exp": int(time.time()) + STATE_TTL,
    }
    return state, sign(json_b64(payload))


def read_state(cookie_value: str | None, state: str | None) -> dict[str, object] | None:
    if not cookie_value or not state:
        return None
    unsigned = unsign(cookie_value)
    if not unsigned:
        return None
    payload = json_unb64(unsigned)
    if not payload:
        return None
    if payload.get("state") != state:
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload


def code_challenge(verifier: str) -> str:
    return b64url(hashlib.sha256(verifier.encode("ascii")).digest())


def exchange_code(code: str, verifier: str) -> dict[str, object]:
    body = urllib.parse.urlencode(
        {
            "grant_type": "authorization_code",
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "code": code,
            "redirect_uri": f"https://{AUTH_HOST}/callback",
            "code_verifier": verifier,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        TOKEN_ENDPOINT,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.loads(res.read().decode("utf-8"))


def fetch_userinfo(access_token: str) -> dict[str, object]:
    req = urllib.request.Request(USERINFO_ENDPOINT, headers={"Authorization": f"Bearer {access_token}"})
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.loads(res.read().decode("utf-8"))


def refresh_tokens(refresh_token: str) -> dict[str, object]:
    body = urllib.parse.urlencode(
        {
            "grant_type": "refresh_token",
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "refresh_token": refresh_token,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        TOKEN_ENDPOINT,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.loads(res.read().decode("utf-8"))


def token_is_active(access_token: str) -> bool:
    body = urllib.parse.urlencode(
        {
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "token": access_token,
            "token_type_hint": "access_token",
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        INTROSPECTION_ENDPOINT,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as res:
        return bool(json.loads(res.read().decode("utf-8")).get("active"))


def update_session_tokens(session: dict[str, object], tokens: dict[str, object], now: int) -> None:
    session["access_token"] = str(tokens["access_token"])
    if tokens.get("refresh_token"):
        session["refresh_token"] = str(tokens["refresh_token"])
    if tokens.get("id_token"):
        session["id_token"] = str(tokens["id_token"])
    session["token_exp"] = now + int(tokens.get("expires_in", 0))


def make_session(
    tokens: dict[str, object],
    user: dict[str, object],
    id_claims: dict[str, object],
) -> str:
    sid = secrets.token_urlsafe(32)
    now = int(time.time())
    refresh_ttl = int(tokens.get("refresh_expires_in", SESSION_TTL))
    ttl = min(SESSION_TTL, refresh_ttl) if refresh_ttl > 0 else SESSION_TTL
    SESSIONS[sid] = {
        "sub": user.get("sub", ""),
        "email": user.get("email", ""),
        "name": user.get("name") or user.get("preferred_username", ""),
        "exp": now + ttl,
        "validated_at": now,
        "oidc_sid": id_claims["sid"],
    }
    update_session_tokens(SESSIONS[sid], tokens, now)
    return sign(sid)


def valid_session(cookie_value: str | None) -> dict[str, object] | None:
    if not cookie_value:
        return None
    sid = unsign(cookie_value)
    if not sid:
        return None
    session = SESSIONS.get(sid)
    if not session:
        return None
    if int(session.get("exp", 0)) <= int(time.time()):
        SESSIONS.pop(sid, None)
        return None
    now = int(time.time())
    try:
        if int(session.get("token_exp", 0)) <= now + REFRESH_SKEW:
            refresh_token = str(session.get("refresh_token", ""))
            if not refresh_token:
                SESSIONS.pop(sid, None)
                return None
            update_session_tokens(session, refresh_tokens(refresh_token), now)
        if now - int(session.get("validated_at", 0)) >= VALIDATION_INTERVAL:
            if not token_is_active(str(session.get("access_token", ""))):
                SESSIONS.pop(sid, None)
                return None
            session["validated_at"] = now
    except (
        AttributeError,
        KeyError,
        TypeError,
        urllib.error.URLError,
        TimeoutError,
        json.JSONDecodeError,
        ValueError,
    ):
        # Fail closed. Keep the record so a transient IdP outage can recover.
        return None
    return session


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "opensuite-auth-gate/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"{self.address_string()} - {fmt % args}", flush=True)

    def log_request(self, code: int | str = "-", size: int | str = "-") -> None:
        # Authorization codes, state and WOPI access tokens can appear in query
        # strings. Never emit them to pod logs, including on failed exchanges.
        path = urllib.parse.urlsplit(self.path).path
        self.log_message('"%s %s %s" %s %s', self.command, path, self.request_version, code, size)

    def send_empty(self, status: int, headers: dict[str, str] | None = None) -> None:
        self.send_response(status)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()

    def send_preflight(self) -> None:
        origin = allowed_origin(self.headers.get("Origin"))
        headers: dict[str, str] = {"Vary": "Origin"}
        if origin:
            requested_method = self.headers.get("Access-Control-Request-Method", "GET").upper()
            if re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Z-]+", requested_method):
                headers.update(
                    {
                        "Access-Control-Allow-Origin": origin,
                        "Access-Control-Allow-Methods": requested_method,
                        "Access-Control-Allow-Headers": self.headers.get(
                            "Access-Control-Request-Headers",
                            "Authorization, Content-Type",
                        ),
                        "Access-Control-Max-Age": "600",
                    }
                )
        self.send_empty(HTTPStatus.NO_CONTENT, headers)

    def redirect(self, location: str, headers: dict[str, str] | None = None) -> None:
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", location)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/healthz":
            self.send_empty(HTTPStatus.OK)
            return
        if parsed.path == "/auth":
            self.handle_auth()
            return
        if parsed.path == "/login":
            self.handle_login(params)
            return
        if parsed.path == "/callback":
            self.handle_callback(params)
            return
        if parsed.path == "/logout":
            self.handle_logout(params)
            return
        if parsed.path == "/frontchannel-logout":
            self.handle_frontchannel_logout(params)
            return
        self.send_empty(HTTPStatus.NOT_FOUND)

    def do_HEAD(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/healthz":
            self.send_empty(HTTPStatus.OK)
            return
        if parsed.path == "/auth":
            self.handle_auth()
            return
        self.send_empty(HTTPStatus.NOT_FOUND)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_preflight()

    def handle_auth(self) -> None:
        if self.headers.get("Access-Control-Request-Method"):
            self.send_preflight()
            return

        request = forwarded_request(self)
        if not request:
            self.send_empty(HTTPStatus.BAD_REQUEST)
            return

        # Collabora's WOPI callbacks (CheckFileInfo, contents) authenticate
        # with their own WOPI access_token, not a realm token; Nextcloud
        # additionally IP-restricts them to the pod subnet (wopi_allowlist).
        # Without this pass-through every document open dies with
        # "Unauthorized WOPI host".
        if is_wopi_request(request):
            self.send_empty(HTTPStatus.NO_CONTENT, {})
            return

        if is_logout_callback(request):
            self.send_empty(HTTPStatus.NO_CONTENT, {})
            return

        # Service-to-service API calls behind gated ingresses pass through on a
        # realm token authorized for this exact destination only; anything else
        # falls into the normal browser-session flow.
        authorization = self.headers.get("Authorization", "")
        if authorization.lower().startswith("bearer "):
            claims = valid_bearer(authorization[7:].strip(), request[0])
            if claims:
                self.send_empty(
                    HTTPStatus.NO_CONTENT,
                    {
                        "X-Open-Suite-User": str(claims.get("sub", "")),
                        "X-Open-Suite-Email": str(claims.get("email", "")),
                        "X-Open-Suite-Name": str(claims.get("name") or claims.get("preferred_username", "")),
                    },
                )
                return

        cookies = parse_cookies(self.headers.get("Cookie"))
        auth_cookie = cookies.get(COOKIE_NAME).value if cookies.get(COOKIE_NAME) else None
        session = valid_session(auth_cookie)
        if session:
            self.send_empty(
                HTTPStatus.NO_CONTENT,
                {
                    "X-Open-Suite-User": str(session.get("sub", "")),
                    "X-Open-Suite-Email": str(session.get("email", "")),
                    "X-Open-Suite-Name": str(session.get("name", "")),
                },
            )
            return

        rd = urllib.parse.quote(request_url(request), safe="")
        self.redirect(f"https://{AUTH_HOST}/login?rd={rd}")

    def handle_login(self, params: dict[str, list[str]]) -> None:
        rd = safe_redirect_target(params.get("rd", [""])[0])
        verifier = secrets.token_urlsafe(64)
        nonce = secrets.token_urlsafe(24)
        state, state_cookie = make_state(rd, verifier, nonce)
        query = urllib.parse.urlencode(
            {
                "response_type": "code",
                "client_id": CLIENT_ID,
                "redirect_uri": f"https://{AUTH_HOST}/callback",
                "scope": "openid email profile",
                "state": state,
                "nonce": nonce,
                "code_challenge": code_challenge(verifier),
                "code_challenge_method": "S256",
            }
        )
        self.redirect(f"{AUTH_ENDPOINT}?{query}", {"Set-Cookie": state_cookie_header(state_cookie, STATE_TTL)})

    def handle_callback(self, params: dict[str, list[str]]) -> None:
        code = params.get("code", [""])[0]
        state = params.get("state", [""])[0]
        cookies = parse_cookies(self.headers.get("Cookie"))
        state_cookie = cookies.get(STATE_COOKIE_NAME).value if cookies.get(STATE_COOKIE_NAME) else None
        state_payload = read_state(state_cookie, state)
        if not code or not state_payload:
            self.redirect(f"https://{AUTH_HOST}/login", {"Set-Cookie": clear_state_cookie_header()})
            return

        try:
            tokens = exchange_code(code, str(state_payload["verifier"]))
            id_claims = valid_id_token(str(tokens["id_token"]), str(state_payload["nonce"]))
            if not id_claims:
                raise ValueError("invalid ID token")
            user = fetch_userinfo(str(tokens["access_token"]))
            if not user.get("sub") or user.get("sub") != id_claims.get("sub"):
                raise ValueError("userinfo subject mismatch")
            session_cookie = make_session(tokens, user, id_claims)
        except (
            AttributeError,
            KeyError,
            TypeError,
            urllib.error.URLError,
            TimeoutError,
            json.JSONDecodeError,
            ValueError,
        ):
            self.redirect(f"https://{AUTH_HOST}/login", {"Set-Cookie": clear_state_cookie_header()})
            return

        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", safe_redirect_target(str(state_payload.get("rd", ""))))
        self.send_header("Set-Cookie", clear_state_cookie_header())
        # Match Keycloak's browser-session cookie. A persistent gate cookie can
        # otherwise survive a browser restart after Keycloak's cookie is gone,
        # admitting users who can no longer establish a native app session.
        self.send_header("Set-Cookie", cookie_header(COOKIE_NAME, session_cookie, None))
        self.end_headers()

    def handle_logout(self, params: dict[str, list[str]]) -> None:
        if self.headers.get("Sec-Fetch-Site", "").lower() == "cross-site":
            self.send_empty(HTTPStatus.FORBIDDEN)
            return
        cookies = parse_cookies(self.headers.get("Cookie"))
        auth_cookie = cookies.get(COOKIE_NAME).value if cookies.get(COOKIE_NAME) else None
        sid = unsign(auth_cookie) if auth_cookie else None
        session = SESSIONS.pop(sid, None) if sid else None
        rd = safe_redirect_target(params.get("rd", [""])[0])
        logout_params = {"client_id": CLIENT_ID, "post_logout_redirect_uri": rd}
        if session and session.get("id_token"):
            logout_params["id_token_hint"] = str(session["id_token"])
        logout_query = urllib.parse.urlencode(logout_params)
        self.redirect(f"{END_SESSION_ENDPOINT}?{logout_query}", {"Set-Cookie": clear_cookie_header(COOKIE_NAME)})

    def handle_frontchannel_logout(self, params: dict[str, list[str]]) -> None:
        cookies = parse_cookies(self.headers.get("Cookie"))
        auth_cookie = cookies.get(COOKIE_NAME).value if cookies.get(COOKIE_NAME) else None
        sid = unsign(auth_cookie) if auth_cookie else None
        session = SESSIONS.get(sid) if sid else None
        issuers = params.get("iss", [])
        oidc_sids = params.get("sid", [])
        if (
            sid
            and session
            and len(issuers) == 1
            and issuers[0] == ISSUER
            and len(oidc_sids) == 1
            and oidc_sids[0] == session.get("oidc_sid")
        ):
            SESSIONS.pop(sid, None)
            self.send_empty(
                HTTPStatus.NO_CONTENT,
                {"Cache-Control": "no-store", "Set-Cookie": clear_cookie_header(COOKIE_NAME)},
            )
            return
        self.send_empty(HTTPStatus.NO_CONTENT, {"Cache-Control": "no-store"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
