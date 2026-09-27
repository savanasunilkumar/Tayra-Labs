"""Google Identity Platform identities; never derive ownership from request bodies."""
from __future__ import annotations

import hashlib
import os
import time
from dataclasses import dataclass
from datetime import timedelta

from .service import Problem

SESSION_SECONDS = 5 * 24 * 60 * 60


@dataclass(frozen=True)
class Principal:
    uid: str
    email: str
    email_verified: bool
    name: str = ""
    auth_time: int = 0
    pilot: bool = False

    @property
    def tenant(self) -> str:
        return "pilot" if self.pilot else "user_" + hashlib.sha256(self.uid.encode()).hexdigest()


def principal_from_claims(claims: dict) -> Principal:
    uid = claims.get("uid") or claims.get("sub")
    email = claims.get("email")
    if not isinstance(uid, str) or not 1 <= len(uid) <= 128 or not isinstance(email, str) or not email:
        raise Problem(401, "invalid_identity", "A valid email-based account is required")
    return Principal(uid, email, claims.get("email_verified") is True,
                     str(claims.get("name", ""))[:80], int(claims.get("auth_time", 0)))


class FirebaseIdentity:
    def __init__(self, project: str):
        self.project = project
        self._app = None

    @property
    def app(self):
        if not self.project:
            raise Problem(503, "auth_not_configured", "Authentication is not configured")
        # Unsigned emulator tokens must never be accepted by a real cloud project.
        if os.getenv("FIREBASE_AUTH_EMULATOR_HOST") and not self.project.startswith("demo-"):
            raise Problem(503, "invalid_auth_configuration", "Emulator authentication requires a demo project")
        if self._app is None:
            import firebase_admin
            name = "tayra-" + self.project
            try:
                self._app = firebase_admin.get_app(name)
            except ValueError:
                self._app = firebase_admin.initialize_app(options={"projectId": self.project, "httpTimeout": 10}, name=name)
        return self._app

    def verify(self, token: str, *, session: bool = False) -> Principal:
        from firebase_admin import auth, exceptions
        from google.auth.exceptions import GoogleAuthError
        try:
            verify = auth.verify_session_cookie if session else auth.verify_id_token
            claims = verify(token, app=self.app, check_revoked=True)
            return principal_from_claims(claims)
        except Problem:
            raise
        except (auth.InvalidIdTokenError, auth.InvalidSessionCookieError,
                auth.RevokedIdTokenError, auth.RevokedSessionCookieError,
                auth.UserDisabledError, auth.UserNotFoundError, ValueError):
            raise Problem(401, "session_expired", "Please sign in again") from None
        except (exceptions.FirebaseError, GoogleAuthError):
            raise Problem(503, "auth_unavailable", "Authentication is temporarily unavailable") from None

    def create_session(self, token: str) -> tuple[str, Principal]:
        from firebase_admin import auth, exceptions
        from google.auth.exceptions import GoogleAuthError
        principal = self.verify(token)
        require_verified(principal)
        age = time.time() - principal.auth_time
        if not 0 <= age <= 300:
            raise Problem(401, "recent_login_required", "Please sign in again to start a session")
        try:
            cookie = auth.create_session_cookie(token, timedelta(seconds=SESSION_SECONDS), app=self.app)
            return cookie, principal
        except (exceptions.FirebaseError, GoogleAuthError):
            raise Problem(503, "auth_unavailable", "Could not create a session. Please try again") from None

    def revoke(self, uid: str) -> None:
        from firebase_admin import auth, exceptions
        from google.auth.exceptions import GoogleAuthError
        try:
            auth.revoke_refresh_tokens(uid, app=self.app)
        except (exceptions.FirebaseError, GoogleAuthError):
            raise Problem(503, "auth_unavailable", "Could not sign out all sessions. Please try again") from None


def require_verified(principal: Principal) -> None:
    if not principal.pilot and not principal.email_verified:
        raise Problem(403, "email_not_verified", "Verify your email before accessing videos or analyses")
