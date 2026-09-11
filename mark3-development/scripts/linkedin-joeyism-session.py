#!/usr/bin/env python3
import asyncio
import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SESSION = PROJECT_ROOT / ".ultron" / "credentials" / "linkedin-joeyism-session.json"

async def main():
    try:
        from linkedin_scraper import BrowserManager, wait_for_manual_login
    except Exception as exc:
        raise SystemExit(f"linkedin_scraper is not installed: {exc}")

    target = Path(os.environ.get("ULTRON_M3_LINKEDIN_JOEYISM_SESSION") or DEFAULT_SESSION).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)

    print("Opening a visible browser for manual LinkedIn sign-in.")
    print("ULTRON will not ask for or store your LinkedIn password.")
    async with BrowserManager(headless=False) as browser:
        await browser.page.goto("https://www.linkedin.com/login", wait_until="domcontentloaded")
        await wait_for_manual_login(browser.page, timeout=300000)
        await browser.save_session(str(target))

    try:
        os.chmod(target, 0o600)
    except Exception:
        pass
    print(f"LinkedIn fallback session saved locally: {target}")

if __name__ == "__main__":
    asyncio.run(main())
