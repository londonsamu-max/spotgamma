#!/usr/bin/env python3
"""
Download 1-minute OHLC candle data from SpotGamma's twelve_series API.
For each symbol with GEX history, downloads intraday bars for every trading day.
Supports resume (skips dates with existing data).
"""

from __future__ import annotations

import os
import sys
import json
import time
import hmac
import hashlib
import base64
import requests
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, List, Dict

# ── Config ──────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent.parent
GEX_DIR = BASE_DIR / "data" / "historical" / "gex-history"
GAMMA_BARS_DIR = BASE_DIR / "data" / "historical" / "gamma-bars"
OHLC_DIR = BASE_DIR / "data" / "historical" / "ohlc-1min"
TOKEN_FILE = BASE_DIR / ".sg_token"
API_URL = "https://api.spotgamma.com/v1/twelve_series"

SYMBOLS = ["SPX", "SPY", "QQQ", "GLD", "VIX", "DIA", "IWM", "UVIX"]
RATE_LIMIT_DELAY = 0.5  # seconds between requests

# ── Authentication ──────────────────────────────────────────────────────────
def make_jwt():
    """Generate HS256 JWT with empty payload signed by 'secretKeyValue'."""
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "HS256", "typ": "JWT"}).encode()
    ).rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(
        json.dumps({}).encode()
    ).rstrip(b"=").decode()
    sig = base64.urlsafe_b64encode(
        hmac.new(b"secretKeyValue", f"{header}.{payload}".encode(), hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    return f"{header}.{payload}.{sig}"


def load_bearer_token():
    """Read Bearer token from .sg_token file."""
    return TOKEN_FILE.read_text().strip()


def get_headers():
    return {
        "x-json-web-token": make_jwt(),
        "Authorization": f"Bearer {load_bearer_token()}",
        "Accept": "application/json",
    }


# ── Date loading ────────────────────────────────────────────────────────────
def load_gex_dates(symbol: str) -> list[str]:
    """Load sorted list of trading dates (YYYY-MM-DD).
    Prefers gex-history/{symbol}.json, falls back to gamma-bars/ folder
    (dir per date), which guarantees coverage for all 8 symbols."""
    gex_file = GEX_DIR / f"{symbol}.json"
    if gex_file.exists():
        with open(gex_file) as f:
            data = json.load(f)
        dates = set()
        for entry in data:
            raw = entry.get("quote_date", "")
            if raw:
                dates.add(raw[:10])
        return sorted(dates)

    if GAMMA_BARS_DIR.exists():
        dates = sorted(d.name for d in GAMMA_BARS_DIR.iterdir()
                       if d.is_dir() and len(d.name) == 10 and d.name[4] == '-')
        return dates

    print(f"  WARNING: No date source for {symbol}, skipping.")
    return []


# ── Download logic ──────────────────────────────────────────────────────────
def download_day(symbol: str, date_str: str, headers: dict) -> list[dict] | None:
    """Download 1-min OHLC for a single symbol/date. Returns bar list or None on error."""
    params = {
        "symbol": symbol,
        "interval": "1min",
        "start_date": date_str,
    }
    try:
        resp = requests.get(API_URL, headers=headers, params=params, timeout=30)
        if resp.status_code == 429:
            print("    Rate limited (429). Waiting 10s...")
            time.sleep(10)
            resp = requests.get(API_URL, headers=headers, params=params, timeout=30)
        if resp.status_code != 200:
            print(f"    HTTP {resp.status_code}: {resp.text[:200]}")
            return None
        data = resp.json()
        # Response format: { "SYMBOL": { "meta": {...}, "values": [...] } }
        if isinstance(data, dict) and symbol in data:
            inner = data[symbol]
            bars = inner.get("values", [])
        elif isinstance(data, dict) and "values" in data:
            bars = data["values"]
        elif isinstance(data, list):
            bars = data
        else:
            print(f"    Unexpected response structure: {list(data.keys()) if isinstance(data, dict) else type(data)}")
            return None

        # Normalize bar format
        normalized = []
        for bar in bars:
            normalized.append({
                "t": bar.get("datetime") or bar.get("t") or bar.get("timestamp"),
                "o": float(bar.get("open", 0)),
                "h": float(bar.get("high", 0)),
                "l": float(bar.get("low", 0)),
                "c": float(bar.get("close", 0)),
                "v": int(bar.get("volume", 0)),
            })
        return normalized
    except requests.exceptions.RequestException as e:
        print(f"    Request error: {e}")
        return None


def save_bars(symbol: str, date_str: str, bars: list[dict]):
    """Save bars to JSON file."""
    out_dir = OHLC_DIR / symbol
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"{date_str}.json"
    with open(out_file, "w") as f:
        json.dump(bars, f, separators=(",", ":"))


def already_downloaded(symbol: str, date_str: str) -> bool:
    """Check if data file already exists and is non-empty."""
    out_file = OHLC_DIR / symbol / f"{date_str}.json"
    return out_file.exists() and out_file.stat().st_size > 10


# ── Main ────────────────────────────────────────────────────────────────────
def download_symbol(symbol: str, max_days: int = 0):
    """Download all missing 1-min OHLC for a symbol. max_days=0 means all."""
    print(f"\n{'='*60}")
    print(f"  {symbol}")
    print(f"{'='*60}")

    dates = load_gex_dates(symbol)
    if not dates:
        return

    if max_days > 0:
        dates = dates[-max_days:]  # most recent N days

    total = len(dates)
    skipped = 0
    downloaded = 0
    errors = 0
    headers = get_headers()

    for i, date_str in enumerate(dates, 1):
        if already_downloaded(symbol, date_str):
            skipped += 1
            continue

        bars = download_day(symbol, date_str, headers)
        if bars is not None:
            save_bars(symbol, date_str, bars)
            downloaded += 1
            print(f"  {symbol} {date_str}: {len(bars)} bars downloaded ({i}/{total})")
        else:
            errors += 1
            print(f"  {symbol} {date_str}: FAILED ({i}/{total})")

        time.sleep(RATE_LIMIT_DELAY)

    print(f"\n  Summary for {symbol}: {downloaded} downloaded, {skipped} skipped, {errors} errors (of {total} dates)")


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Download 1-min OHLC from SpotGamma")
    parser.add_argument("--symbols", nargs="+", default=SYMBOLS,
                        help="Symbols to download (default: all 8)")
    parser.add_argument("--max-days", type=int, default=0,
                        help="Max days per symbol (0=all, useful for testing)")
    args = parser.parse_args()

    print(f"Starting OHLC download: {args.symbols}")
    print(f"Max days per symbol: {'all' if args.max_days == 0 else args.max_days}")
    print(f"Output directory: {OHLC_DIR}")

    for symbol in args.symbols:
        download_symbol(symbol, max_days=args.max_days)

    print("\nDone!")


if __name__ == "__main__":
    main()
