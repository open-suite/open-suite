import http.client
import os
from pathlib import Path
import threading
import types
import unittest
from unittest import mock


os.environ.setdefault("OPEN_SUITE_DOMAIN", "example.test")
os.environ.setdefault("OIDC_ISSUER", "https://id.example.test/realms/test")
os.environ.setdefault("OIDC_CLIENT_SECRET", "client-secret")
os.environ.setdefault("COOKIE_SECRET", "cookie-secret")

import server  # noqa: E402


def request(path: str, headers: dict[str, str] | None = None, method: str = "GET") -> http.client.HTTPResponse:
    httpd = server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    thread = threading.Thread(target=httpd.serve_forever)
    thread.start()
    try:
        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port)
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        response.read()
        return response
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join()


def forwarded_headers(host: str, uri: str, method: str = "GET") -> dict[str, str]:
    return {
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": host,
        "X-Forwarded-Uri": uri,
        "X-Forwarded-Method": method,
    }


class SessionTests(unittest.TestCase):
    def setUp(self) -> None:
        server.SESSIONS.clear()

    def make_session(self, now: int = 1_000) -> tuple[str, dict[str, object]]:
        tokens = {
            "access_token": "access-1",
            "refresh_token": "refresh-1",
            "id_token": "id-1",
            "expires_in": 300,
            "refresh_expires_in": 3_600,
        }
        with mock.patch.object(server.time, "time", return_value=now):
            cookie = server.make_session(
                tokens,
                {"sub": "user-1", "email": "user@example.test"},
                {"sid": "keycloak-session-1"},
            )
        session = server.SESSIONS[server.unsign(cookie)]
        return cookie, session

    def test_new_session_uses_refresh_token_lifetime(self) -> None:
        _, session = self.make_session()

        self.assertEqual(session["exp"], 4_600)
        self.assertEqual(session["token_exp"], 1_300)
        self.assertEqual(session["refresh_token"], "refresh-1")
        self.assertEqual(session["oidc_sid"], "keycloak-session-1")

    def test_gate_cookie_is_scoped_to_the_browser_session(self) -> None:
        header = server.cookie_header(server.COOKIE_NAME, "signed-session", None)

        self.assertNotIn("Max-Age", header)
        self.assertIn("HttpOnly", header)
        self.assertIn("SameSite=Lax", header)

    def test_state_cookie_remains_short_lived_and_persistent(self) -> None:
        header = server.state_cookie_header("signed-state", server.STATE_TTL)

        self.assertIn(f"Max-Age={server.STATE_TTL}", header)
        self.assertIn(f"{server.STATE_COOKIE_NAME}=signed-state", header)
        self.assertNotIn("Domain=", header)

    def test_session_is_rejected_when_keycloak_marks_token_inactive(self) -> None:
        cookie, _ = self.make_session()

        with (
            mock.patch.object(server.time, "time", return_value=1_000 + server.VALIDATION_INTERVAL),
            mock.patch.object(server, "token_is_active", return_value=False),
        ):
            self.assertIsNone(server.valid_session(cookie))

        self.assertNotIn(server.unsign(cookie), server.SESSIONS)


    def test_session_refreshes_expiring_access_token(self) -> None:
        cookie, session = self.make_session()
        session["token_exp"] = 1_010
        refreshed = {
            "access_token": "access-2",
            "refresh_token": "refresh-2",
            "expires_in": 300,
        }

        with (
            mock.patch.object(server.time, "time", return_value=1_000),
            mock.patch.object(server, "refresh_tokens", return_value=refreshed) as refresh,
        ):
            self.assertIs(server.valid_session(cookie), session)

        refresh.assert_called_once_with("refresh-1")
        self.assertEqual(session["access_token"], "access-2")
        self.assertEqual(session["refresh_token"], "refresh-2")
        self.assertEqual(session["id_token"], "id-1")
        self.assertEqual(session["token_exp"], 1_300)

    def test_logout_clears_session_and_skips_keycloak_confirmation(self) -> None:
        cookie, _ = self.make_session()
        sid = server.unsign(cookie)
        response = request(
            "/logout?rd=https%3A%2F%2Fbridge.example.test%2F",
            {"Cookie": f"{server.COOKIE_NAME}={cookie}"},
        )

        query = server.urllib.parse.parse_qs(server.urllib.parse.urlparse(response.getheader("Location")).query)
        self.assertEqual(response.status, 302)
        self.assertEqual(query["id_token_hint"], ["id-1"])
        self.assertEqual(query["post_logout_redirect_uri"], ["https://bridge.example.test/"])
        self.assertIn("Max-Age=0", response.getheader("Set-Cookie"))
        self.assertNotIn(sid, server.SESSIONS)

    def test_session_fails_closed_during_keycloak_error(self) -> None:
        cookie, _ = self.make_session()

        with (
            mock.patch.object(server.time, "time", return_value=1_000 + server.VALIDATION_INTERVAL),
            mock.patch.object(server, "token_is_active", side_effect=TimeoutError),
        ):
            self.assertIsNone(server.valid_session(cookie))

        self.assertIn(server.unsign(cookie), server.SESSIONS)

    def test_session_fails_closed_on_malformed_introspection_response(self) -> None:
        cookie, _ = self.make_session()

        with (
            mock.patch.object(server.time, "time", return_value=1_000 + server.VALIDATION_INTERVAL),
            mock.patch.object(server, "token_is_active", side_effect=AttributeError),
        ):
            self.assertIsNone(server.valid_session(cookie))

        self.assertIn(server.unsign(cookie), server.SESSIONS)

    def test_frontchannel_logout_clears_gate_session_and_cookie(self) -> None:
        cookie, _ = self.make_session()
        params = server.urllib.parse.urlencode({"iss": server.ISSUER, "sid": "keycloak-session-1"})
        response = request(
            f"/frontchannel-logout?{params}",
            {"Cookie": f"{server.COOKIE_NAME}={cookie}"},
        )

        self.assertEqual(response.status, 204)
        self.assertIn("Max-Age=0", response.getheader("Set-Cookie"))
        self.assertEqual(response.getheader("Cache-Control"), "no-store")
        self.assertNotIn(server.unsign(cookie), server.SESSIONS)

    def test_frontchannel_logout_rejects_wrong_issuer_and_keeps_session(self) -> None:
        cookie, _ = self.make_session()
        params = server.urllib.parse.urlencode({"iss": "https://evil.test/realms/test", "sid": "keycloak-session-1"})

        response = request(
            f"/frontchannel-logout?{params}",
            {"Cookie": f"{server.COOKIE_NAME}={cookie}"},
        )

        self.assertEqual(response.status, 204)
        self.assertIsNone(response.getheader("Set-Cookie"))
        self.assertIn(server.unsign(cookie), server.SESSIONS)

    def test_frontchannel_logout_rejects_wrong_session_id(self) -> None:
        cookie, _ = self.make_session()
        params = server.urllib.parse.urlencode({"iss": server.ISSUER, "sid": "another-session"})

        response = request(
            f"/frontchannel-logout?{params}",
            {"Cookie": f"{server.COOKIE_NAME}={cookie}"},
        )

        self.assertEqual(response.status, 204)
        self.assertIsNone(response.getheader("Set-Cookie"))
        self.assertIn(server.unsign(cookie), server.SESSIONS)

    def test_cross_site_logout_is_rejected_without_clearing_session(self) -> None:
        cookie, _ = self.make_session()

        response = request(
            "/logout",
            {
                "Cookie": f"{server.COOKIE_NAME}={cookie}",
                "Sec-Fetch-Site": "cross-site",
            },
        )

        self.assertEqual(response.status, 403)
        self.assertIn(server.unsign(cookie), server.SESSIONS)


