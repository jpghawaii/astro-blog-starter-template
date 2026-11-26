# Measurement methodology (v1)

This document is the reference for every audience, delivery and outcome figure the platform produces.
Code: `lib/measurement/*` (models), `lib/inventory/occupancy.ts`, `lib/outcomes.ts`, `lib/reconcile.ts`.
Tests with hand-computed expectations: `tests/*.test.ts`.

> These are JPG Media's documented internal models. They are **not audited or accredited** by Geopath,
> the MRC or any other industry body, and no figure should be presented as such.

## 1. The measurement ladder

Each rung is a different quantity. They are never substituted for each other.

| # | Quantity | What it is | Typical source | Status label |
|---|----------|-----------|----------------|--------------|
| 1 | **Venue visits** | People entering the venue in a period (a person visiting twice counts twice) | Door counts, register/fueling transactions, licensed visitation data (Placer.ai, Azira) | observed / vendor-modeled |
| 2 | **Opportunity to see (OTS) visits** | Visits whose path passes through the asset's viewing zone | visits × `p_in_view_zone` | internal model |
| 3 | **Ad contacts** | Times a person is in the zone while *this* ad is displayed (digital) or while at the face (static) | Format models below | internal model |
| 4 | **Estimated impressions** | Contacts × a notice/attention factor | Only when a notice factor is supplied | internal model |
| 5 | **Unique reach** | De-duplicated people with an OTS across a set of venues | Licensed overlap data only | vendor-modeled / unavailable |
| 6 | **Frequency** | Gross contacts ÷ unique reach | Requires 5 | internal model / unavailable |
| 7 | **Verified ad plays** | Proof-of-play rows from the CMS | CMS export | observed |
| 8 | **Observed conversions** | QR scans, UTM visits, leads, purchases, coupon redemptions recorded in a system | QR tracker, GA4, POS | observed |
| 9 | **Attributed conversions** | Observed events credited to a campaign by a declared rule (tag + window) | Campaign definition | internal rule |
| 10 | **Incremental lift** | Causal effect versus a control | Declared experiment / quasi-experiment only | internal model / unavailable |

**Venue traffic is never reported as ad impressions.** Area context (jobs nearby, road AADT, resident ACS
statistics) is never reported as venue traffic.

## 2. Value statuses

Every stored number (`metric_observation`) carries one of:

* `observed` — a count from a system or published dataset (LODES jobs, HPMS AADT, proof-of-play).
* `vendor_modeled` — a provider's estimate (Placer.ai visits, DBEDT/STR occupancy, ACS estimates with MOE).
* `internally_modeled` — produced by our formulas.
* `assumed` — a planning value from the assumptions register, always with low/base/high and rationale.
* `unavailable` — no supporting data. Stored/displayed as *unavailable*, **never 0**.

Each observation also stores: source id and record reference, observation period, import run and
timestamp, geographic scope and unit, formula/version, upstream inputs, sample size, uncertainty (only
vendor- or publisher-supplied, e.g. Census MOE — never invented), allowed reporting uses, and quality
flags (`stale`, `small_sample`, `duplicate`, `boundary_mismatch`, `extrapolated`).

## 3. Format models

All models return low / base / high by evaluating the formula with every uncertain input at its low,
base and high value. Models are monotone in every input, so this brackets the result **for the stated
input ranges**. These are sensitivity bounds, **not statistical confidence intervals**.

### 3.1 Digital screens (C-store, hotel lobby, mall food court)

```
arrival_rate      = venue_visits / operating_seconds
plays             = verified_plays                                 (proof-of-play, preferred)
                  | operating_seconds / loop_length × ad_spots_per_loop × uptime_share   (scheduled; flagged)
audience_per_play = arrival_rate × (dwell_seconds + spot_length_seconds) × p_in_view_zone
ad_contacts       = plays × audience_per_play
est_impressions   = ad_contacts × p_notice          (only when p_notice is supplied)
```

Rationale: by Little's law, a person is in the zone at some moment during a play if they arrive within
`dwell + spot` seconds before the play ends. A visitor whose dwell spans several loops sees several plays;
that is within-visit frequency, which is why contacts are not people.

