import json
import os
import shutil
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

SITE_URL = "https://fuelest.ee/"
API_URL = "https://fuelest.ee/Home/GetLatestPriceData?countryId=1"

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR = os.path.join(ROOT, "data")
DEBUG_DIR = os.path.join(ROOT, "debug")
LATEST = os.path.join(DATA_DIR, "latest.json")
PREV = os.path.join(DATA_DIR, "prev.json")
META = os.path.join(DATA_DIR, "meta.json")
DEBUG_HTML = os.path.join(DEBUG_DIR, "fuelest-debug.html")
DEBUG_PNG = os.path.join(DEBUG_DIR, "fuelest-debug.png")


def ensure_dirs() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(DEBUG_DIR, exist_ok=True)


def write_meta(status: str, message: str, source: str) -> None:
    meta = {
        "source": source,
        "updated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "status": status,
        "message": message,
    }
    with open(META, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)


def rotate_files() -> None:
    if os.path.exists(LATEST):
        shutil.copyfile(LATEST, PREV)
        print(f"Rotated {LATEST} -> {PREV}")
    else:
        print("No latest.json yet, skipping rotation")


def save_latest(data: dict) -> None:
    with open(LATEST, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    print(f"Saved latest snapshot to {LATEST}")


def save_debug(page) -> None:
    try:
        page.screenshot(path=DEBUG_PNG, full_page=True)
        print(f"Saved debug screenshot to {DEBUG_PNG}")
    except Exception as e:
        print(f"Could not save screenshot: {e}")

    try:
        html = page.content()
        with open(DEBUG_HTML, "w", encoding="utf-8") as f:
            f.write(html)
        print(f"Saved debug HTML to {DEBUG_HTML}")
    except Exception as e:
        print(f"Could not save HTML: {e}")


def fetch_via_page_context() -> dict:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            locale="en-US",
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/147.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1440, "height": 1000},
        )

        page = context.new_page()

        try:
            print(f"Opening site: {SITE_URL}")
            page.goto(SITE_URL, wait_until="domcontentloaded", timeout=60000)

            # Небольшая пауза на случай challenge / cookies / client scripts
            page.wait_for_timeout(8000)

            title = page.title()
            print(f"Page title: {title}")

            # Можно посмотреть cookies, вдруг что-то выдалось после захода
            cookies = context.cookies()
            print(f"Cookies count after opening site: {len(cookies)}")

            print(f"Fetching API from page context: {API_URL}")
            result = page.evaluate(
                """
                async (apiUrl) => {
                  try {
                    const response = await fetch(apiUrl, {
                      method: "GET",
                      credentials: "include",
                      headers: {
                        "Accept": "application/json, text/plain, */*",
                        "X-Requested-With": "XMLHttpRequest"
                      }
                    });

                    const text = await response.text();

                    return {
                      ok: response.ok,
                      status: response.status,
                      url: response.url,
                      text: text
                    };
                  } catch (e) {
                    return {
                      ok: false,
                      status: -1,
                      url: apiUrl,
                      text: String(e)
                    };
                  }
                }
                """,
                API_URL,
            )

            print(f"Page fetch status: {result['status']}")
            print(f"Page fetch URL: {result['url']}")
            print(f"Response length: {len(result['text'])}")
            print(f"Response preview: {result['text'][:300]}")

            save_debug(page)

            if not result["ok"]:
                raise RuntimeError(
                    f"Page-context fetch failed with HTTP {result['status']}"
                )

            try:
                data = json.loads(result["text"])
            except json.JSONDecodeError as e:
                raise RuntimeError(f"Response is not valid JSON: {e}")

            browser.close()
            return data

        except PlaywrightTimeoutError as e:
            save_debug(page)
            browser.close()
            raise RuntimeError(f"Playwright timeout: {e}") from e

        except Exception:
            save_debug(page)
            browser.close()
            raise


def main() -> int:
    ensure_dirs()

    try:
        data = fetch_via_page_context()

        if not data:
            msg = "Empty response from API"
            print(f"ERROR: {msg}")
            write_meta("error", msg, API_URL)
            return 1

        rotate_files()
        save_latest(data)
        write_meta("ok", "Update completed successfully", API_URL)
        print("Update completed successfully")
        return 0

    except Exception as e:
        msg = f"Playwright fetch failed: {e}"
        print(f"ERROR: {msg}")
        write_meta("error", msg, API_URL)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())