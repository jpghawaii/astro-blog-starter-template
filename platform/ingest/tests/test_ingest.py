"""Integration tests for ingestion. Run against TEST_DATABASE_URL (never the production DB):
    python -m pytest ingest/tests -q
LODES/geography tests use the cached official LODES8 crosswalk (downloaded on first run)."""
from __future__ import annotations

import csv
import os
from pathlib import Path

import pytest

from ingest import hawaii_geo as hg
from ingest.adapters.inventory import import_geopath_master, parse_rate
from ingest.adapters.templates import import_template, revenue_class
from ingest.commercial.providers import import_provider_file
from ingest.db import connect, load_env
from ingest.matching import haversine_m, match, name_similarity, normalize_name

load_env()
TEST_URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not TEST_URL, reason="TEST_DATABASE_URL not set")
TABLES = "import_run, venue, asset, capacity_period, match_exception, metric_observation, campaign, advertiser, booking, invoice_line, proof_of_play, conversion_event, traffic_count, creative, poi, road_segment, vehicle_gps_point"


@pytest.fixture()
def conn():
    assert "test" in TEST_URL, "tests must never run against a non-test database"
    c = connect(TEST_URL)
    with c.cursor() as cur:
        cur.execute(f"TRUNCATE {TABLES} RESTART IDENTITY CASCADE")
    c.commit()
    yield c
    c.close()


def write_csv(path: Path, header: list[str], rows: list[list]) -> Path:
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    return path


GEOPATH_HEADER = ["place_type", "place_name", "place_address", "place_city", "place_state", "place_zip", "place_latitude", "place_longitude",
                  "operator_frame_id", "frame_description (shown internally)", "operator_media_name", "placement_type", "frame_status",
                  "average_spot_length", "frame_latitude", "frame_longitude", "Venue/center", "Ad ID as used by JPG", "Rate/price if listed", "Notes", "Notes/conflicts"]


def geopath_rows():
    return [
        ["Gas Station", "AIM 10th Avenue", "1451 10th Avenue", "Honolulu", "HI", "96816", "21.288164", "-157.798339", "", "Pump top", "Gas Station Media (Pump Tops)", "At Pump", "Operating", "", "", "", "AIM 10th Avenue", "", "$500.00 per 4 weeks (2022 rate card)", "", ""],
        ["Gas Station", "AIM 10th Avenue", "1451 10th Avenue", "Honolulu", "HI", "96816", "21.288164", "-157.798339", "", "Pump top", "Gas Station Media (Pump Tops)", "At Pump", "Operating", "", "", "", "AIM 10th Avenue", "", "$500.00 per 4 weeks (2022 rate card)", "", ""],
        ["Gas Station", "AIM 10TH AVE. COOLER", "", "", "", "", "", "", "JPG92 AIM 10TH AVE. COOLER", "Installed screen", "C-Store Digital Screen", "In-Store Cooler", "", "15", "", "", "AIM 10th Ave", "JPG92", "Aloha & HELE kit: all 84 venues $2,100 / 4 weeks", "", ""],
        ["Hotel", "Somewhere Hotel", "", "", "", "", "37.45", "-87.2", "", "Hotel screen 1 of 1 (kit: 300 rooms, Oahu)", "Hotel Digital Screen", "Hotel Interior", "", "15", "", "", "Somewhere Hotel", "", "", "", "Island listed in kit: Oahu"],
        ["Gas Station", "Unknown thing", "", "", "", "", "", "", "", "x", "Smoke Signals", "Sky", "", "", "", "", "Unknown thing", "", "", "", ""],
    ]


# ---------------------------------------------------------------------------- pure helpers
def test_normalization_and_similarity():
    assert normalize_name("Hawaiʻi Kai Towne Center") == normalize_name("Hawaii Kai Towne Center")
    assert normalize_name("AIM 10th Ave.") == "aloha island mart 10th avenue"
    assert name_similarity("AIM 10th Ave", "Aloha Island Mart 10th Avenue") == 1.0
    assert name_similarity("Times Kailua", "Times Kaneohe") < 0.92


def test_match_ambiguity_and_distance_penalty():
    c = [{"id": 1, "name": "Times Supermarket", "lat": 19.70, "lon": -155.08}]
    assert match("Times Supermarket", 21.30, -157.80, c)["decision"] != "auto"
    c2 = [{"id": 1, "name": "HELE Hilo", "lat": None, "lon": None}, {"id": 2, "name": "HELE Kilo", "lat": None, "lon": None}]
    assert match("HELE Hilo", None, None, c2)["decision"] == "auto"