class LogoutCallbackTests(unittest.TestCase):
    def request_auth(self, host: str, uri: str, method: str = "GET") -> int:
        return request("/auth", forwarded_headers(host, uri, method)).status

    def test_exact_app_logout_callbacks_bypass_gate(self) -> None:
        callbacks = (
            ("bridge.example.test", "/api/v1/auth/logout", "GET"),
            ("docs.example.test", "/api/v1.0/logout-callback/", "GET"),
            ("grist.example.test", "/o/docs/logout?next=/", "GET"),
            ("grist.example.test", "/signed-out", "GET"),
            ("meet.example.test", "/api/v1.0/logout-callback/", "GET"),
            ("meet.example.test", "/api/v1.0/backchannel-logout/", "POST"),
            ("messages.example.test", "/api/v1.0/logout-callback/", "GET"),
            (
                "nextcloud.example.test",
                "/index.php/apps/user_oidc/backchannel-logout/keycloak",
                "POST",
            ),
        )

        for host, uri, method in callbacks:
            with self.subTest(host=host, method=method):
                self.assertEqual(self.request_auth(host, uri, method), 204)

    def test_messages_backchannel_logout_stays_protected_for_cache_sessions(self) -> None:
        self.assertEqual(
            self.request_auth(
                "messages.example.test", "/api/v1.0/backchannel-logout/", "POST"
            ),
            302,
        )

    def test_logout_path_on_wrong_host_stays_protected(self) -> None:
        self.assertEqual(self.request_auth("grist.example.test", "/api/v1.0/logout/"), 302)

    def test_nearby_grist_path_stays_protected(self) -> None:
        self.assertEqual(self.request_auth("grist.example.test", "/o/docs/logout-all"), 302)

    def test_logout_initiators_and_wrong_callback_methods_stay_protected(self) -> None:
        protected = (
            ("bridge.example.test", "/api/v1/auth/logout", "POST"),
            ("docs.example.test", "/api/v1.0/logout/", "POST"),
            ("docs.example.test", "/api/v1.0/logout-callback/", "POST"),
            ("docs.example.test", "/api/v1.0/backchannel-logout/", "POST"),
            ("grist.example.test", "/o/docs/logout", "POST"),
            ("grist.example.test", "/signed-out", "POST"),
            ("meet.example.test", "/api/v1.0/logout/", "POST"),
            ("meet.example.test", "/api/v1.0/logout-callback/", "POST"),
            ("meet.example.test", "/api/v1.0/backchannel-logout/", "GET"),
            ("messages.example.test", "/api/v1.0/logout/", "POST"),
            ("messages.example.test", "/api/v1.0/logout-callback/", "POST"),
            ("messages.example.test", "/api/v1.0/backchannel-logout/", "GET"),
            (
                "nextcloud.example.test",
                "/index.php/apps/user_oidc/backchannel-logout/keycloak",
                "GET",
            ),
        )

        for host, uri, method in protected:
            with self.subTest(host=host, uri=uri, method=method):
                self.assertEqual(self.request_auth(host, uri, method), 302)


