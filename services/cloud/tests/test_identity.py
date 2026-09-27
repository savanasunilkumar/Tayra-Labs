import time
from dataclasses import replace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from firebase_admin import auth

from services.cloud.api import create_app
from services.cloud.config import Settings
from services.cloud.identity import FirebaseIdentity, Principal, principal_from_claims
from services.cloud.service import Problem, Service
from services.cloud.tests.fakes import MemoryObjects, MemoryStore, MemoryTasks
from services.cloud.tests.test_pipeline import ready_asset


class FakeIdentity:
    def __init__(self):
        self.users = {key: Principal(key, key + "@example.test", key != "unverified", key, int(time.time()))
                      for key in ["alice", "bob", "unverified"]}
        self.revoked = set()
        self.calls = []

    def verify(self, token, *, session=False):
        self.calls.append((token, session))
        uid = token.removeprefix("cookie-") if session else token
        if uid not in self.users or uid in self.revoked:
            raise Problem(401, "invalid_token", "Sign in again")
        return self.users[uid]

    def create_session(self, token):
        return "cookie-" + token, self.verify(token)

    def revoke(self, uid):
        self.revoked.add(uid)


@pytest.fixture
def account_app():
    service = Service(Settings(project_id="demo-tayra-auth", api_key="old-shared-key"), MemoryStore(), MemoryObjects(), MemoryTasks())
    identity = FakeIdentity()
    with TestClient(create_app(service, identity)) as client:
        yield client, service, identity


def headers(user="alice", session=False):
    return {"Authorization": f"Session cookie-{user}" if session else f"Bearer {user}"}


def test_account_profile_is_server_owned_and_persists(account_app):
    client, service, identity = account_app
    response = client.post("/v1/auth/session", json={"id_token": "alice"})
    assert response.status_code == 200
    assert response.json()["session_cookie"] == "cookie-alice"
    user = response.json()["user"]
    assert user["workspace_id"] == identity.users["alice"].tenant
    assert user["id"] == "alice"
    assert client.patch("/v1/me", headers=headers(), json={"display_name": "Alice Tayra"}).status_code == 200
    assert client.get("/v1/me", headers=headers(session=True)).json()["user"]["display_name"] == "Alice Tayra"
    assert ("cookie-alice", True) in identity.calls
    for field in ["email", "uid", "workspace_id", "role", "tenant_id", "email_verified"]:
        assert client.patch("/v1/me", headers=headers(), json={"display_name": "x", field: "admin"}).status_code == 422
    assert client.get("/v1/me", headers=headers("bob")).json()["user"]["email"] == "bob@example.test"
    assert service.store.get("users", identity.users["bob"].tenant) is None


def test_no_shared_key_fallback_and_no_anonymous_data(account_app):
    client, _, _ = account_app
    for authorization in [None, "Bearer old-shared-key", "Bearer forged", "Session cookie-forged", "Basic alice"]:
        h = {"Authorization": authorization} if authorization else {}
        for path in ["/v1/me", "/v1/jobs", "/openapi.json"]:
            assert client.get(path, headers=h).status_code == 401
        assert client.post("/v1/assets", headers=h, json={"filename": "a.mp4", "content_type": "video/mp4", "size_bytes": 4}).status_code == 401


def test_ownership_checks_before_every_read_or_mutation(account_app):
    client, service, identity = account_app
    alice = identity.users["alice"].tenant
    asset_id = ready_asset(service, alice)
    job_id = service.create_job(asset_id, "Describe", 16, "same-key", alice)["job"]["id"]
    before = service.store.get("jobs", job_id)
    for method, path in [("GET", f"/v1/assets/{asset_id}"), ("POST", f"/v1/assets/{asset_id}/complete"),
                         ("POST", f"/v1/assets/{asset_id}/upload-url"), ("DELETE", f"/v1/assets/{asset_id}"),
                         ("GET", f"/v1/jobs/{job_id}"), ("GET", f"/v1/jobs/{job_id}/result"),
                         ("POST", f"/v1/jobs/{job_id}/cancel")]:
        assert client.request(method, path, headers=headers("bob")).status_code == 404
    assert service.store.get("jobs", job_id) == before
    assert not service.objects.deleted
    assert job_id in service.tasks.ids
    assert client.post("/v1/jobs", headers={**headers("bob"), "Idempotency-Key": "same-key"}, json={"asset_id": asset_id, "prompt": "x"}).status_code == 404
    assert client.get("/v1/jobs", headers=headers("bob")).json()["jobs"] == []
    assert [j["id"] for j in client.get("/v1/jobs", headers=headers()).json()["jobs"]] == [job_id]


def test_unverified_accounts_cannot_access_data(account_app):
    client, _, _ = account_app
    assert client.get("/v1/jobs", headers=headers("unverified")).status_code == 403
    assert client.post("/v1/assets", headers=headers("unverified"), json={"filename": "a.mp4", "content_type": "video/mp4", "size_bytes": 4}).status_code == 403


def test_logout_all_revokes_only_current_user(account_app):
    client, _, identity = account_app
    assert client.post("/v1/auth/logout-all", headers=headers(session=True)).status_code == 204
    assert identity.revoked == {"alice"}
    assert client.get("/v1/me", headers=headers(session=True)).status_code == 401
    assert client.get("/v1/me", headers=headers("bob")).status_code == 200


def test_firebase_sdk_verifies_revocation_for_both_token_types(monkeypatch):
    identity = FirebaseIdentity("demo-tayra-auth")
    identity._app = object()
    claims = {"uid": "alice", "email": "alice@example.test", "email_verified": True, "auth_time": int(time.time())}
    for session, method in [(False, "verify_id_token"), (True, "verify_session_cookie")]:
        verify = Mock(return_value=claims)
        monkeypatch.setattr(auth, method, verify)
        assert identity.verify("opaque", session=session).uid == "alice"
        verify.assert_called_once_with("opaque", app=identity.app, check_revoked=True)
    monkeypatch.setattr(auth, "verify_id_token", Mock(side_effect=auth.RevokedIdTokenError("revoked")))
    with pytest.raises(Problem) as error:
        identity.verify("revoked")
    assert error.value.status == 401


def test_fresh_verified_login_required_for_cookie(monkeypatch):
    identity = FirebaseIdentity("demo-tayra-auth")
    identity._app = object()
    principal = Principal("alice", "a@example.test", True, auth_time=int(time.time()))
    mint = Mock(return_value="session")
    monkeypatch.setattr(auth, "create_session_cookie", mint)
    for invalid in [replace(principal, auth_time=1), replace(principal, auth_time=int(time.time()) + 600), replace(principal, email_verified=False)]:
        monkeypatch.setattr(identity, "verify", lambda token: invalid)
        with pytest.raises(Problem):
            identity.create_session("token")
    mint.assert_not_called()
    monkeypatch.setattr(identity, "verify", lambda token: principal)
    assert identity.create_session("token")[0] == "session"


def test_real_project_rejects_unsigned_emulator_tokens(monkeypatch):
    monkeypatch.setenv("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099")
    with pytest.raises(Problem, match="demo project"):
        FirebaseIdentity("video-api-dev-509820").app


def test_missing_or_invalid_identity_claims_rejected():
    for claims in [{}, {"uid": "a"}, {"uid": "a", "email": 1}, {"uid": "x" * 129, "email": "a@b.test"}]:
        with pytest.raises(Problem):
            principal_from_claims(claims)