def test_rate_parsing_never_divides_packages():
    assert parse_rate("$500.00 per 4 weeks (2022 rate card)") == 500
    assert parse_rate("$550 each / 4 weeks; production/install $750 each") == 550
    assert parse_rate("Aloha & HELE kit: all 84 venues $2,100 / 4 weeks") is None
    assert parse_rate("Kit: $500 per hotel / 4 weeks") is None


def test_revenue_classification():
    assert revenue_class("GETax - Oahu", "GE Tax Collected") == "tax"
    assert revenue_class("Discount", "Refunds-Allowances") == "discount"
    assert revenue_class("Production & Install", "Sales") == "production"
    assert revenue_class("Alohilani Resort - DOOH", "Sales") == "media"


# ---------------------------------------------------------------------------- geography
def test_hawaii_bounds_and_islands():
    assert hg.in_hawaii(21.3, -157.85) and not hg.in_hawaii(37.45, -87.2)
    b = hg.nearest_block(21.2826, -157.8371)  # Waikiki
    assert b.county == "15003" and hg.island_for(b.county) == "Oahu"
    b = hg.nearest_block(20.8893, -156.4729)  # Kahului
    assert hg.island_for(b.county, 20.8893, -156.4729) == "Maui"
    assert hg.island_for("15009", 21.09, -157.02) == "Molokai"
    assert hg.island_for("15001") == "Hawaii Island"


def test_blocks_within_radius_matches_bruteforce():
    lat, lon, r = 21.2970, -157.8590, 800  # downtown Honolulu
    fast = {b.geoid for b, _ in hg.blocks_within(lat, lon, r)}
    brute = {b.geoid for b in hg.blocks() if haversine_m(lat, lon, b.lat, b.lon) <= r}
    assert fast == brute and len(fast) > 10


# ---------------------------------------------------------------------------- imports
def test_geopath_import_idempotent_with_exceptions(conn, tmp_path):
    p = write_csv(tmp_path / "geo.csv", GEOPATH_HEADER, geopath_rows())
    first = import_geopath_master(conn, p)
    second = import_geopath_master(conn, p)
    assert first["rows_inserted"] > 0
    assert second["rows_inserted"] == 0 and second["rows_updated"] == 0
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM venue")
        assert cur.fetchone()[0] == 2  # cooler row reconciled to AIM 10th Avenue; hotel separate
        cur.execute("SELECT count(*) FROM asset")
        assert cur.fetchone()[0] == 4  # two identical pump tops kept as two units
        cur.execute("SELECT issue FROM match_exception ORDER BY issue")
        issues = {r[0] for r in cur.fetchall()}
        assert {"out_of_bounds", "unknown_format", "no_coordinates", "missing_loop_spec"} <= issues
        cur.execute("SELECT island, location FROM venue WHERE name='Somewhere Hotel'")
        island, loc = cur.fetchone()
        assert island == "Oahu" and loc is None  # stated island used; bad coordinates discarded, not kept
        cur.execute("SELECT rate_4wk_usd FROM asset WHERE operator_frame_id IS NOT NULL")
        assert cur.fetchone()[0] is None  # package rate never divided per unit


def test_template_validation_rejects_bad_rows(conn, tmp_path):
    hdr = next(csv.reader(open(Path(__file__).resolve().parents[2] / "templates" / "venues.csv")))
    p = write_csv(tmp_path / "venues.csv", hdr, [
        ["v1", "Good Venue", "gas_station", "", "1 A St", "Honolulu", "96816", "", 21.29, -157.80, ""],
        ["v2", "Mainland Venue", "gas_station", "", "", "", "", "", 40.7, -74.0, ""],
        ["v3", "Half coords", "gas_station", "", "", "", "", "", 21.29, "", ""],
    ])
    out = import_template(conn, "venues", p)
    assert out["rows_inserted"] == 1 and out["rows_rejected"] == 2
    with conn.cursor() as cur:
        cur.execute("SELECT island FROM venue WHERE venue_key='v1'")
        assert cur.fetchone()[0] == "Oahu"  # island derived from coordinates via census blocks
        cur.execute("SELECT count(*) FROM match_exception WHERE issue='invalid_row'")
        assert cur.fetchone()[0] == 2


def test_venue_counts_share_bounds_and_idempotency(conn, tmp_path):
    root = Path(__file__).resolve().parents[2] / "templates"
    import_template(conn, "venues", root / "venues.csv")
    hdr = next(csv.reader(open(root / "venue_counts.csv")))
    p = write_csv(tmp_path / "vc.csv", hdr, [
        ["example-store-kapahulu", "", "lane_share", 1.4, "", "2026-10-01", "2026-10-31", "", "ev", ""],
        ["example-store-kapahulu", "", "register_transactions", 18450, "", "2026-10-01", "2026-10-31", "", "POS Oct", 12],
    ])
    a = import_template(conn, "venue_counts", p)
    b = import_template(conn, "venue_counts", p)
    assert a["rows_inserted"] == 1 and a["rows_rejected"] == 1
    assert b["rows_inserted"] == 0 and b["rows_unchanged"] == 1
    with conn.cursor() as cur:
        cur.execute("SELECT quality_flags, value_status FROM metric_observation WHERE metric_code='register_transactions'")
        flags, status = cur.fetchone()
        assert "small_sample" in flags and status == "observed"