class BearerPolicyTests(unittest.TestCase):
    def test_direct_client_token_is_allowed_only_on_its_own_host(self) -> None:
        claims = {"sub": "user-1", "azp": "docs"}

        self.assertTrue(server.bearer_allowed(claims, "docs.example.test"))
        self.assertFalse(server.bearer_allowed(claims, "meet.example.test"))

    def test_portal_exchange_requires_the_destination_audience(self) -> None:
        claims = {"sub": "user-1", "azp": "bureaublad", "aud": ["account", "docs"]}

        self.assertTrue(server.bearer_allowed(claims, "docs.example.test"))
        self.assertFalse(server.bearer_allowed(claims, "meet.example.test"))

    def test_nextcloud_exchange_is_limited_to_meet(self) -> None:
        claims = {"sub": "user-1", "azp": "nextcloud", "aud": "meet"}

        self.assertTrue(server.bearer_allowed(claims, "meet.example.test"))
        self.assertFalse(server.bearer_allowed(claims, "docs.example.test"))

    def test_unapproved_authorized_party_is_rejected_even_with_right_audience(self) -> None:
        claims = {"sub": "user-1", "azp": "untrusted-client", "aud": "docs"}

        self.assertFalse(server.bearer_allowed(claims, "docs.example.test"))

    def test_missing_azp_subject_or_policy_is_rejected(self) -> None:
        self.assertFalse(server.bearer_allowed({"sub": "user-1", "aud": "docs"}, "docs.example.test"))
        self.assertFalse(server.bearer_allowed({"azp": "docs", "aud": "docs"}, "docs.example.test"))
        self.assertFalse(server.bearer_allowed({"sub": "user-1", "azp": "synapse"}, "element.example.test"))

    def test_verified_wrong_audience_token_is_rejected(self) -> None:
        claims = {"sub": "user-1", "azp": "bureaublad", "aud": "nextcloud"}
        signing_key = types.SimpleNamespace(key="public-key")

        with (
            mock.patch.object(server.JWKS_CLIENT, "get_signing_key_from_jwt", return_value=signing_key),
            mock.patch.object(server.jwt, "decode", return_value=claims),
        ):
            self.assertIsNone(server.valid_bearer("signed-token", "docs.example.test"))

    def test_invalid_signature_is_rejected(self) -> None:
        signing_key = types.SimpleNamespace(key="public-key")

        with (
            mock.patch.object(server.JWKS_CLIENT, "get_signing_key_from_jwt", return_value=signing_key),
            mock.patch.object(server.jwt, "decode", side_effect=server.jwt.InvalidSignatureError),
        ):
            self.assertIsNone(server.valid_bearer("bad-token", "docs.example.test"))


