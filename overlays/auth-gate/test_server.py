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
        self.assertEqual(session["token_exp"], 1_300)

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


if __name__ == "__main__":
    unittest.main()
