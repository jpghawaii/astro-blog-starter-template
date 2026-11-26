"""Tests for market-context connectors and vehicle route exposure (run against TEST_DATABASE_URL)."""
from __future__ import annotations

import csv
import math
from pathlib import Path

import pytest

from ingest.adapters.gps import compute_route_exposure, import_gps
from ingest.connectors import market
from ingest.connectors.acs import share_with_moe
from ingest.tests.test_ingest import conn, write_csv  # noqa: F401  (fixture reuse)

ROOT = Path(__file__).resolve().parents[2]


def test_share_moe_uses_census_proportion_formula():
    p, moe = share_with_moe([(300.0, 40.0)], (1000.0, 50.0))
    assert p == pytest.approx(0.3)
    assert moe == pytest.approx(math.sqrt(40 ** 2 - 0.3 ** 2 * 50 ** 2) / 1000)
    # radicand negative -> use '+' form, per Census guidance
    p2, moe2 = share_with_moe([(900.0, 10.0)], (1000.0, 200.0))
    assert moe2 == pytest.approx(math.sqrt(10 ** 2 + 0.9 ** 2 * 200 ** 2) / 1000)
    # sum of two numerators: MOE combined as root of squares
    p3, _ = share_with_moe([(10.0, 5.0), (20.0, 6.0)], (100.0, 10.0))
    assert p3 == pytest.approx(0.3)
    assert share_with_moe([(None, None)], (100.0, 1.0)) == (None, None)  # missing -> unavailable, never 0
    assert share_with_moe([(1.0, 1.0)], (0.0, 1.0)) == (None, None)


@pytest.mark.skipif(not (ROOT / "data/cache/dbedt-visitors-2026-09.xlsx").exists(), reason="DBEDT workbook not cached")
def test_visitor_workbook_sections_do_not_bleed(conn):  # noqa: F811
    out = market.import_visitor_stats(conn, 2026, 9)
    assert out["rows_inserted"] == 36
    with conn.cursor() as cur:
        cur.execute("SELECT metric_code, value FROM metric_observation WHERE subject_id='island:Oahu'")
        vals = {k: float(v) if v is not None else None for k, v in cur.fetchall()}
        cur.execute("SELECT value_status FROM metric_observation WHERE subject_id='island:Lanai' AND metric_code='visitor_arrivals'")
        lanai_status = cur.fetchone()[0]
    # per-day spending must not be overwritten by the following PER TRIP section (~$1,620)
    assert 200 < vals["visitor_spend_per_person_day"] < 400
    assert vals["visitor_avg_daily_census"] == pytest.approx(vals["visitor_days"] / 30, rel=1e-6)
    assert lanai_status == "unavailable"  # 'N/A' in the source -> unavailable
    again = market.import_visitor_stats(conn, 2026, 9)
    assert again["rows_inserted"] == 0 and again["rows_updated"] == 0


def test_qcew_suppressed_cells_are_unavailable(conn, monkeypatch):  # noqa: F811
    header = "area_fips,own_code,industry_code,agglvl_code,size_code,year,qtr,disclosure_code,qtrly_estabs,month1_emplvl,month2_emplvl,month3_emplvl,total_qtrly_wages,taxable_qtrly_wages,qtrly_contributions,avg_wkly_wage"
    body = {"15003": [header, '"15003","5","1026","73","0","2026","1","",3000,70000,71000,72281,1,1,1,852',
                      '"15003","5","1011","73","0","2026","1","N",0,0,0,0,0,0,0,0'],
            "15001": [header], "15007": [header], "15009": [header]}
    monkeypatch.setattr(market, "_get", lambda url, *a, **k: "\n".join(body[url.rsplit("/", 1)[1][:5]]).encode())
    market.import_qcew(conn, 2026, 1)
    with conn.cursor() as cur:
        cur.execute("SELECT subject_id, value, value_status, quality_flags FROM metric_observation WHERE metric_code='industry_jobs' ORDER BY subject_id")
        rows = cur.fetchall()
    assert rows[0][0].endswith("1011") and rows[0][1] is None and rows[0][2] == "unavailable" and rows[0][3] == ["suppressed"]
    assert float(rows[1][1]) == 72281 and rows[1][2] == "observed"


def test_gps_route_exposure_snaps_and_drops_gaps(conn, tmp_path):  # noqa: F811
    from ingest.adapters.templates import import_template
    tdir = ROOT / "templates"
    v = write_csv(tmp_path / "v.csv", next(csv.reader(open(tdir / "venues.csv"))), [["fleet", "Fleet", "transit_fleet", "", "", "", "", "Oahu", "", "", ""]])
    a = write_csv(tmp_path / "a.csv", next(csv.reader(open(tdir / "assets.csv"))),
                  [["van-1", "fleet", "vehicle", "", "Van 1", "Mobile", "", "", "", "", "", "", "", "", 2, "operating", "", "false"]])
    import_template(conn, "venues", v)
    import_template(conn, "assets", a)
    with conn.cursor() as cur:  # one straight east-west test road at lat 21.30 (1 km), AADT 24,000
        cur.execute("""INSERT INTO road_segment (source_id, segment_key, route_name, island, aadt, geom)
                       VALUES ('hdot_hpms_2024','T:0-1','Test Rd','Oahu',24000, ST_GeogFromText('SRID=4326;MULTILINESTRING((-157.860 21.300,-157.850 21.300))'))""")
        cur.execute("SELECT id FROM asset WHERE asset_key='van-1'")
        aid = cur.fetchone()[0]
    conn.commit()
    rows = []
    for i in range(11):  # on the road, 30 s apart, ~95 m steps
        rows.append(["van-1", "V1", f"2026-10-06T08:{i // 2:02d}:{(i % 2) * 30:02d}-10:00", 21.3001, -157.860 + i * 0.00092])
    rows.append(["van-1", "V1", "2026-10-06T09:00:00-10:00", 21.3500, -157.800])   # 55-min gap -> dropped
    rows.append(["van-1", "V1", "2026-10-06T09:00:30-10:00", 21.3600, -157.790])   # off-network move -> unmatched
    rows.append(["van-1", "V1", "2026-10-06T09:01:00-10:00", 21.3600, -157.790])
    rows.append(["van-1", "V1", "2026-10-06T09:01:30-10:00", 40.0, -100.0])         # outside Hawaii -> rejected
    g = write_csv(tmp_path / "gps.csv", ["asset_key", "vehicle_id", "recorded_at", "lat", "lon"], rows)
    out = import_gps(conn, g)
    assert out["rows_inserted"] == 14 and out["rows_rejected"] == 1
    assert import_gps(conn, g)["rows_inserted"] == 0
    exp = compute_route_exposure(conn, aid, "2026-10-06", "2026-10-06")
    assert exp["moving_on_network_s"] == 300 and exp["segments"] == 1
    assert exp["unmatched_s"] == 30 and exp["parked_s"] == 30
    with conn.cursor() as cur:
        cur.execute("SELECT value, inputs->'segments'->0->>'aadt', (inputs->>'gap_seconds_dropped')::float FROM metric_observation WHERE metric_code='route_exposure'")
        val, aadt, dropped = cur.fetchone()
    assert float(val) == 300 and float(aadt) == 24000 and dropped > 3000