class IdTokenTests(unittest.TestCase):
    def validate(self, claims: dict[str, object], nonce: str = "nonce-1") -> dict[str, object] | None:
        signing_key = types.SimpleNamespace(key="public-key")
        with (
            mock.patch.object(server.JWKS_CLIENT, "get_signing_key_from_jwt", return_value=signing_key),
            mock.patch.object(server.jwt, "decode", return_value=claims),
        ):
            return server.valid_id_token("signed-id-token", nonce)

    def test_valid_id_token_is_accepted(self) -> None:
        claims = {
            "sub": "user-1",
            "aud": server.CLIENT_ID,
            "azp": server.CLIENT_ID,
            "nonce": "nonce-1",
            "sid": "keycloak-session-1",
        }

        self.assertEqual(self.validate(claims), claims)

    def test_wrong_nonce_is_rejected(self) -> None:
        claims = {
            "sub": "user-1",
            "aud": server.CLIENT_ID,
            "azp": server.CLIENT_ID,
            "nonce": "attacker-nonce",
            "sid": "keycloak-session-1",
        }

        self.assertIsNone(self.validate(claims))

    def test_wrong_authorized_party_is_rejected(self) -> None:
        claims = {
            "sub": "user-1",
            "aud": server.CLIENT_ID,
            "azp": "another-client",
            "nonce": "nonce-1",
            "sid": "keycloak-session-1",
        }

        self.assertIsNone(self.validate(claims))

    def test_multiple_audiences_require_this_client_as_azp(self) -> None:
        claims = {
            "sub": "user-1",
            "aud": [server.CLIENT_ID, "account"],
            "nonce": "nonce-1",
            "sid": "keycloak-session-1",
        }

        self.assertIsNone(self.validate(claims))


class ForwardedRequestTests(unittest.TestCase):
    def test_missing_proxy_headers_fail_closed(self) -> None:
        self.assertEqual(request("/auth").status, 400)

    def test_unknown_or_ambiguous_forwarded_hosts_fail_closed(self) -> None:
        unknown = forwarded_headers("evil.test", "/private")
        ambiguous = forwarded_headers("nextcloud.example.test, evil.test", "/private")

        self.assertEqual(request("/auth", unknown).status, 400)
        self.assertEqual(request("/auth", ambiguous).status, 400)

    def test_non_https_forwarded_request_fails_closed(self) -> None:
        headers = forwarded_headers("docs.example.test", "/private")
        headers["X-Forwarded-Proto"] = "http"

        self.assertEqual(request("/auth", headers).status, 400)

    def test_login_redirect_preserves_only_canonical_protected_target(self) -> None:
        response = request("/auth", forwarded_headers("docs.example.test:443", "/private?q=1"))
        query = server.urllib.parse.parse_qs(server.urllib.parse.urlsplit(response.getheader("Location")).query)

        self.assertEqual(response.status, 302)
        self.assertEqual(query["rd"], ["https://docs.example.test/private?q=1"])

    def test_bearer_verification_receives_canonical_target_host(self) -> None:
        headers = forwarded_headers("meet.example.test", "/api/v1.0/rooms/")
        headers["Authorization"] = "Bearer service-token"

        with mock.patch.object(
            server,
            "valid_bearer",
            return_value={"sub": "user-1"},
        ) as valid_bearer:
            response = request("/auth", headers)

        self.assertEqual(response.status, 204)
        valid_bearer.assert_called_once_with("service-token", "meet.example.test")


