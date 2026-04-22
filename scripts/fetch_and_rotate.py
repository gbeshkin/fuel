import json
import os
import shutil
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

API_URL = "https://fuelest.ee/Home/GetLatestPriceData?countryId=1"

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR = os.path.join(ROOT, "data")
LATEST = os.path.join(DATA_DIR, "latest.json")
PREV = os.path.join(DATA_DIR, "prev.json")
META = os.path.join(DATA_DIR, "meta.json")


def fetch_json(url: str) -> dict:
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9,et;q=0.8",
        "Referer": "https://fuelest.ee/",
        "Origin": "https://fuelest.ee",
        "X-Requested-With": "XMLHttpRequest",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }

    print(f"Fetching: {url}")
    print("Using headers:")
    for key, value in headers.items():
        print(f"  {key}: {value}")

    req = Request(url, headers=headers)

    with urlopen(req, timeout=30) as response:
        raw = response.read().decode("utf-8")
        print(f"HTTP status: {response.status}")
        print(f"Response length: {len(raw)}")
        print(f"Response preview: {raw[:300]}")
        return json.loads(raw)


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


def main() -> int:
    os.makedirs(DATA_DIR, exist_ok=True)

    try:
        data = fetch_json(API_URL)

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

    except HTTPError as e:
        msg = f"HTTPError {e.code}: {e.reason}"
        print(f"ERROR: {msg}")
        write_meta("error", msg, API_URL)
        return 1

    except URLError as e:
        msg = f"URLError: {e.reason}"
        print(f"ERROR: {msg}")
        write_meta("error", msg, API_URL)
        return 1

    except json.JSONDecodeError as e:
        msg = f"JSONDecodeError: {str(e)}"
        print(f"ERROR: {msg}")
        write_meta("error", msg, API_URL)
        return 1

    except Exception as e:
        msg = f"Unexpected error: {str(e)}"
        print(f"ERROR: {msg}")
        write_meta("error", msg, API_URL)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())