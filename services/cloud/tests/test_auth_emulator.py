"""Opt-in integration: Firebase SDK + real auth emulator, no cloud users or GPU.

FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 .venv/bin/pytest -q services/cloud/tests/test_auth_emulator.py
"""
import os
import secrets
import time
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi.testclient import TestClient
from firebase_admin import auth

from services.cloud.api import create_app
from services.cloud.config import Settings
from services.cloud.identity import FirebaseIdentity
from services.cloud.service import Service
from services.cloud.tests.fakes import MemoryObjects, MemoryStore, MemoryTasks

pytestmark = pytest.mark.skipif(os.getenv("FIREBASE_AUTH_EMULATOR_HOST") != "127.0.0.1:9099", reason="local auth emulator is not running")


def test_real_sdk_signup_verification_session_profile_and_reset():
    identity = FirebaseIdentity("demo-tayra-auth")
    service = Service(Settings(project_id="demo-tayra-auth", analysis_enabled=False), MemoryStore(), MemoryObjects(), MemoryTasks())
    email, password = "auth-" + secrets.token_hex(6) + "@example.test", secrets.token_urlsafe(24)
    base = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:"

    def call(action, body):
        response = httpx.post(base + action, params={"key": "demo-key"}, json=body)
        assert response.status_code == 200, f"Emulator {action} failed with {response.status_code}"
        return response.json()

    credential = call("signUp", {"email": email, "password": password, "returnSecureToken": True})
    uid = credential["localId"]
    try:
        with TestClient(create_app(service, identity)) as client:
            assert client.post("/v1/auth/session", json={"id_token": credential["idToken"]}).status_code == 403
            link = auth.generate_email_verification_link(email, app=identity.app)
            code = parse_qs(urlparse(link).query)["oobCode"][0]
            call("update", {"oobCode": code})
            credential = call("signInWithPassword", {"email": email, "password": password, "returnSecureToken": True})
            response = client.post("/v1/auth/session", json={"id_token": credential["idToken"]})
            assert response.status_code == 200
            session = response.json()["session_cookie"]
            h = {"Authorization": "Session " + session}
            assert client.get("/v1/me", headers=h).json()["user"]["email_verified"]
            assert client.patch("/v1/me", headers=h, json={"display_name": "Integration account"}).status_code == 200
            assert client.get("/v1/jobs", headers=h).json()["jobs"] == []
            # A disabled account must not retain access through an already-issued cookie.
            auth.update_user(uid, disabled=True, app=identity.app)
            assert client.get("/v1/me", headers=h).status_code == 401
            auth.update_user(uid, disabled=False, app=identity.app)
            # Reset link validation and a new password are exercised only in the emulator.
            link = auth.generate_password_reset_link(email, app=identity.app)
            code = parse_qs(urlparse(link).query)["oobCode"][0]
            password = secrets.token_urlsafe(24)
            time.sleep(1.1)  # Firebase auth_time/revocation timestamps have one-second granularity.
            call("resetPassword", {"oobCode": code, "newPassword": password})
            assert client.get("/v1/me", headers=h).status_code == 401
            credential = call("signInWithPassword", {"email": email, "password": password, "returnSecureToken": True})
            response = client.post("/v1/auth/session", json={"id_token": credential["idToken"]})
            h = {"Authorization": "Session " + response.json()["session_cookie"]}
            time.sleep(1.1)
            assert client.post("/v1/auth/logout-all", headers=h).status_code == 204
            assert client.get("/v1/me", headers=h).status_code == 401
    finally:
        auth.delete_user(uid, app=identity.app)
