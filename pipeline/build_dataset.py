#!/usr/bin/env python3
"""Build the static dataset shipped with the app.

Inputs, cached under data/raw:
  * O*NET 31.0 text database (db_31_0_text.zip)
  * OECD 2026 AI Capability Gap Index (xlsx)

Outputs:
  * data/dist/dataset.json.gz   compressed export of the whole bundle
  * data/dist/match_report.json join diagnostics for the OECD scores
  * web/data/dataset.js         the same bundle as a classic script

Run with --check to validate the existing outputs without rebuilding.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import os
import statistics
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone

import xlsx

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
DIST = os.path.join(ROOT, "data", "dist")
WEB_DATA = os.path.join(ROOT, "web", "data")

ONET_ZIP = os.path.join(RAW, "db_31_0_text.zip")
ONET_DIR = os.path.join(RAW, "db_31_0_text")
ONET_URL = "https://www.onetcenter.org/dl_files/database/db_31_0_text.zip"
OECD_XLSX = os.path.join(RAW, "OECD AI Capability Gap Index_public data.xlsx")
OECD_URL = (
    "https://aicapabilityindicators.oecd.org/assets/data/"
    "OECD%20AI%20Capability%20Gap%20Index_public%20data.xlsx"
)

DATASET_GZ = os.path.join(DIST, "dataset.json.gz")
DATASET_JS = os.path.join(WEB_DATA, "dataset.js")
MATCH_REPORT = os.path.join(DIST, "match_report.json")

SCHEMA_VERSION = 1


def download(url: str, target: str) -> None:
    if os.path.exists(target):
        return
    os.makedirs(os.path.dirname(target), exist_ok=True)
    print(f"download {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "escape-ai-job-finder/1.0"})
    with urllib.request.urlopen(request, timeout=300) as response, open(target, "wb") as handle:
        handle.write(response.read())


def ensure_sources() -> None:
    download(ONET_URL, ONET_ZIP)
    if not os.path.isdir(ONET_DIR):
        with zipfile.ZipFile(ONET_ZIP) as archive:
            archive.extractall(RAW)
    download(OECD_URL, OECD_XLSX)


def read_tsv(name: str) -> list[dict[str, str]]:
    path = os.path.join(ONET_DIR, name)
    with open(path, encoding="utf-8", errors="replace", newline="") as handle:
        return list(csv.DictReader(handle, delimiter="\t"))


def load_onet() -> dict:
    names = {
        row["Element ID"]: row["Element Name"] for row in read_tsv("Content Model Reference.txt")
    }
    catalog = {}
    for row in read_tsv("GWAs to IWAs to DWAs.txt"):
        catalog[row["DWA Element ID"]] = (row["GWA Element ID"], row["IWA Element ID"], row["DWA Element Name"])

    occupation_dwa: dict[str, set[str]] = {}
    for row in read_tsv("Tasks to DWAs.txt"):
        occupation_dwa.setdefault(row["O*NET-SOC Code"].strip(), set()).add(row["DWA Element ID"])

    occupations = {}
    for row in read_tsv("Occupation Data.txt"):
        occupations[row["O*NET-SOC Code"].strip()] = {
            "title": row["Title"].strip(),
            "description": " ".join(row["Description"].split()),
        }
    return {"names": names, "catalog": catalog, "occupation_dwa": occupation_dwa, "occupations": occupations}


def load_oecd() -> dict[str, dict]:
    rows = xlsx.read_sheet(OECD_XLSX, "Data")
    header = rows[2]
    columns = {name: index for index, name in enumerate(header)}
    required = ["OCC_Code", "OCC_Title", "AI Capability Gap Index_Rev. norm.", "AI Capability Gap Index_Total"]
    missing = [name for name in required if name not in columns]
    if missing:
        raise SystemExit(f"OECD sheet lost columns: {missing}")
    scores = {}
    for row in rows[4:]:
        if not row or not row[columns["OCC_Code"]]:
            continue
        code = str(row[columns["OCC_Code"]]).strip()
        gap = row[columns["AI Capability Gap Index_Total"]]
        exposure = row[columns["AI Capability Gap Index_Rev. norm."]]
        if not isinstance(gap, float) or not isinstance(exposure, float):
            continue
        scores[code] = {
            "title": str(row[columns["OCC_Title"]]).strip(),
            "gap": gap,
            "exposure": exposure,
        }
    return scores


def build() -> dict:
    onet = load_onet()
    oecd = load_oecd()

    joined = sorted(code for code in oecd if code in onet["occupation_dwa"] and code in onet["occupations"])
    missing_score = sorted(code for code in onet["occupations"] if code not in oecd)
    missing_links = sorted(code for code in oecd if code not in onet["occupation_dwa"])
    unknown_in_onet = sorted(code for code in oecd if code not in onet["occupations"])

    dwa_ids = sorted(
        {dwa for code in joined for dwa in onet["occupation_dwa"][code]},
        key=lambda element: tuple(int(part) if part.isdigit() else part for part in element.split(".")),
    )
    dwa_index = {dwa: index for index, dwa in enumerate(dwa_ids)}

    gwa_ids: list[str] = []
    iwa_ids: list[str] = []
    gwa_index: dict[str, int] = {}
    iwa_index: dict[str, int] = {}
    dwas = []
    for dwa in dwa_ids:
        gwa, iwa, label = onet["catalog"][dwa]
        if gwa not in gwa_index:
            gwa_index[gwa] = len(gwa_ids)
            gwa_ids.append(gwa)
        if iwa not in iwa_index:
            iwa_index[iwa] = len(iwa_ids)
            iwa_ids.append(iwa)
        dwas.append({"i": dwa, "n": label, "g": gwa_index[gwa], "w": iwa_index[iwa]})

    occupations = []
    for code in joined:
        info = onet["occupations"][code]
        score = oecd[code]
        occupations.append(
            {
                "c": code,
                "t": info["title"],
                "d": info["description"],
                "g": round(score["gap"], 4),
                "e": round(score["exposure"], 4),
                "dwa": sorted(dwa_index[dwa] for dwa in onet["occupation_dwa"][code]),
            }
        )

    counts = [len(entry["dwa"]) for entry in occupations]
    median = statistics.median(counts)
    histogram: dict[int, int] = {}
    for count in counts:
        histogram[str(count)] = histogram.get(str(count), 0) + 1

    bundle = {
        "meta": {
            "schema": SCHEMA_VERSION,
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "sources": {
                "onet": {
                    "release": "O*NET 31.0",
                    "url": ONET_URL,
                },
                "oecd": {
                    "title": "The OECD AI exposure measure",
                    "series": "OECD Artificial Intelligence Papers No. 59",
                    "doi": "10.1787/f3da0f0a-en",
                    "date": "2026-05-26",
                    "url": OECD_URL,
                },
            },
            "n_occupations": len(occupations),
            "n_dwas": len(dwas),
            "min_dwa_initial": int(-(-median // 2)),
            "dwa_per_occupation": {
                "min": min(counts),
                "median": median,
                "mean": round(sum(counts) / len(counts), 2),
                "max": max(counts),
                "histogram": dict(sorted(histogram.items(), key=lambda item: int(item[0]))),
            },
            "exposure": {
                "field": "e",
                "range": [0.0, 1.0],
                "direction": "higher is more exposed",
                "gap_field": "g",
                "gap_direction": "lower is more exposed",
            },
        },
        "gwas": [onet["names"].get(element, element) for element in gwa_ids],
        "iwas": [onet["names"].get(element, element) for element in iwa_ids],
        "dwas": dwas,
        "occupations": occupations,
    }

    report = {
        "generated": bundle["meta"]["generated"],
        "onet_occupations": len(onet["occupations"]),
        "oecd_occupations": len(oecd),
        "joined": len(joined),
        "oecd_without_onet_record": unknown_in_onet,
        "oecd_without_dwa_links": missing_links,
        "onet_without_oecd_score": missing_score,
    }
    return {"bundle": bundle, "report": report}


def write_outputs(bundle: dict, report: dict) -> None:
    os.makedirs(DIST, exist_ok=True)
    os.makedirs(WEB_DATA, exist_ok=True)
    payload = json.dumps(bundle, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0) as handle:
        handle.write(payload)
    with open(DATASET_GZ, "wb") as handle:
        handle.write(buffer.getvalue())
    with open(DATASET_JS, "w", encoding="utf-8") as handle:
        handle.write("/* generated by pipeline/build_dataset.py, do not edit */\n")
        handle.write("self.__AI_EXPOSURE_DATASET__ = ")
        handle.write(payload.decode("utf-8"))
        handle.write(";\n")
    with open(MATCH_REPORT, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
        handle.write("\n")
    print(
        f"wrote {DATASET_GZ} ({len(buffer.getvalue())} bytes), "
        f"{DATASET_JS} ({os.path.getsize(DATASET_JS)} bytes), {MATCH_REPORT}"
    )


def check() -> int:
    failures = []
    for path in (DATASET_GZ, DATASET_JS, MATCH_REPORT):
        if not os.path.exists(path):
            failures.append(f"missing {path}")
    if failures:
        print("\n".join(failures))
        return 1

    with gzip.open(DATASET_GZ, "rt", encoding="utf-8") as handle:
        bundle = json.load(handle)
    with open(MATCH_REPORT, encoding="utf-8") as handle:
        report = json.load(handle)

    occupations = bundle["occupations"]
    dwas = bundle["dwas"]
    counts = [len(entry["dwa"]) for entry in occupations]
    meta = bundle["meta"]
    print(f"occupations           {len(occupations)}")
    print(f"dwas                  {len(dwas)}")
    print(f"occupation x dwa      {len(occupations)} x {len(dwas)} = {len(occupations) * len(dwas)}")
    print(f"filled cells          {sum(counts)}")
    print(f"dwa per occupation    min {min(counts)} median {statistics.median(counts)} max {max(counts)}")
    print(f"initial minimum       {meta['min_dwa_initial']}")
    print(f"without oecd score    {len(report['onet_without_oecd_score'])}")
    print(f"joined oecd scores    {report['joined']}")

    if len(occupations) != report["joined"]:
        failures.append("occupation count does not match the join report")
    if meta["min_dwa_initial"] != int(-(-statistics.median(counts) // 2)):
        failures.append("initial minimum does not match the DWA median")
    if any(not entry["dwa"] for entry in occupations):
        failures.append("an occupation has no DWA")
    if any(dwa_index >= len(dwas) for entry in occupations for dwa_index in entry["dwa"]):
        failures.append("a DWA index is out of range")
    if any(not 0.0 <= entry["e"] <= 1.0 for entry in occupations):
        failures.append("an exposure value is outside 0 to 1")
    if not meta["dwa_per_occupation"]["histogram"]:
        failures.append("the DWA histogram is empty")

    for failure in failures:
        print(f"FAIL {failure}")
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate existing outputs")
    parser.add_argument("--offline", action="store_true", help="refuse to download missing sources")
    arguments = parser.parse_args()

    if arguments.check:
        return check()

    if arguments.offline:
        for path in (ONET_ZIP, OECD_XLSX):
            if not os.path.exists(path):
                raise SystemExit(f"missing source {path} and --offline was given")
    ensure_sources()
    built = build()
    write_outputs(built["bundle"], built["report"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