def test_provider_file_rejects_person_level_data(conn, tmp_path):
    p = write_csv(tmp_path / "al.csv", ["email", "metric", "value", "period_start", "period_end"], [["a@b.c", "segment_size", 1, "2026-10-01", "2026-10-31"]])
    with pytest.raises(ValueError, match="person/device-level"):
        import_provider_file(conn, "audiencelab", p)


def test_provider_values_have_no_permitted_use_until_contract_review(conn, tmp_path):
    root = Path(__file__).resolve().parents[2] / "templates"
    import_template(conn, "venues", root / "venues.csv")
    p = write_csv(tmp_path / "placer.csv", ["venue_key", "venue_name", "metric", "value", "period_start", "period_end", "vendor_low", "vendor_high"],
                  [["example-store-kapahulu", "", "visits", 30500, "2026-10-01", "2026-10-31", 28000, 33000],
                   ["", "Totally Unknown Place", "visits", 10, "2026-10-01", "2026-10-31", "", ""]])
    out = import_provider_file(conn, "placer", p)
    assert out["rows_inserted"] == 1 and out["rows_rejected"] == 1
    with conn.cursor() as cur:
        cur.execute("SELECT value_status, allowed_uses, uncertainty->>'type' FROM metric_observation WHERE source_id='placer'")
        status, uses, unc = cur.fetchone()
        assert status == "vendor_modeled" and uses == [] and unc == "vendor-supplied interval"


def test_demo_loader_refuses_production(conn, monkeypatch):
    from ingest.demo import _guard
    monkeypatch.delenv("ALLOW_DEMO_DATA", raising=False)
    with pytest.raises(RuntimeError, match="ALLOW_DEMO_DATA"):
        _guard(conn)
    monkeypatch.setenv("ALLOW_DEMO_DATA", "1")
    _guard(conn)  # test DB name contains 'test' -> allowed
    prod = connect(os.environ["DATABASE_URL"])
    with pytest.raises(RuntimeError, match="name must contain"):
        _guard(prod)
    prod.close()


def test_lodes_radius_sum_matches_manual(conn, tmp_path):
    from ingest.connectors import lodes
    year = lodes.latest_year()
    wac = lodes.load_wac(year)
    hdr = next(csv.reader(open(Path(__file__).resolve().parents[2] / "templates" / "venues.csv")))
    p = write_csv(tmp_path / "v.csv", hdr, [["dt", "Downtown test", "other", "", "", "Honolulu", "", "", 21.3070, -157.8584, ""]])
    import_template(conn, "venues", p)
    lodes.enrich_venues(conn, year)
    expected = sum(wac[b.geoid]["C000"] for b, d in hg.blocks_within(21.3070, -157.8584, 800) if b.geoid in wac)
    with conn.cursor() as cur:
        cur.execute("SELECT value, value_status FROM metric_observation WHERE metric_code='workers_within_800m'")
        value, status = cur.fetchone()
    assert float(value) == expected and status == "observed" and expected > 1000
    again = lodes.enrich_venues(conn, year)
    assert again["rows_inserted"] == 0 and again["rows_unchanged"] == 3


class _FakeResp:
    def __init__(self, status, payload=None, location=""):
        self.status_code, self._p, self.headers = status, payload, {"location": location}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)

    def json(self):
        return self._p


def test_acs_missing_key_and_null_sentinels(monkeypatch):
    from ingest.connectors import acs

    class S:
        def get(self, *a, **k):
            return _FakeResp(302, location="https://api.census.gov/data/missing_key.html")
    with pytest.raises(acs.MissingKey):
        acs.fetch_tracts(2024, "bad", S())

    head = ["NAME"] + [f"{v}{s}" for v in acs.VARS for s in ("E", "M")] + ["state", "county", "tract"]
    row = ["Tract 1"] + ["1000", "120", "-666666666", "-222222222", "40.1", "2.0", "2.9", "0.1"] + ["15", "003", "000100"]

    class S2:
        def get(self, *a, **k):
            return _FakeResp(200, [head, row])
    out = acs.fetch_tracts(2024, "k", S2())
    assert out["15003000100"]["B01003_001"] == (1000.0, 120.0)
    assert out["15003000100"]["B19013_001"] == (None, None)  # Census sentinel -> unavailable, never a number
