#!/usr/bin/env python3
"""Write web/data/translations/<locale>.json and manifest.json from the cache."""
import gzip, json, os, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATASET = os.path.join(ROOT, "data", "dist", "dataset.json.gz")
OUT = os.path.join(ROOT, "web", "data", "translations")
CACHE = os.path.join(ROOT, "data", "cache", "translations")
LOCALES = ["it", "es", "fr", "zh", "ar", "hi"]


def main():
    with gzip.open(DATASET, "rt", encoding="utf-8") as handle:
        bundle = json.load(handle)
    sources = {
        "occupations": {entry["c"]: entry["t"] for entry in bundle["occupations"]},
        "activities": {entry["i"]: entry["n"] for entry in bundle["dwas"]},
    }
    os.makedirs(OUT, exist_ok=True)
    caches = {}
    for locale in LOCALES:
        path = os.path.join(CACHE, locale + ".json")
        caches[locale] = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    endpoints = {
        "it": "mymemory",
        "es": "mymemory",
        "fr": "mymemory+dict-chrome-ex",
        "zh": "dict-chrome-ex",
        "ar": "dict-chrome-ex",
        "hi": "dict-chrome-ex",
    }
    complete = all(len(caches[l]) >= 2963 for l in LOCALES)
    manifest = {"endpoint": "mixed", "endpoints": endpoints,
                "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "status": "ok" if complete else os.environ.get("TRANSLATION_STATUS", "partial"),
                "locales": {}}
    for locale in LOCALES:
        cache = caches[locale]
        output = {"occupations": {}, "activities": {}}
        identical = 0
        for group, mapping in sources.items():
            for ident, text in mapping.items():
                value = cache.get(__import__("hashlib").sha1(text.encode()).hexdigest()[:20])
                if not value or not value.strip():
                    continue
                if value.strip() == text.strip():
                    identical += 1
                output[group][ident] = value
        with open(os.path.join(OUT, locale + ".json"), "w", encoding="utf-8") as handle:
            json.dump(output, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
        manifest["locales"][locale] = {
            "occupations": len(output["occupations"]),
            "activities": len(output["activities"]),
            "identical": identical,
            "total": len(cache),
        }
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    for locale, counts in manifest["locales"].items():
        print(locale, counts)


if __name__ == "__main__":
    main()
