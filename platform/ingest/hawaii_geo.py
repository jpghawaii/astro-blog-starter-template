"""Hawaii geography helpers derived from the official LODES8 geography crosswalk
(2020 census blocks with internal-point lat/lon, county, ZCTA, tract). No hand-made lookup tables."""
from __future__ import annotations

import csv
import gzip
import math
from collections import Counter, defaultdict
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import requests

from .db import ROOT, RateLimiter, with_retries

CACHE = ROOT / "data" / "cache"
LODES_BASE = "https://lehd.ces.census.gov/data/lodes/LODES8/hi"
_limiter = RateLimiter(1.0)

# Hawaii main-island extent; anything outside is flagged out_of_bounds.
HI_LAT = (18.8, 22.35)
HI_LON = (-160.6, -154.7)

COUNTY_ISLANDS = {"15001": "Hawaii Island", "15003": "Oahu", "15007": "Kauai", "15005": "Molokai (Kalawao)"}


def in_hawaii(lat: float | None, lon: float | None) -> bool:
    return lat is not None and lon is not None and HI_LAT[0] <= lat <= HI_LAT[1] and HI_LON[0] <= lon <= HI_LON[1]


def download(name: str, subdir: str = "", log=print) -> Path:
    """Downloads a LODES file into the cache (with retries & rate limit); reuses cached copy."""
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / name
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    url = f"{LODES_BASE}/{subdir}{name}"

    def fetch():
        _limiter.wait()
        r = requests.get(url, timeout=120)
        r.raise_for_status()
        return r.content

    data = with_retries(fetch, log=log)
    dest.write_bytes(data)
    return dest


@dataclass
class Block:
    geoid: str
    lat: float
    lon: float
    county: str
    tract: str
    zcta: str


@lru_cache(maxsize=1)
def blocks() -> list[Block]:
    path = download("hi_xwalk.csv.gz")
    out = []
    with gzip.open(path, "rt", newline="") as f:
        for r in csv.DictReader(f):
            out.append(Block(r["tabblk2020"], float(r["blklatdd"]), float(r["blklondd"]), r["cty"], r["trct"], r["zcta"]))
    return out


@lru_cache(maxsize=1)
def _grid() -> dict:
    g = defaultdict(list)
    for b in blocks():
        g[(math.floor(b.lat * 50), math.floor(b.lon * 50))].append(b)  # ~2.2 km cells
    return g


def blocks_within(lat: float, lon: float, radius_m: float) -> list[tuple[Block, float]]:
    from .matching import haversine_m
    g = _grid()
    cells = math.ceil(radius_m / 2000) + 1
    ci, cj = math.floor(lat * 50), math.floor(lon * 50)
    out = []
    for di in range(-cells, cells + 1):
        for dj in range(-cells, cells + 1):
            for b in g.get((ci + di, cj + dj), ()):
                d = haversine_m(lat, lon, b.lat, b.lon)
                if d <= radius_m:
                    out.append((b, d))
    return out


def nearest_block(lat: float, lon: float) -> Block | None:
    for r in (500, 3000, 15000):
        hits = blocks_within(lat, lon, r)
        if hits:
            return min(hits, key=lambda x: x[1])[0]
    return None


@lru_cache(maxsize=1)
def zcta_county() -> dict[str, str]:
    """ZCTA -> county with most blocks (a ZCTA never crosses islands in Hawaii except via water)."""
    c: dict[str, Counter] = defaultdict(Counter)
    for b in blocks():
        if b.zcta and b.zcta != "99999":
            c[b.zcta][b.county] += 1
    return {z: cnt.most_common(1)[0][0] for z, cnt in c.items()}


def island_for(county: str | None, lat: float | None = None, lon: float | None = None) -> str | None:
    if not county:
        return None
    if county == "15009":  # Maui County spans Maui, Molokai, Lanai
        if lat is not None and lon is not None:
            if lat > 21.0 and lon < -156.7:
                return "Molokai"
            if lat < 20.95 and lon < -156.8:
                return "Lanai"
        return "Maui"
    return COUNTY_ISLANDS.get(county)
