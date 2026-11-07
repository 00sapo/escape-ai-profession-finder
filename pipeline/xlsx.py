"""Minimal xlsx reader built on the standard library.

Only what this project needs: one worksheet at a time, shared strings,
inline strings, numbers and booleans. No formulas, no styling.
"""

from __future__ import annotations

import re
import zipfile
import xml.etree.ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_COL_RE = re.compile(r"^([A-Z]+)")


def _column_index(ref: str) -> int:
    """Return the zero based column index of an A1 style cell reference."""
    match = _COL_RE.match(ref)
    if match is None:
        raise ValueError(f"bad cell reference: {ref!r}")
    index = 0
    for char in match.group(1):
        index = index * 26 + (ord(char) - ord("A") + 1)
    return index - 1


def sheet_names(path: str) -> list[str]:
    with zipfile.ZipFile(path) as archive:
        root = ET.fromstring(archive.read("xl/workbook.xml"))
    return [sheet.get("name") for sheet in root.iter(f"{NS}sheet")]


def read_sheet(path: str, name: str) -> list[list[object]]:
    """Return every row of the named sheet as a list of values.

    Rows are dense: a missing cell becomes an empty string, so callers can
    index by position. Trailing empty cells are trimmed per row.
    """
    with zipfile.ZipFile(path) as archive:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {rel.get("Id"): rel.get("Target") for rel in rels}
        rel_key = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
        target = None
        for sheet in workbook.iter(f"{NS}sheet"):
            if sheet.get("name") == name:
                target = targets[sheet.get(rel_key)]
                break
        if target is None:
            raise KeyError(f"sheet {name!r} not in {path!r}")
        if not target.startswith("xl/"):
            target = "xl/" + target.lstrip("/")
        shared = _shared_strings(archive)
        rows: list[list[object]] = []
        for row in ET.fromstring(archive.read(target)).iter(f"{NS}row"):
            values: dict[int, object] = {}
            for cell in row.findall(f"{NS}c"):
                values[_column_index(cell.get("r"))] = _cell_value(cell, shared)
            width = max(values) + 1 if values else 0
            rows.append([values.get(i, "") for i in range(width)])
    return rows


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        raw = archive.read("xl/sharedStrings.xml")
    except KeyError:
        return []
    strings = []
    for item in ET.fromstring(raw).findall(f"{NS}si"):
        strings.append("".join(node.text or "" for node in item.iter(f"{NS}t")))
    return strings


def _cell_value(cell: ET.Element, shared: list[str]) -> object:
    kind = cell.get("t")
    if kind == "inlineStr":
        return "".join(node.text or "" for node in cell.iter(f"{NS}t"))
    value = cell.find(f"{NS}v")
    if value is None:
        return ""
    if kind == "s":
        return shared[int(value.text)]
    if kind in ("str", "e"):
        return value.text or ""
    try:
        return float(value.text)
    except (TypeError, ValueError):
        return value.text or ""
