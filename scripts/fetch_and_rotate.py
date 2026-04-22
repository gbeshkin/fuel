import json
import os
import shutil
import sys
from datetime import datetime, timezone
from urllib.request import urlopen, Request

API_URL = "https://fuelest.ee/Home/GetLatestPriceDataByStations?countryId=1"


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR = os.path.join(ROOT, "data")
LATEST = os.path.join(DATA_DIR, "latest.json")
PREV = os.path.join(DATA_DIR, "prev.json")
META = os.path.join(DATA_DIR, "meta.json")


def fetch_json(url: str) -> dict:
    from urllib.request import Request, urlopen
    import json

    headers = {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://fuelest.ee/",
        "Origin": "https://fuelest.ee",
    }

    req = Request(url, headers=headers)

    with urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def main() -> int:
  os.makedirs(DATA_DIR, exist_ok=True)

  # rotate: latest -> prev (если latest существует)
  if os.path.exists(LATEST):
    shutil.copyfile(LATEST, PREV)

  data = fetch_json(API_URL)

  with open(LATEST, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False)

  meta = {
    "source": API_URL,
    "updated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
  }
  with open(META, "w", encoding="utf-8") as f:
    json.dump(meta, f, ensure_ascii=False, indent=2)

  return 0


if __name__ == "__main__":
  raise SystemExit(main())
