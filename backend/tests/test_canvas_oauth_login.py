"""Signing a student in through Canvas's OAuth2 instead of a university IdP.

Canvas is stubbed the same way the OIDC provider is stubbed in
test_oidc_login.py: what is asserted is the request this app sends Canvas,
and what it does with what Canvas sends back. Canvas itself is what sits in
front of SWAMID — this app never speaks SAML, so there is nothing SWAMID-
shaped to mock here at all.
"""

from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from app import canvas_oauth, service
from app.auth import FLOW_COOKIE
from app.config import get_settings
from app.db import SessionLocal
from app.models import User

BASE_URL = "https://canvas.su.se"
CLIENT_ID = "quizbinf-canvas-app"
REDIRECT = "http://testserver/api/auth/canvas-callback"


@pytest.fixture
def canvas_oauth_configured(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "canvas_base_url", BASE_URL)
    monkeypatch.setattr(settings, "canvas_oauth_client_id", CLIENT_ID)
    monkeypatch.setattr(settings, "canvas_oauth_client_secret", "s3cret")
    return settings


@pytest.fixture
def provider(monkeypatch):
    """Stub Canvas's token and users/self endpoints, recording what we sent."""
    calls = {"token_request": None}

    def install(user_response, token_status=200, user_status=200, access_token="tok-abc"):
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/login/oauth2/token"):
                calls["token_request"] = dict(
                    parse_qs(request.content.decode(), keep_blank_values=True)
                )
                if token_status != 200:
                    return httpx.Response(token_status, json={"error": "invalid_grant"})
                return httpx.Response(200, json={"access_token": access_token})
            if request.url.path.endswith("/api/v1/users/self"):
                assert request.headers["authorization"] == f"Bearer {access_token}"
                return httpx.Response(user_status, json=user_response)
            raise AssertionError(f"unexpected request to {request.url}")

        real_client = httpx.Client

        def factory(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            return real_client(*args, **kwargs)

        monkeypatch.setattr(canvas_oauth.httpx, "Client", factory)
        return calls

    return install


@pytest.fixture
def enrolled(teacher_client):
    """One student on the roster of a synced course, keyed by canvas_user_id."""
    db = SessionLocal()
    teacher = db.query(User).filter(User.username == "teach").one()
    service.sync_roster(
        db,
        teacher,
        49207,
        [
            {
                "canvas_user_id": 109957,
                "kthid": "u17z7fwu",
                "username": "shiraza",
                "display_name": "Shiraz Abbas",
            }
        ],
    )
    db.close()


def _start_flow(client, next_url="/s/abc123"):
    resp = client.get(f"/api/auth/canvas-login?next={next_url}", follow_redirects=False)
    return parse_qs(urlparse(resp.headers["location"]).query)["state"][0]


def test_canvas_login_is_501_until_it_is_configured(client):
    resp = client.get("/api/auth/canvas-login", follow_redirects=False)
    assert resp.status_code == 501
    assert "CANVAS_OAUTH_CLIENT_ID" in resp.json()["detail"]


def test_canvas_login_redirects_to_canvas(client, canvas_oauth_configured, provider):
    provider({})
    resp = client.get("/api/auth/canvas-login?next=/s/abc123", follow_redirects=False)

    assert resp.status_code == 307
    target = urlparse(resp.headers["location"])
    assert f"{target.scheme}://{target.netloc}{target.path}" == f"{BASE_URL}/login/oauth2/auth"

    params = parse_qs(target.query)
    assert params["response_type"] == ["code"]
    assert params["client_id"] == [CLIENT_ID]
    assert params["redirect_uri"] == [REDIRECT]
    assert params["state"]
    # The flow state rides in a signed cookie, not on the server — same
    # mechanism the OIDC flow uses.
    assert FLOW_COOKIE in resp.cookies


def test_a_successful_callback_signs_the_enrolled_student_in(
    client, canvas_oauth_configured, provider, enrolled
):
    calls = provider({"id": 109957, "name": "Shiraz Abbas"})
    state = _start_flow(client)

    resp = client.get(
        f"/api/auth/canvas-callback?code=abc&state={state}", follow_redirects=False
    )
    assert resp.status_code == 303
    assert resp.headers["location"] == "/s/abc123"

    # Exchanged over the back channel, with the secret — never via the browser.
    assert calls["token_request"]["grant_type"] == ["authorization_code"]
    assert calls["token_request"]["client_secret"] == ["s3cret"]
    assert calls["token_request"]["redirect_uri"] == [REDIRECT]

    me = client.get("/api/auth/me").json()
    # The roster's identity wins, not whatever Canvas calls the account.
    assert me["username"] == "shiraza"
    assert me["display_name"] == "Shiraz Abbas"
    assert me["role"] == "student"


def test_a_canvas_account_not_on_the_roster_is_refused(
    client, canvas_oauth_configured, provider, enrolled
):
    provider({"id": 999999, "name": "Nobody Enrolled"})
    state = _start_flow(client)

    resp = client.get(f"/api/auth/canvas-callback?code=abc&state={state}")
    assert resp.status_code == 403
    assert "not on the course roster" in resp.json()["detail"]
    assert client.get("/api/auth/me").status_code == 401


def test_a_teacher_is_not_matched_by_canvas_login(
    client, canvas_oauth_configured, provider, enrolled
):
    """Teachers are deliberately excluded from the synced roster — they keep
    using roster-login's shared-password branch instead."""
    provider({"id": 42, "name": "Teach Er"})
    state = _start_flow(client)

    resp = client.get(f"/api/auth/canvas-callback?code=abc&state={state}")
    assert resp.status_code == 403


def test_a_mismatched_state_is_refused(client, canvas_oauth_configured, provider, enrolled):
    provider({"id": 109957})
    _start_flow(client)

    resp = client.get("/api/auth/canvas-callback?code=abc&state=not-the-state")
    assert resp.status_code == 400
    assert client.get("/api/auth/me").status_code == 401


def test_a_callback_without_a_flow_cookie_is_refused(client, canvas_oauth_configured, provider):
    provider({"id": 109957})
    resp = client.get("/api/auth/canvas-callback?code=abc&state=anything")
    assert resp.status_code == 400


def test_a_refused_token_exchange_is_reported_not_swallowed(
    client, canvas_oauth_configured, provider
):
    provider({}, token_status=400)
    state = _start_flow(client)

    resp = client.get(f"/api/auth/canvas-callback?code=stale&state={state}")
    assert resp.status_code == 502


def test_canvas_declining_returns_to_the_login_page(client, canvas_oauth_configured, provider):
    provider({})
    resp = client.get(
        "/api/auth/canvas-callback?error=access_denied", follow_redirects=False
    )
    assert resp.status_code == 303
    assert resp.headers["location"] == "/login?error=canvas"


def test_the_flow_cannot_redirect_off_site(
    client, canvas_oauth_configured, provider, enrolled
):
    provider({"id": 109957})
    for hostile in ("https://evil.example/phish", "//evil.example/phish"):
        state = _start_flow(client, hostile)
        resp = client.get(
            f"/api/auth/canvas-callback?code=abc&state={state}", follow_redirects=False
        )
        assert resp.headers["location"] == "/", hostile


def test_methods_reports_canvas_oauth_once_configured(client, canvas_oauth_configured):
    assert client.get("/api/auth/methods").json()["canvas_oauth"] is True


def test_methods_reports_canvas_oauth_false_until_configured(client):
    assert client.get("/api/auth/methods").json()["canvas_oauth"] is False
