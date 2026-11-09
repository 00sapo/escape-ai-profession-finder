# Escape AI - Profession Finder

## What it does

The site shows the OECD AI exposure of an occupation. You search for one or more
occupations. You select the activities that you perform. The site then asks you
to split the activities into frequency groups: more frequent, normal, and less
frequent. It repeats the split for each group until a group has four activities
or fewer. The order is deterministic and transitive. The site shows the OECD AI
Capability Gap of that profile. A low gap means low resilience and high
exposure. A high gap means high resilience.

The site runs in the browser. No data leaves your device.

The results URL stores the chosen occupations, the selected activities, the
inferred activity order, and the language. Open the URL to restore the state and
repeat the estimate. The Copy link button copies the URL.

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
translation check, the validation harness, the priority harness, the title
check, and the Playwright tests.

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

The model smooths each activity probability with a floor of 0.02. It ranks
occupations by a weighted geometric mean of the activity probabilities. It fits
the blend with exponentiated gradient ascent on the simplex. It then keeps the
smallest support that carries most of the weight. The order of the declared
activities supplies the evidence weights through the O*NET importance table.

The ranking blends a fuzzy title similarity with a weight of 0.3. The matcher
compares the chosen occupation titles with each occupation title. It folds case
and diacritics, drops common words, and matches tokens by character bigrams.
The blend also uses the title as a prior with strength 20. A title-dissimilar
occupation gets a negative linear term, so its weight falls and the gap estimate
changes. The prior does not hard-exclude occupations.

The model code is `web/js/model.js`. The technical notice at
`web/technical-notice.html` gives the equations, the constants, the validation
protocol, the held-out results, and the limitations.

## Validation

The validation harness samples activities from known occupations and compares
the estimate with the OECD score. It removes the true occupation from the
candidate pool and adds 2 or 3 random denied activities to each fit. It tunes on
547 occupations and reports on 332 held-out occupations. The thresholds are a
mean absolute error at most 0.05 and at least 65 percent of estimates within
0.05. The check uses the n = 20 bucket. The technical notice gives the results
and the limitations of the protocol.

## Privacy

The page loads local files only. It stores nothing and sends nothing. The CSV
export is a local file.

## Language

This document aims to follow ASD-STE100. No tool guarantees STE compliance.
The official dictionary is free at https://www.asd-ste100.org/.
