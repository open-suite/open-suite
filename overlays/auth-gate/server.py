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
STATE_COOKIE_NAME = os.environ.get("STATE_COOKIE_NAME", "opensuite_auth_state")
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

# Nextcloud richdocuments endpoints Collabora fetches server-to-server (with
# or without index.php): the WOPI callbacks, and since CODE 26.04 also
# /apps/richdocuments/settings/... (browsersetting/presets json). These carry
# WOPI tokens, not a realm session; a gate 302 here makes docbrokers abort and
# the editor hangs at "Connecting...".
WOPI_PATH = re.compile(r"^/(index\.php/)?apps/richdocuments/(wopi|settings)/")

# Keys are cached ~10 min so a fresh JWKS fetch is not on every request's path.
JWKS_CLIENT = PyJWKClient(JWKS_ENDPOINT, cache_keys=True, lifespan=600, timeout=10)


def valid_bearer(token: str) -> dict[str, object] | None:
    """Return verified claims for a realm-issued access token, else None.

    Signature is checked against the realm JWKS plus iss and exp. aud is not
    checked: callers hold tokens minted for a mix of realm clients.
    """
    try:
        key = JWKS_CLIENT.get_signing_key_from_jwt(token).key
        return jwt.decode(
            token,
            key,
            algorithms=["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"],
            issuer=ISSUER,
            options={"verify_aud": False, "require": ["exp", "iss"]},
        )
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


def cookie_header(name: str, value: str, max_age: int, path: str = "/") -> str:
    cookie = SimpleCookie()
    cookie[name] = value
    cookie[name]["Path"] = path
    cookie[name]["Domain"] = COOKIE_DOMAIN
    cookie[name]["Max-Age"] = str(max_age)
    cookie[name]["HttpOnly"] = True
    cookie[name]["Secure"] = True
    cookie[name]["SameSite"] = "Lax"
    return cookie.output(header="").strip()


def clear_cookie_header(name: str) -> str:
    return cookie_header(name, "", 0)


def json_b64(payload: dict[str, object]) -> str:
    encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return b64url(encoded)


def json_unb64(value: str) -> dict[str, object] | None:
    try:
        padded = value + "=" * (-len(value) % 4)
        return json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
    except Exception:
        return None


def request_url(handler: http.server.BaseHTTPRequestHandler) -> str:
    proto = handler.headers.get("X-Forwarded-Proto", "https")
    host = handler.headers.get("X-Forwarded-Host") or handler.headers.get("Host", "")
    uri = handler.headers.get("X-Forwarded-Uri") or handler.path
    return f"{proto}://{host}{uri}"


def allowed_origin(origin: str | None) -> str | None:
    """Return the Origin if it is https on this domain or a subdomain, else None."""
    if not origin:
        return None
    parsed = urllib.parse.urlparse(origin)
    if parsed.scheme != "https" or parsed.netloc != parsed.hostname:
        return None
    host = parsed.hostname or ""
    if host == DOMAIN or host.endswith(f".{DOMAIN}"):
        return origin
    return None


def safe_redirect_target(raw: str | None) -> str:
    fallback = f"https://bridge.{DOMAIN}/"
    if not raw:
        return fallback
    parsed = urllib.parse.urlparse(raw)
    same_site = parsed.netloc == DOMAIN or parsed.netloc.endswith(f".{DOMAIN}")
    if parsed.scheme != "https" or not same_site:
        return fallback
    return raw


