"""Name normalization and fuzzy matching. Mirrors lib/reconcile.ts so web and ingest agree."""
from __future__ import annotations

import math
import re
import unicodedata
from collections import Counter

AUTO_MATCH = 0.92
REVIEW = 0.6
STOP = {"the", "inc", "llc", "ltd", "co", "corp", "dba", "hawaii", "hi", "store", "center", "centre"}
ABBR = {"aim": "aloha island mart", "ave": "avenue", "st": "street", "hwy": "highway", "blvd": "boulevard",
        "rd": "road", "ctr": "center", "mkt": "market"}


def normalize_name(s: str) -> str:
    s = unicodedata.normalize("NFKD", (s or "").lower())
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[ʻ‘’']", "", s).replace("&", " and ")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    toks = " ".join(ABBR.get(t, t) for t in s.split()).split()
    return " ".join(t for t in toks if t not in STOP).strip()


def _bigrams(s: str) -> Counter:
    t = f" {s} "
    return Counter(t[i:i + 2] for i in range(len(t) - 1))


def name_similarity(a: str, b: str) -> float:
    na, nb = normalize_name(a), normalize_name(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    A, B = _bigrams(na), _bigrams(nb)
    inter = sum(min(c, B[g]) for g, c in A.items())
    return 2 * inter / (sum(A.values()) + sum(B.values()))


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6_371_008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def match(name: str, lat: float | None, lon: float | None, candidates: list[dict]) -> dict:
    """candidates: [{id, name, lat, lon}] -> {decision: auto|review|unmatched, best, score, ranked}"""
    scored = []
    for c in candidates:
        s = name_similarity(name, c["name"])
        if lat is not None and lon is not None and c.get("lat") is not None and c.get("lon") is not None:
            d = haversine_m(lat, lon, c["lat"], c["lon"])
            if d < 75:
                s = min(1.0, s + 0.1)
            elif d > 2000:
                s *= 0.6
        scored.append((round(s, 3), c))
    scored.sort(key=lambda x: -x[0])
    if not scored:
        return {"decision": "unmatched", "best": None, "score": 0.0, "ranked": []}
    top = scored[0]
    ambiguous = len(scored) > 1 and top[0] - scored[1][0] < 0.05
    decision = "auto" if top[0] >= AUTO_MATCH and not ambiguous else "review" if top[0] >= REVIEW else "unmatched"
    return {"decision": decision, "best": top[1], "score": top[0], "ranked": scored[:5]}


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", normalize_name(s)).strip("-")[:80] or "unnamed"
