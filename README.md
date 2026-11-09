# Escape AI - Profession Finder

## What it does

The site shows how AI affects an occupation. You search for one or more
occupations. You select the activities that you perform. You set their order.
The site shows the OECD AI Capability Gap of that profile. A low gap means low
resilience and high exposure. A high gap means high resilience.

The site runs in the browser. No data leaves your device.

## Run the site

Open `web/index.html` in a browser. The site works from the file system. It
sends no network request.

To serve it over HTTP, run:

```sh
node tests/server.js
```

Then open `http://127.0.0.1:4173/index.html`.

## Rebuild the data

```sh
python3 pipeline/build_dataset.py
```

The script writes these files:

- `data/dist/dataset.json.gz`
- `data/dist/match_report.json`
- `web/data/dataset.js`

Check the files without a rebuild:

```sh
python3 pipeline/build_dataset.py --check
```

The machine translations live in `web/data/translations`. Rebuild them with:

```sh
python3 tools/translate_data.py
```

The script uses a cache in `data/cache`. It needs network access only when the
cache misses a string.

## Verify

```sh
npm install
npm run verify
```

The command runs the data check, the tuning check, the i18n check, the
translation check, the validation harness, the priority harness, and the
Playwright tests.

## Sources

- O*NET 31.0: https://www.onetcenter.org/
- OECD AI Capability Gap Index, 2026:
  https://aicapabilityindicators.oecd.org/
- Paper: https://doi.org/10.1787/f3da0f0a-en

## Model

The model represents the declared activities as a weighted blend of O*NET
occupations. The weights are not negative and their sum is one. Undeclared
activities count as missing data, and the result is the weighted mean of the
OECD gaps.

## Privacy

The page loads local files only. It stores nothing and sends nothing. The CSV
export is a local file.

## Language

This document aims to follow ASD-STE100. No tool guarantees STE compliance.
The official dictionary is free at https://www.asd-ste100.org/.
