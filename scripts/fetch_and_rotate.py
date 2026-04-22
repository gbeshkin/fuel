import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

SITE_URL = "https://fuelest.ee/"
API_URL = "https://fuelest.ee/Home/GetLatestPriceData?countryId=1"

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
LATEST = DATA_DIR / "latest.json"
PREV = DATA_DIR / "prev.json"
META = DATA_DIR / "meta.json"
DEBUG_DIR = ROOT / "debug"
DEBUG_SCREENSHOT = DEBUG_DIR / "fuelest-debug.png"
DEBUG_HTML = DEBUG_DIR / "fuelest-debug.html"


def write_meta(status: str, message: str, source: str = API_URL) -> None:
    meta = {
        "source": source,
        "updated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "status": status,
        "message": message,
    }
    META.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def rotate_files() -> None:
    if LATEST.exists():
        shutil.copyfile(LATEST, PREV)
        print(f"Rotated {LATEST} -> {PREV}")
    else:
        print("No latest.json yet, skipping rotation")


def save_latest(data: dict) -> None:
    LATEST.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print(f"Saved latest snapshot to {LATEST}")


def _save_debug_artifacts(page) -> None:
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    try:
        page.screenshot(path=str(DEBUG_SCREENSHOT), full_page=True)
        print(f"Saved debug screenshot to {DEBUG_SCREENSHOT}")
    except Exception as exc:  # noqa: BLE001
        print(f"Could not save screenshot: {exc}")

    try:
        DEBUG_HTML.write_text(page.content(), encoding="utf-8")
        print(f"Saved debug HTML to {DEBUG_HTML}")
    except Exception as exc:  # noqa: BLE001
        print(f"Could not save HTML dump: {exc}")


def fetch_json_via_playwright() -> dict:
    print(f"Opening site: {SITE_URL}")
    print(f"Fetching API through browser context: {API_URL}")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
            ],
        )
        context = browser.new_context(
            locale="en-US",
            timezone_id="Europe/Tallinn",
            viewport={"width": 1440, "height": 1024},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/147.0.0.0 Safari/537.36"
            ),
            extra_http_headers={
                "Accept-Language": "en-US,en;q=0.9,et;q=0.8",
            },
        )
        page = context.new_page()

        try:
            page.goto(SITE_URL, wait_until="domcontentloaded", timeout=90000)
            page.wait_for_timeout(8000)

            result = page.evaluate(
                """async (apiUrl) => {
                    const response = await fetch(apiUrl, {
                        method: 'GET',
                        credentials: 'include',
                        headers: {
                            'Accept': 'application/json, text/plain, */*',
                            'X-Requested-With': 'XMLHttpRequest'
                        }
                    });

                    return {
                        url: response.url,
                        status: response.status,
                        ok: response.ok,
                        text: await response.text()
                    };
                }""",
                API_URL,
            )

            print(f"Browser fetch status: {result['status']}")
            print(f"Browser fetch URL: {result['url']}")
            print(f"Response length: {len(result['text'])}")
            print(f"Response preview: {result['text'][:300]}")

            if result["status"] != 200:
                _save_debug_artifacts(page)
                raise RuntimeError(f"Browser fetch failed with HTTP {result['status']}")

            if not result["text"].strip():
                _save_debug_artifacts(page)
                raise RuntimeError("Browser fetch returned empty body")

            data = json.loads(result["text"])
            if not isinstance(data, dict):
                _save_debug_artifacts(page)
                raise RuntimeError("Unexpected JSON shape: top-level value is not an object")

            return data

        except PlaywrightTimeoutError as exc:
            _save_debug_artifacts(page)
            raise RuntimeError(f"Playwright timeout: {exc}") from exc
        finally:
            context.close()
            browser.close()


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    try:
        data = fetch_json_via_playwright()

        if not data:
            msg = "Empty response from browser fetch"
            print(f"ERROR: {msg}")
            write_meta("error", msg)
            return 1

        rotate_files()
        save_latest(data)
        write_meta("ok", "Update completed successfully via Playwright")
        print("Update completed successfully")
        return 0

    except Exception as exc:  # noqa: BLE001
        msg = f"Playwright fetch failed: {exc}"
        print(f"ERROR: {msg}")
        write_meta("error", msg)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