class WopiBypassTests(unittest.TestCase):
    def test_exact_wopi_callbacks_bypass_on_nextcloud_only(self) -> None:
        token = "AbCdEf0123456789AbCdEf0123456789"
        routes = (
            ("GET", "/index.php/apps/richdocuments/wopi/files/42_instance?access_token=secret"),
            ("GET", "/apps/richdocuments/wopi/files/42_instance/contents?access_token=secret"),
            ("POST", "/index.php/apps/richdocuments/wopi/files/42_instance"),
            ("POST", "/apps/richdocuments/wopi/files/42_instance/contents"),
            ("GET", "/index.php/apps/richdocuments/wopi/template/42"),
            ("GET", "/index.php/apps/richdocuments/wopi/settings?access_token=secret"),
            ("POST", "/index.php/apps/richdocuments/wopi/settings/upload"),
            ("DELETE", "/index.php/apps/richdocuments/wopi/settings"),
            ("GET", f"/index.php/apps/richdocuments/settings/userconfig/{token}/presets/config.json"),
            ("GET", f"/apps/richdocuments/settings/systemconfig/{token}/template/slides/default.otp"),
            ("GET", "/apps/richdocuments/settings/fonts.json"),
            ("GET", "/index.php/apps/richdocuments/settings/fonts/custom.ttf"),
        )

        for method, uri in routes:
            with self.subTest(method=method, uri=uri):
                response = request("/auth", forwarded_headers("nextcloud.example.test", uri, method))
                self.assertEqual(response.status, 204)

    def test_forged_wopi_uri_on_another_host_stays_protected(self) -> None:
        headers = forwarded_headers("docs.example.test", "/apps/richdocuments/wopi/files/42")

        self.assertEqual(request("/auth", headers).status, 302)

    def test_nearby_richdocuments_admin_routes_stay_protected(self) -> None:
        token = "AbCdEf0123456789AbCdEf0123456789"
        routes = (
            ("GET", "/apps/richdocuments/settings/fonts"),
            ("POST", "/apps/richdocuments/settings/fonts"),
            ("GET", "/apps/richdocuments/settings/fonts/custom.ttf/overview"),
            ("GET", "/apps/richdocuments/settings/generateToken/user"),
            ("GET", f"/apps/richdocuments/settings/admin/{token}/presets/config.json"),
            ("GET", "/apps/richdocuments/settings/userconfig/short-token/presets/config.json"),
            ("GET", f"/apps/richdocuments/settings/userconfig/{token}/bad.category/config.json"),
            ("GET", f"/apps/richdocuments/settings/userconfig/{token}/presets"),
            ("GET", "/apps/richdocuments/wopi/anything"),
            ("PUT", "/apps/richdocuments/wopi/files/42"),
            ("GET", "/apps/richdocuments/wopi/files/..%2Fsettings"),
            ("GET", "/apps/richdocuments/wopi/files/%2e%2e"),
        )

        for method, uri in routes:
            with self.subTest(method=method, uri=uri):
                response = request("/auth", forwarded_headers("nextcloud.example.test", uri, method))
                self.assertEqual(response.status, 302)


class DeployScriptTests(unittest.TestCase):
    def test_hardened_middleware_is_verified_before_deployment_apply(self) -> None:
        repo_root = Path(__file__).resolve().parent.parent.parent
        script_path = repo_root / "scripts/single-vps-deploy/12-auth-gate.sh"
        if not script_path.exists():
            self.skipTest("deploy script is outside the auth-gate container build context")
        script = script_path.read_text()

        middleware_apply = script.index("<<MIDDLEWARE_YAML")
        middleware_readback = script.index("get middleware opensuite-auth-gate")
        deployment_apply = script.index("<<WORKLOAD_YAML")
        self.assertLess(middleware_apply, middleware_readback)
        self.assertLess(middleware_readback, deployment_apply)
        middleware_stage = script[middleware_apply:middleware_readback]
        self.assertNotIn("kind: Deployment", middleware_stage)
        self.assertIn("trustForwardHeader: false", middleware_stage)
        for header in (
            "Authorization",
            "Cookie",
            "Origin",
            "Access-Control-Request-Method",
            "Access-Control-Request-Headers",
        ):
            self.assertIn(f"      - {header}", middleware_stage)
        self.assertIn('[[ "${ACTUAL_TRUST_FORWARD_HEADER}" == "false" ]]', script)
        self.assertIn('[[ "${ACTUAL_AUTH_REQUEST_HEADERS}" == "${EXPECTED_AUTH_REQUEST_HEADERS}" ]]', script)


class PreflightTests(unittest.TestCase):
    def test_patch_preflight_from_protected_origin_is_not_rejected(self) -> None:
        response = request(
            "/auth",
            {
                "Origin": "https://bridge.example.test",
                "Access-Control-Request-Method": "PATCH",
            },
        )

        self.assertEqual(response.status, 204)
        self.assertEqual(response.getheader("Access-Control-Allow-Origin"), "https://bridge.example.test")
        self.assertEqual(response.getheader("Access-Control-Allow-Methods"), "PATCH")

    def test_preflight_from_unknown_origin_gets_no_cors_grant(self) -> None:
        response = request(
            "/auth",
            {
                "Origin": "https://unknown.example.test",
                "Access-Control-Request-Method": "PATCH",
            },
        )

        self.assertEqual(response.status, 204)
        self.assertIsNone(response.getheader("Access-Control-Allow-Origin"))


