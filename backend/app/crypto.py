"""Fernet-based at-rest encryption for sensitive workspace credentials.

The key is derived deterministically from settings.workspace_secret
(or JWT_SECRET as fallback) via SHA-256, then base64-encoded to
match Fernet's key format. Keeping the secret stable across reboots
is what lets the same DB row decrypt the same token tomorrow.
"""
from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from .config import settings


def _fernet() -> Fernet:
    secret = (settings.workspace_secret or settings.jwt_secret).encode("utf-8")
    key = base64.urlsafe_b64encode(hashlib.sha256(secret).digest())
    return Fernet(key)


def encrypt_secret(plaintext: str | None) -> str | None:
    if not plaintext:
        return None
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_secret(token: str | None) -> str | None:
    if not token:
        return None
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken:
        return None
