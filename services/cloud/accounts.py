from __future__ import annotations

from .identity import Principal
from .service import Service


def account(service: Service, principal: Principal) -> dict:
    stored = service.store.get("users", principal.tenant) or {}
    return {
        "id": principal.uid,
        "email": principal.email,
        "email_verified": principal.email_verified,
        "display_name": stored.get("display_name", principal.name),
        "created_at": stored.get("created_at"),
        "workspace_id": principal.tenant,
    }


def save_account(service: Service, principal: Principal, display_name: str | None = None) -> dict:
    def save(tx):
        current = tx.get("users", principal.tenant) or {
            "uid": principal.uid, "created_at": service.clock(), "display_name": principal.name,
        }
        current.update(email=principal.email, email_verified=principal.email_verified, updated_at=service.clock())
        if display_name is not None:
            current["display_name"] = display_name
        tx.put("users", principal.tenant, current)
    service.store.transact(save)
    return account(service, principal)
