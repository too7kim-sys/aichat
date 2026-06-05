"""Email sender (aiosmtplib) with a stdout fallback for dev.

When SMTP_HOST is empty we log the full message to the server log so the
verification / reset links are still recoverable during local
development without any SMTP account."""
from __future__ import annotations

import logging
from email.message import EmailMessage

import aiosmtplib

from .config import settings

log = logging.getLogger("uvicorn.error")


def _from_addr() -> str:
    return settings.smtp_from or settings.smtp_username or "no-reply@localhost"


async def send_email(*, to: str, subject: str, body_text: str) -> None:
    msg = EmailMessage()
    msg["From"] = _from_addr()
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body_text)

    if not settings.smtp_host:
        # Dev fallback: dump to log instead of attempting SMTP.
        log.warning(
            "[email-dev] SMTP_HOST not set — printing email to log:\n"
            "  To: %s\n  Subject: %s\n  Body:\n%s",
            to,
            subject,
            body_text,
        )
        return

    try:
        await aiosmtplib.send(
            msg,
            hostname=settings.smtp_host,
            port=settings.smtp_port,
            username=settings.smtp_username or None,
            password=settings.smtp_password or None,
            start_tls=settings.smtp_use_tls and not settings.smtp_use_ssl,
            use_tls=settings.smtp_use_ssl,
            timeout=15,
        )
    except Exception as exc:  # noqa: BLE001
        log.error("SMTP send failed (%s): %s", type(exc).__name__, exc)
        raise


def verify_url(token: str) -> str:
    base = settings.app_base_url.rstrip("/")
    return f"{base}/?verify={token}"


def reset_url(token: str) -> str:
    base = settings.app_base_url.rstrip("/")
    return f"{base}/?reset={token}"


async def send_verify_email(to: str, name: str, token: str) -> None:
    link = verify_url(token)
    body = (
        f"안녕하세요 {name or to.split('@', 1)[0]}님,\n\n"
        f"Chat 가입을 완료하려면 아래 링크를 클릭해 이메일을 인증해 주세요. "
        f"링크는 {settings.verify_token_hours}시간 동안 유효합니다.\n\n"
        f"{link}\n\n"
        f"본인이 가입하지 않았다면 이 메일을 무시하셔도 됩니다.\n"
    )
    await send_email(to=to, subject="[Chat] 이메일 인증", body_text=body)


async def send_reset_email(to: str, name: str, token: str) -> None:
    link = reset_url(token)
    body = (
        f"안녕하세요 {name or to.split('@', 1)[0]}님,\n\n"
        f"비밀번호 재설정 요청을 받았습니다. 아래 링크를 클릭해 새 비밀번호를 "
        f"설정해 주세요. 링크는 {settings.reset_token_hours}시간 동안 유효합니다.\n\n"
        f"{link}\n\n"
        f"본인이 요청하지 않았다면 이 메일을 무시하셔도 됩니다. "
        f"계정은 그대로 유지됩니다.\n"
    )
    await send_email(to=to, subject="[Chat] 비밀번호 재설정", body_text=body)


# Signup-approval lifecycle notifications. These are best-effort —
# the auth router swallows send failures so a flaky SMTP doesn't
# block the approval/rejection action itself.

async def send_signup_pending_email(to: str, name: str) -> None:
    body = (
        f"안녕하세요 {name or to.split('@', 1)[0]}님,\n\n"
        f"Chat 가입 신청이 접수되었습니다. 관리자 승인 후 로그인하실 수 "
        f"있습니다. 승인이 완료되면 별도로 안내 메일을 보내드립니다.\n\n"
        f"가입해 주셔서 감사합니다.\n"
    )
    await send_email(
        to=to, subject="[Chat] 가입 신청 접수 — 승인 대기", body_text=body,
    )


async def send_account_approved_email(to: str, name: str) -> None:
    base = settings.app_base_url.rstrip("/")
    body = (
        f"안녕하세요 {name or to.split('@', 1)[0]}님,\n\n"
        f"Chat 가입이 승인되었습니다. 이제 로그인하실 수 있습니다.\n\n"
        f"{base}/\n\n"
        f"이용해 주셔서 감사합니다.\n"
    )
    await send_email(
        to=to, subject="[Chat] 가입 승인 완료", body_text=body,
    )


async def send_account_rejected_email(
    to: str, name: str, reason: str | None,
) -> None:
    reason_block = (
        f"\n사유: {reason.strip()}\n" if reason and reason.strip() else ""
    )
    body = (
        f"안녕하세요 {name or to.split('@', 1)[0]}님,\n\n"
        f"Chat 가입 신청이 반려되었습니다.{reason_block}\n"
        f"문의 사항이 있으시면 관리자에게 연락해 주세요.\n"
    )
    await send_email(
        to=to, subject="[Chat] 가입 신청 반려", body_text=body,
    )
