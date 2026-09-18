"""Signing a student in via Canvas's OAuth2, instead of a university IdP.

Stockholm University's own IdP speaks SAML through SWAMID, not OIDC — running
a SAML service provider here would mean a new crypto/XML dependency and
registering signed SP metadata with the federation operator, an
administrative step at least as slow as the one still waiting on KTH IT.

Canvas is already a SWAMID relying party: a student signs into canvas.su.se
through SWAMID before this flow ever starts, so the university IdP is never
spoken to directly. All this module does is the standard OAuth2
authorization-code dance against Canvas itself, ending with a Canvas user id.
That id means nothing on its own — `RosterEntry.canvas_user_id`, filled in by
the existing roster sync, is what turns it into a KTH-style identity
(kthid/username/display name). A Canvas login for someone not in a synced
roster is therefore refused by the caller, the same as an unenrolled address
is refused by roster-login today.

No access token is ever stored: it is used once, to ask Canvas who just
signed in, then discarded.
"""

import logging
from urllib.parse import urlencode

import httpx

log = logging.getLogger("quizbinf")

TIMEOUT = httpx.Timeout(15.0)


class CanvasOAuthError(Exception):
    """Canvas could not be reached, or refused the exchange."""


def authorization_url(base_url: str, client_id: str, redirect_uri: str, state: str) -> str:
    params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "state": state,
        # Only asked for what the callback actually needs. Canvas ignores
        # this entirely unless the developer key has "Enforce Scopes" turned
        # on, in which case an unlisted scope makes the *token* request fail
        # rather than the authorize step — set here so both cases work.
        "scope": "url:GET|/api/v1/users/self",
    }
    return f"{base_url.rstrip('/')}/login/oauth2/auth?{urlencode(params)}"


def exchange_code(
    base_url: str,
    code: str,
    redirect_uri: str,
    client_id: str,
    client_secret: str,
) -> dict:
    """Trade the authorization code for an access token, over the back channel."""
    data = {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "code": code,
    }
    try:
        with httpx.Client(timeout=TIMEOUT, follow_redirects=True) as client:
            response = client.post(f"{base_url.rstrip('/')}/login/oauth2/token", data=data)
    except httpx.HTTPError as exc:
        raise CanvasOAuthError(f"Could not reach Canvas: {exc}") from exc
    if response.status_code != 200:
        raise CanvasOAuthError(
            f"Canvas token exchange failed ({response.status_code}): {response.text[:300]}"
        )
    try:
        return response.json()
    except ValueError as exc:
        raise CanvasOAuthError("Canvas returned a malformed token response") from exc


def fetch_self(base_url: str, access_token: str) -> dict:
    """Who just signed in, straight from Canvas rather than trusted off the token response.

    The token response usually embeds a `user` object already, but its shape
    has changed across Canvas versions before; asking `/users/self` directly
    is one extra round trip for a login that happens once per student per
    device, and it is the same endpoint the roster sync already trusts.
    """
    try:
        with httpx.Client(timeout=TIMEOUT, follow_redirects=True) as client:
            response = client.get(
                f"{base_url.rstrip('/')}/api/v1/users/self",
                headers={"Authorization": f"Bearer {access_token}"},
            )
    except httpx.HTTPError as exc:
        raise CanvasOAuthError(f"Could not reach Canvas: {exc}") from exc
    if response.status_code != 200:
        raise CanvasOAuthError(f"Canvas rejected the access token ({response.status_code})")
    try:
        return response.json()
    except ValueError as exc:
        raise CanvasOAuthError("Canvas returned a malformed user response") from exc