class LoginCallbackTests(unittest.TestCase):
    def setUp(self) -> None:
        server.SESSIONS.clear()

    def state(self) -> tuple[str, str]:
        with mock.patch.object(server.time, "time", return_value=1_000):
            return server.make_state("https://docs.example.test/private", "verifier-1", "nonce-1")

    def test_login_uses_nonce_pkce_and_host_only_state_cookie(self) -> None:
        response = request("/login?rd=https%3A%2F%2Fdocs.example.test%2Fprivate")
        query = server.urllib.parse.parse_qs(server.urllib.parse.urlsplit(response.getheader("Location")).query)
        state_cookie = response.getheader("Set-Cookie")

        self.assertEqual(response.status, 302)
        self.assertEqual(query["code_challenge_method"], ["S256"])
        self.assertTrue(query["nonce"][0])
        self.assertTrue(query["state"][0])
        self.assertIn(f"{server.STATE_COOKIE_NAME}=", state_cookie)
        self.assertNotIn("Domain=", state_cookie)

    def test_invalid_id_token_does_not_create_session(self) -> None:
        state, state_cookie = self.state()
        tokens = {"access_token": "access-1", "id_token": "bad-id-token"}

        with (
            mock.patch.object(server.time, "time", return_value=1_000),
            mock.patch.object(server, "exchange_code", return_value=tokens),
            mock.patch.object(server, "valid_id_token", return_value=None),
            mock.patch.object(server, "fetch_userinfo") as userinfo,
        ):
            response = request(
                f"/callback?code=code-1&state={state}",
                {"Cookie": f"{server.STATE_COOKIE_NAME}={state_cookie}"},
            )

        self.assertEqual(response.status, 302)
        self.assertEqual(response.getheader("Location"), f"https://{server.AUTH_HOST}/login")
        self.assertFalse(server.SESSIONS)
        userinfo.assert_not_called()

    def test_userinfo_subject_must_match_id_token(self) -> None:
        state, state_cookie = self.state()
        tokens = {"access_token": "access-1", "id_token": "id-1", "expires_in": 300}

        with (
            mock.patch.object(server.time, "time", return_value=1_000),
            mock.patch.object(server, "exchange_code", return_value=tokens),
            mock.patch.object(
                server,
                "valid_id_token",
                return_value={"sub": "user-1", "sid": "keycloak-session-1"},
            ),
            mock.patch.object(server, "fetch_userinfo", return_value={"sub": "attacker"}),
        ):
            response = request(
                f"/callback?code=code-1&state={state}",
                {"Cookie": f"{server.STATE_COOKIE_NAME}={state_cookie}"},
            )

        self.assertEqual(response.status, 302)
        self.assertFalse(server.SESSIONS)


class RedirectAndLoggingTests(unittest.TestCase):
    def test_redirect_target_is_limited_to_known_protected_hosts(self) -> None:
        fallback = "https://bridge.example.test/"

        self.assertEqual(server.safe_redirect_target("https://docs.example.test/private"), "https://docs.example.test/private")
        self.assertEqual(server.safe_redirect_target("https://id.example.test/admin"), fallback)
        self.assertEqual(server.safe_redirect_target("https://unknown.example.test/"), fallback)
        self.assertEqual(server.safe_redirect_target("https://docs.example.test:444/private"), fallback)
        self.assertEqual(server.safe_redirect_target("https://docs.example.test@evil.test/"), fallback)

    def test_request_log_redacts_query_secrets(self) -> None:
        fake_handler = types.SimpleNamespace(
            path="/callback?code=secret-code&state=secret-state",
            command="GET",
            request_version="HTTP/1.1",
            log_message=mock.Mock(),
        )

        server.Handler.log_request(fake_handler, 302, "-")

        rendered = repr(fake_handler.log_message.call_args)
        self.assertIn("/callback", rendered)
        self.assertNotIn("secret-code", rendered)
        self.assertNotIn("secret-state", rendered)


if __name__ == "__main__":
    unittest.main()
