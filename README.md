# fuel

Static fuel price site with GitHub Pages frontend and hourly data refresh through Playwright.

## Local run

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium
python scripts/fetch_and_rotate.py
```

## GitHub Actions

The hourly workflow installs Playwright, launches Chromium, opens `fuelest.ee`, and fetches the JSON from inside the browser context. This is needed because direct server-side requests return `401 Unauthorized` behind Cloudflare.
