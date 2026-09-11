#!/usr/bin/env python3
import asyncio
import json
import os
import sys
from pathlib import Path

def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=str))
    sys.stdout.flush()

def serializable(value):
    if value is None:
        return None
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if hasattr(value, "dict"):
        return value.dict()
    if isinstance(value, (list, tuple)):
        return [serializable(x) for x in value]
    if isinstance(value, dict):
        return {str(k): serializable(v) for k, v in value.items()}
    return value

async def run(payload):
    try:
        from linkedin_scraper import BrowserManager, PersonScraper, CompanyScraper, JobSearchScraper
    except Exception as exc:
        return {"ok": False, "error_kind": "dependency", "error": f"linkedin_scraper is not installed: {exc}"}

    action = str(payload.get("action") or "").strip().lower()
    session_path = Path(str(payload.get("session_path") or "")).expanduser().resolve()
    if not session_path.exists():
        return {"ok": False, "error_kind": "auth", "error": f"LinkedIn fallback session is missing at {session_path}. Run the explicit manual setup first."}

    try:
        async with BrowserManager(headless=True) as browser:
            await browser.load_session(str(session_path))
            if action == "person":
                url = str(payload.get("url") or "").strip()
                if not url:
                    raise ValueError("person action requires url")
                result = await PersonScraper(browser.page).scrape(url)
            elif action == "company":
                url = str(payload.get("url") or "").strip()
                if not url:
                    raise ValueError("company action requires url")
                result = await CompanyScraper(browser.page).scrape(url)
            elif action == "jobs":
                keywords = str(payload.get("keywords") or "").strip() or None
                location = str(payload.get("location") or "").strip() or None
                limit = max(1, min(25, int(payload.get("limit") or 10)))
                result = await JobSearchScraper(browser.page).search(keywords=keywords, location=location, limit=limit)
            else:
                raise ValueError(f"Unsupported read-only LinkedIn fallback action: {action}")
            return {"ok": True, "action": action, "result": serializable(result)}
    except Exception as exc:
        text = str(exc)
        lower = text.lower()
        if any(token in lower for token in ("checkpoint", "challenge", "captcha", "verify your identity", "security verification")):
            kind = "manual-lock"
        elif any(token in lower for token in ("rate limit", "too many requests", "temporarily blocked", "throttl")):
            kind = "rate-limit"
        elif any(token in lower for token in ("auth", "login", "session", "not logged")):
            kind = "auth"
        else:
            kind = "scrape"
        return {"ok": False, "error_kind": kind, "error": text[:1500]}

async def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw or "{}")
    except Exception:
        emit({"ok": False, "error_kind": "input", "error": "Worker expected one JSON object on stdin."})
        return
    emit(await run(payload))

if __name__ == "__main__":
    asyncio.run(main())