If visits are known but loop length or operating hours are not (common for real JPG screens today), the
platform reports **OTS visits** (`visits × p_in_view_zone`) and lists the missing inputs. OTS visits from
several screens in the same venue are **not additive** (`sumContacts` refuses them).

Hotel lobby visits, when no door count exists, are derived:
`rooms (venue-published) × occupancy (DBEDT monthly, region) × guests_per_occupied_room × lobby_passes_per_guest_day × days`.
Occupancy published by DBEDT is STR-derived and region-level, not the specific hotel.

### 3.2 Pump toppers
`contacts = fueling_transactions × (positions_covered / fueling_positions) × viewers_per_transaction [× p_notice]`
Assumes transactions spread evenly across positions (flagged).

### 3.3 Grocery checkout (counters, dividers, end caps)
`contacts = register_transactions × lane_share × shoppers_per_transaction [× p_notice]`

### 3.4 Walls, pillars, banners
`contacts = pedestrians_passing × p_visible_pedestrian + vehicles_passing × vehicle_occupancy × p_visible_vehicle [× p_notice]`
Road AADT (HDOT HPMS) is used for `vehicles_passing` **only after a site survey confirms the face is
visible from that road** (`faces_road = true`). The nearest HPMS segment is chosen by true point-to-line
distance; all segments within 60 m are kept for the analyst.

### 3.5 Vehicles / vans
`contacts = Σ_segments (seconds_on_segment / 3600) × (vehicles_per_hour × occupancy + pedestrians_per_hour) × p_visible [× p_notice]`
Requires timestamped GPS routes. Without them the estimate is **unavailable**.

### 3.6 Double counting guard
Inputs declare what they already include (`alreadyAdjustedFor`). Applying a factor already included
(e.g. a view-zone share on a vendor "exposed audience") makes the estimate unavailable with an explanation.

## 4. Reach and frequency
Gross contacts are additive across assets. People are not. Unique reach is produced only from licensed
overlap/unique-visitor data covering **exactly** the selected venues and period; otherwise both reach and
frequency are `unavailable`. With vendor reach, frequency ranges pair low contacts with high reach (and vice
versa).

## 5. Inventory, capacity and occupancy
* Venue → asset (physical face or screen) → capacity period (sellable units) → bookings → plays.
* Units: `spot_slot` (sellable advertiser slots in a digital loop) or `face_period` (one advertiser per
  static face at a time). Units are never mixed.
* `occupancy = Σ min(booked, capacity) unit-days / Σ capacity unit-days` over the date range; holds reported
  separately; overbooking flagged and capped. No capacity defined → occupancy unavailable (not 0 %).
* Invoices are never used for occupancy or delivery.

## 6. Outcomes and attribution
* **Observed**: campaign-tagged events from flight start to flight end + attribution window.
* Totals across systems only via a shared dedup key (hashed order id, coupon+transaction); purchases and
  coupon redemptions are combined only through that key.
* **Attributed**: credited by tag + window per the campaign's declared matching method; does not prove causation.
* **Incremental lift**: difference-in-differences on per-unit-per-day rates, only for campaigns declaring
  `geo_holdout`, `matched_market` or `randomized_venue` with control data. Fewer than 10 units → no
  significance claimed. `none` / `pre_post_only` → lift unavailable.

## 7. Licensing and client output
A derived figure inherits the most restrictive permission of all its inputs; unknown (`NULL`) = not
permitted. Client-facing reports (the default) withhold such figures and say so; the internal version lists
what was withheld and why.

## 8. Assumptions register (current values)
See the Methodology page or `model_assumption`. All current assumptions are JPG planning values —
**not measured** — and are marked “not yet reviewed”. Replace them with observations as they become
available (camera counts, CMS logs, venue POS data, site surveys).

## 9. Revenue reconciliation
Invoice lines are classified (`media`, `production`, `tax`, `discount`, `fee`) from the QuickBooks account
and item; only `media` is compared with booked value. Revenue is an accounting fact, not delivery evidence.
