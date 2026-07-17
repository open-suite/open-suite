import http.client
import os
import threading
import unittest
from unittest import mock


os.environ.setdefault("OPEN_SUITE_DOMAIN", "example.test")
os.environ.setdefault("OIDC_ISSUER", "https://id.example.test/realms/test")
os.environ.setdefault("OIDC_CLIENT_SECRET", "client-secret")
os.environ.setdefault("COOKIE_SECRET", "cookie-secret")

import server  # noqa: E402


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
            cookie = server.make_session(tokens, {"sub": "user-1", "email": "user@example.test"})
        session = server.SESSIONS[server.unsign(cookie)]
        return cookie, session

    def test_new_session_uses_refresh_token_lifetime(self) -> None:
        _, session = self.make_session()

        self.assertEqual(session["exp"], 4_600)
        self.assertEqual(session["token_exp"], 1_300)
        self.assertEqual(session["refresh_token"], "refresh-1")

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
        httpd = server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever)
        thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port)
            connection.request(
                "GET",
                "/logout?rd=https%3A%2F%2Fbridge.example.test%2F",
                headers={"Cookie": f"{server.COOKIE_NAME}={cookie}"},
            )
            response = connection.getresponse()
            response.read()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join()

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

    def test_frontchannel_logout_clears_gate_session_and_cookie(self) -> None:
        cookie, _ = self.make_session()
        httpd = server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever)
        thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port)
            connection.request(
                "GET",
                "/frontchannel-logout",
                headers={"Cookie": f"{server.COOKIE_NAME}={cookie}"},
            )
            response = connection.getresponse()
            response.read()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join()

        self.assertEqual(response.status, 204)
        self.assertIn("Max-Age=0", response.getheader("Set-Cookie"))
        self.assertNotIn(server.unsign(cookie), server.SESSIONS)


class LogoutCallbackTests(unittest.TestCase):
    def request_auth(self, host: str, uri: str) -> int:
        httpd = server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever)
        thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port)
            connection.request(
                "GET",
                "/auth",
                headers={"X-Forwarded-Host": host, "X-Forwarded-Uri": uri},
            )
            response = connection.getresponse()
            response.read()
            return response.status
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join()

    def test_exact_app_logout_callbacks_bypass_gate(self) -> None:
        callbacks = {
            "bridge.example.test": "/api/v1/auth/logout",
            "docs.example.test": "/api/v1.0/logout/",
            "grist.example.test": "/o/docs/logout?next=/",
            "meet.example.test": "/api/v1.0/logout/",
            "nextcloud.example.test": "/index.php/apps/user_oidc/backchannel-logout/keycloak",
        }

        for host, uri in callbacks.items():
            with self.subTest(host=host):
                self.assertEqual(self.request_auth(host, uri), 204)

    def test_logout_path_on_wrong_host_stays_protected(self) -> None:
        self.assertEqual(self.request_auth("grist.example.test", "/api/v1.0/logout/"), 302)

    def test_nearby_grist_path_stays_protected(self) -> None:
        self.assertEqual(self.request_auth("grist.example.test", "/o/docs/logout-all"), 302)


if __name__ == "__main__":
    unittest.main()
