#!/usr/bin/env python3
"""Machine-translate occupation titles and activity names at build time.

Source: data/dist/dataset.json.gz (English). Endpoint order: MyMemory, then the
unofficial Google endpoint. No API key. Results are cached per source string in
data/cache/translations/<locale>.json, so reruns are cheap. Output:

  web/data/translations/<locale>.json   {occupations: {code: text}, activities: {id: text}}
  web/data/translations/manifest.json   endpoint, date, coverage, failures

Missing or failed strings are simply absent; the page falls back to English.
"""

import argparse
import gzip
import hashlib
import json
import os
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATASET = os.path.join(ROOT, "data", "dist", "dataset.json.gz")
OUT_DIR = os.path.join(ROOT, "web", "data", "translations")
CACHE_DIR = os.path.join(ROOT, "data", "cache", "translations")
LOCALES = ["it", "es", "fr", "zh", "ar", "hi"]
BATCH_CHARS = 420
DELAY = 0.15
TIMEOUT = 25
RETRIES = 3


def load_sources():
    with gzip.open(DATASET, "rt", encoding="utf-8") as handle:
        bundle = json.load(handle)
    return bundle


def cache_path(locale):
    return os.path.join(CACHE_DIR, locale + ".json")


def load_cache(locale):
    path = cache_path(locale)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    return {}


def save_cache(locale, cache):
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(cache_path(locale), "w", encoding="utf-8") as handle:
        json.dump(cache, handle, ensure_ascii=False, indent=0, sort_keys=True)
        handle.write("\n")


def key(text):
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:20]


def request_mymemory(texts, locale):
    joined = "\n".join(texts)
    url = (
        "https://api.mymemory.translated.net/get?q="
        + urllib.parse.quote(joined)
        + "&langpair="
        + urllib.parse.quote("en|" + locale)
    )
    request = urllib.request.Request(url, headers={"User-Agent": "escape-ai-job-finder/1.0"})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        payload = json.load(response)
    status = payload.get("responseStatus")
    if status != 200:
        raise RuntimeError(f"mymemory status {status}: {payload.get('responseDetails')}")
    translated = payload.get("responseData", {}).get("translatedText", "")
    lines = [line.strip() for line in translated.split("\n")]
    quota = bool(payload.get("quotaFinished"))
    if len(lines) != len(texts):
        raise RuntimeError(f"segment mismatch {len(lines)} != {len(texts)}")
    return lines, quota


def request_dict(texts, locale):
    joined = "\n".join(texts)
    url = (
        "https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl="
        + urllib.parse.quote(locale)
        + "&q="
        + urllib.parse.quote(joined)
    )
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        payload = json.load(response)
    if not isinstance(payload, list):
        raise RuntimeError("dict-chrome returned a non-array payload")
    translated = "".join(part for part in payload if isinstance(part, str))
    lines = [line.strip() for line in translated.split("\n")]
    if len(lines) != len(texts):
        raise RuntimeError(f"segment mismatch {len(lines)} != {len(texts)}")
    return lines, False


def request_google(texts, locale):
    joined = "\n".join(texts)
    url = (
        "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl="
        + urllib.parse.quote(locale)
        + "&dt=t&q="
        + urllib.parse.quote(joined)
    )
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        payload = json.load(response)
    pieces = [segment[0] for segment in payload[0] if segment and segment[0]]
    translated = "".join(pieces)
    lines = [line.strip() for line in translated.split("\n")]
    if len(lines) != len(texts):
        raise RuntimeError(f"segment mismatch {len(lines)} != {len(texts)}")
    return lines, False


def translate_batch(texts, locale, endpoint):
    last = None
    for attempt in range(RETRIES):
        try:
            if endpoint == "mymemory":
                return request_mymemory(texts, locale)
            if endpoint == "dict":
                return request_dict(texts, locale)
            return request_google(texts, locale)
        except Exception as error:  # noqa: BLE001
            last = error
            time.sleep(1.2 * (attempt + 1))
    raise RuntimeError(str(last))