def make_state(rd: str, verifier: str) -> tuple[str, str]:
    state = secrets.token_urlsafe(24)
    payload = {
        "state": state,
        "rd": rd,
        "verifier": verifier,
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
    session["token_exp"] = now + int(tokens.get("expires_in", 0))


def make_session(tokens: dict[str, object], user: dict[str, object]) -> str:
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
    except (KeyError, urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
        # Fail closed. Keep the record so a transient IdP outage can recover.
        return None
    return session


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "opensuite-auth-gate/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"{self.address_string()} - {fmt % args}", flush=True)

    def send_empty(self, status: int, headers: dict[str, str] | None = None) -> None:
        self.send_response(status)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()

    def send_preflight(self) -> None:
        origin = allowed_origin(self.headers.get("Origin"))
        headers: dict[str, str] = {"Vary": "Origin"}
        if origin:
            headers.update(
                {
                    "Access-Control-Allow-Origin": origin,
                    "Access-Control-Allow-Methods": self.headers.get("Access-Control-Request-Method", "GET, HEAD, POST, PUT, DELETE, OPTIONS"),
                    "Access-Control-Allow-Headers": self.headers.get("Access-Control-Request-Headers", "Authorization, Content-Type"),
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
            self.handle_frontchannel_logout()
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

        # Collabora's WOPI callbacks (CheckFileInfo, contents) authenticate
        # with their own WOPI access_token, not a realm token; Nextcloud
        # additionally IP-restricts them to the pod subnet (wopi_allowlist).
        # Without this pass-through every document open dies with
        # "Unauthorized WOPI host".
        uri = self.headers.get("X-Forwarded-Uri") or self.path or ""
        if WOPI_PATH.match(uri):
            self.send_empty(HTTPStatus.NO_CONTENT, {})
            return

        # Service-to-service API calls behind gated ingresses pass through on a
        # valid realm token only; anything else falls into the normal gate flow.
        authorization = self.headers.get("Authorization", "")
        if authorization.lower().startswith("bearer "):
            claims = valid_bearer(authorization[7:].strip())
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

        rd = urllib.parse.quote(request_url(self), safe="")
        self.redirect(f"https://{AUTH_HOST}/login?rd={rd}")

    def handle_login(self, params: dict[str, list[str]]) -> None:
        rd = safe_redirect_target(params.get("rd", [""])[0])
        verifier = secrets.token_urlsafe(64)
        state, state_cookie = make_state(rd, verifier)
        query = urllib.parse.urlencode(
            {
                "response_type": "code",
                "client_id": CLIENT_ID,
                "redirect_uri": f"https://{AUTH_HOST}/callback",
                "scope": "openid email profile",
                "state": state,
                "code_challenge": code_challenge(verifier),
                "code_challenge_method": "S256",
            }
        )
        self.redirect(f"{AUTH_ENDPOINT}?{query}", {"Set-Cookie": cookie_header(STATE_COOKIE_NAME, state_cookie, STATE_TTL)})

    def handle_callback(self, params: dict[str, list[str]]) -> None:
        code = params.get("code", [""])[0]
        state = params.get("state", [""])[0]
        cookies = parse_cookies(self.headers.get("Cookie"))
        state_cookie = cookies.get(STATE_COOKIE_NAME).value if cookies.get(STATE_COOKIE_NAME) else None
        state_payload = read_state(state_cookie, state)
        if not code or not state_payload:
            self.redirect(f"https://{AUTH_HOST}/login", {"Set-Cookie": clear_cookie_header(STATE_COOKIE_NAME)})
            return

        try:
            tokens = exchange_code(code, str(state_payload["verifier"]))
            user = fetch_userinfo(str(tokens["access_token"]))
            session_cookie = make_session(tokens, user)
        except (KeyError, urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            self.redirect(f"https://{AUTH_HOST}/login", {"Set-Cookie": clear_cookie_header(STATE_COOKIE_NAME)})
            return

        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", safe_redirect_target(str(state_payload.get("rd", ""))))
        self.send_header("Set-Cookie", clear_cookie_header(STATE_COOKIE_NAME))
        self.send_header("Set-Cookie", cookie_header(COOKIE_NAME, session_cookie, SESSION_TTL))
        self.end_headers()

    def handle_logout(self, params: dict[str, list[str]]) -> None:
        cookies = parse_cookies(self.headers.get("Cookie"))
        auth_cookie = cookies.get(COOKIE_NAME).value if cookies.get(COOKIE_NAME) else None
        sid = unsign(auth_cookie) if auth_cookie else None
        if sid:
            SESSIONS.pop(sid, None)
        rd = safe_redirect_target(params.get("rd", [""])[0])
        logout_query = urllib.parse.urlencode({"client_id": CLIENT_ID, "post_logout_redirect_uri": rd})
        self.redirect(f"{END_SESSION_ENDPOINT}?{logout_query}", {"Set-Cookie": clear_cookie_header(COOKIE_NAME)})

    def handle_frontchannel_logout(self) -> None:
        cookies = parse_cookies(self.headers.get("Cookie"))
        auth_cookie = cookies.get(COOKIE_NAME).value if cookies.get(COOKIE_NAME) else None
        sid = unsign(auth_cookie) if auth_cookie else None
        if sid:
            SESSIONS.pop(sid, None)
        self.send_empty(HTTPStatus.NO_CONTENT, {"Set-Cookie": clear_cookie_header(COOKIE_NAME)})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
