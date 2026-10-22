"""Send a text message with a Telegram bot token from the environment."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

TOKEN_ENV = "TELEGRAM_BOT_TOKEN"
CHAT_ENV = "TELEGRAM_CHAT_ID"


def credentials_from_env() -> tuple[str, str]:
    return os.environ.get(TOKEN_ENV, "").strip(), os.environ.get(CHAT_ENV, "").strip()


def send_message(text: str, token: str, chat_id: str, *, timeout: int = 30) -> dict:
    """Post text to Telegram. Does not log the token."""
    payload = urllib.parse.urlencode(
        {"chat_id": chat_id, "text": text, "disable_web_page_preview": "true"}
    ).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=payload,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        return {"sent": False, "reason": f"http_{exc.code}", "detail": detail}
    except urllib.error.URLError as exc:
        return {"sent": False, "reason": "network", "detail": str(exc.reason)}
    if not body.get("ok"):
        return {"sent": False, "reason": "api_rejected", "detail": str(body.get("description") or "")[:300]}
    result = body.get("result") if isinstance(body.get("result"), dict) else {}
    return {"sent": True, "reason": "ok", "message_id": result.get("message_id")}