def make_batches(items, limit_chars):
    batch, size = [], 0
    for item in items:
        extra = len(item[1]) + 1
        if batch and size + extra > limit_chars:
            yield batch
            batch, size = [], 0
        batch.append(item)
        size += extra
    if batch:
        yield batch


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--locale", action="append", help="limit to a locale")
    parser.add_argument("--limit-batches", type=int, default=0, help="smoke run")
    parser.add_argument("--endpoint", choices=["auto", "mymemory", "dict", "google"], default="auto")
    args = parser.parse_args()

    bundle = load_sources()
    locales = args.locale or LOCALES
    sources = {
        "occupations": {entry["c"]: entry["t"] for entry in bundle["occupations"]},
        "activities": {entry["i"]: entry["n"] for entry in bundle["dwas"]},
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    manifest_path = os.path.join(OUT_DIR, "manifest.json")
    manifest = {
        "endpoint": None,
        "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "ok",
        "locales": {},
    }
    endpoint = "mymemory" if args.endpoint == "auto" else args.endpoint
    batch_chars = 1800 if endpoint == "dict" else BATCH_CHARS
    quota_hit = False
    batches_done = 0

    for locale in locales:
        cache = load_cache(locale)
        pending = {
            group: [(ident, text) for ident, text in mapping.items() if key(text) not in cache]
            for group, mapping in sources.items()
        }
        failures = 0
        for group in ("occupations", "activities"):
            if quota_hit:
                break
            batches = list(make_batches(pending[group], batch_chars))
            if args.limit_batches:
                batches = batches[: args.limit_batches]
            for batch in batches:
                if quota_hit:
                    break
                texts = [text for _, text in batch]
                try:
                    lines, quota = translate_batch(texts, locale, endpoint)
                except Exception:
                    if endpoint == "mymemory" and args.endpoint == "auto":
                        endpoint = "dict"
                        try:
                            lines, quota = translate_batch(texts, locale, endpoint)
                        except Exception:
                            failures += len(texts)
                            continue
                    else:
                        failures += len(texts)
                        continue
                for (_, text), translated in zip(batch, lines):
                    if translated and translated != text:
                        cache[key(text)] = translated
                    elif translated:
                        cache[key(text)] = translated
                batches_done += 1
                if batches_done % 20 == 0:
                    save_cache(locale, cache)
                if quota:
                    quota_hit = True
                    manifest["status"] = "quota_exhausted"
                time.sleep(DELAY)
        save_cache(locale, cache)

    # Emit per-locale files from the cache and collect coverage.
    for locale in locales:
        cache = load_cache(locale)
        output = {"occupations": {}, "activities": {}}
        identical = 0
        empty = 0
        for group, mapping in sources.items():
            for ident, text in mapping.items():
                translated = cache.get(key(text))
                if not translated:
                    continue
                if not translated.strip():
                    empty += 1
                    continue
                if translated.strip() == text.strip():
                    identical += 1
                output[group][ident] = translated
        with open(os.path.join(OUT_DIR, locale + ".json"), "w", encoding="utf-8") as handle:
            json.dump(output, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
        manifest["locales"][locale] = {
            "occupations": len(output["occupations"]),
            "activities": len(output["activities"]),
            "identical": identical,
            "empty": empty,
            "failures": 0,
        }

    manifest["endpoint"] = endpoint
    manifest["batches"] = batches_done
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    total_occ = len(sources["occupations"])
    total_act = len(sources["activities"])
    for locale, counts in manifest["locales"].items():
        print(
            f"{locale}: occupations {counts['occupations']}/{total_occ}, "
            f"activities {counts['activities']}/{total_act}, identical {counts['identical']}"
        )
    print(f"endpoint {endpoint}, status {manifest['status']}, batches {batches_done}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
