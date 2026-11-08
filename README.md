# Escape AI - Profession Finder

Escape AI - Profession Finder starts from one or more O*NET occupations,
turns their combined activities into an ordered personal profile, and estimates
the OECD 2026 AI Capability Gap of that profile.

## What it shows

- A fuzzy occupation search over 879 O*NET titles, with a score per row, a
  twenty row cap and the total count.
- A selected occupation list with a remove button for each choice.
- One ordered activity list built from the union of the chosen occupations.
  Checkboxes turn activities off, and up and down buttons, drag and drop or a
  typed rank reorder the rest. The order is the priority.
- An info button on every activity row, with the GWA and IWA names, the
  occupations that contain the activity and their OECD gap values.
- The estimated OECD AI Capability Gap as the headline number, with the
  direction legend and the uncertainty.
- A histogram of all 879 occupations over 100 equal gap bins, with the current
  bin marked, the axis gap values, the least and most resilient occupations and
  the direction labels.
- The representative occupations that make up the profile, with their weights.
- A full ranking of 879 occupations by similarity, with a red to green gap band
  and filters on minimum gap (resilience) and minimum similarity.
- A CSV export of the filtered ranking.

The page states that a lower AI Capability Gap value means less resilience,
so more exposure. The OECD measures the distance between what an occupation
requires and what AI can do today. A small distance means high exposure.

## Run the page

Open `web/index.html` in a browser. The page works from the file system, with
no server and no network request.

To serve it over HTTP instead, run `node tests/server.js` and open
`http://127.0.0.1:4173/index.html`.

## Rebuild the data

```sh
python3 pipeline/build_dataset.py
```

The page ships the dataset only. There is no model file and no model build
step.

The script downloads two sources into `data/raw` and writes three files.
It needs only the Python standard library.

| Output | Purpose |
|--------|---------|
| `data/dist/dataset.json.gz` | Compressed export of the whole bundle |
| `data/dist/match_report.json` | Join diagnostics for the OECD scores |
| `web/data/dataset.js` | The same bundle as a classic script for the page |

Check the existing outputs without a rebuild:

```sh
python3 pipeline/build_dataset.py --check
```

## Verify everything

```sh
npm install
npm run verify
```

The command runs four checks in order.

1. `npm run check:data` validates the dataset bundle.
2. `npm run check:tuning` compares the constants in the page with the validation report.
3. `npm run validate` runs the validation harness.
4. `npm run test:ui` runs the Playwright checks at four viewport sizes.

## How the estimate works

The user declares activities. Every activity the user does not declare counts
as missing data, not as an absent activity.

The occupation flow builds one ordered activity list from the chosen occupations. The order is the priority.

The model treats the declared profile as a convex combination of occupations.
The weights are non-negative and sum to one. The solver uses exponentiated
gradient ascent on the simplex, then keeps the smallest support that carries
most of the mass. The code lives in `web/js/model.js` and runs unchanged in the
page and in the validation harness.

Frequency weights the evidence. Every declared activity enters the likelihood
with its O*NET frequency as a multiplicative strength, so a daily task counts
more than a task done once a year. The weighted entry point is
`fitBlendWeighted`; `fitBlend` keeps its original signature and delegates to
it, and both accept the optional `frequency` map. Missing or invalid
frequencies fall back to a weight of one, which reproduces the unweighted
model.

The frequency rows also carry the user's priority order. Position is the
priority, not a number: the top activity is the most important one. The
up and down buttons or a typed rank as well as dragging reorder the list. The
model receives the activities in that order. The order only breaks ties, and on
an equal score the occupation matching more of the higher-priority activities
ranks first.

The similarity of an occupation is the smoothed likelihood of the declared
evidence under that single occupation. The headline is the estimated OECD AI
Capability Gap of the blend. The uncertainty is the standard
deviation of 24 bootstrap refits over the declared activities, with each
resampled activity carrying its frequency weight.

The suggestion loop stops when at least ten activities are declared and the
blend moves less than 0.041 in total variation for two consecutive answers.
The validation harness derives both numbers.


## Fuzzy occupation search

The only entry is the occupation search. It matches the 879 O*NET titles with a
small, dependency-free function in `web/js/fuzzy.js`: text is lowercased and
diacritics are stripped, then each title is scored. An exact substring beats a
prefix match, which beats all query tokens being present, which beats a
subsequence match, which beats a token edit distance of at most 2. Ties go to
the title, then to the catalogue index. The list is capped at 20 rows with the
total count, the score is shown per row, and an empty query shows the first 20
titles alphabetically. Nothing is loaded asynchronously and no model ships with
the page.

## The exposure scale

The page ranks occupations by the reversed normalised gap index, from 0 to 1.
A higher value means more exposure.

The raw total gap index runs the other way, so a lower value means more
exposure. The two scales are linear in each other:

```text
reversed = 1 - total / 22.94
```

A mean absolute error of 0.05 on the reversed scale equals 1.15 on the raw
total gap index.

## Data

| Source | Content | Used |
|--------|---------|------|
| O*NET 31.0 text database | 1016 occupations, 2084 detailed work activities, 17712 occupation-activity links | Activities and occupation descriptions |
| OECD AI Capability Gap Index, 2026 | 879 occupations with the total gap index, the reversed index and nine domain gaps | Exposure scores |

All 879 OECD occupations match an O*NET-SOC code and have activities. The 137
O*NET occupations without an OECD score are reported and excluded, because the
page cannot rank them by exposure.

The median occupation has 20 activities. The page sets the first minimum to
`ceil(20 / 2)`, which is 10.

### Activity details

`data/raw/db_31_0_text/Content Model Reference.txt` has an `Element ID`,
`Element Name` and `Description` column, and it does list the 2087 DWA element
ids (`4.A.x.y.z`). Every DWA row in O*NET 31.0 has `n/a` in the `Description`
column, so O*NET publishes no longer description for a detailed work activity.
The bundle therefore ships no `desc` field, and the activity details panel
shows the GWA name, the IWA name, the activity name, and the sentence that
O*NET gives no longer description. Below it the panel lists up to 20
occupations that contain the activity, with their OECD gap value, most exposed
first and ties broken by title, followed by the total count. The panel never
invents text.

## Validation

The harness splits the 879 occupations by a stable hash of the code. It tunes
the blend on 547 occupations and reports the final numbers on 332 held-out
occupations. It samples activities from each known occupation and compares the
estimate with the true score.

Held-out results, no noise:

| Activities | Mean absolute error | True occupation in top 10 |
|-----------:|--------------------:|--------------------------:|
| 4 | 0.0060 | 0.985 |
| 10 | 0.0003 | 0.997 |
| 20 | 0.0006 | 0.994 |

Held-out results with 15 percent foreign activities:

| Activities | Mean absolute error | True occupation in top 10 |
|-----------:|--------------------:|--------------------------:|
| 10 | 0.0104 | 0.994 |
| 20 | 0.0041 | 0.994 |

The thresholds are a mean absolute error at or below 0.05 and a top-10 rate at
or above 0.70. The harness writes `data/dist/validation_report.json` and exits
non-zero when a threshold is missed.

## Languages

The interface is in Italian, English, Spanish, French, Chinese, Arabic and
Hindi. A select in the top bar changes the language. The page reads the browser
language on the first load and keeps the choice in the URL hash, so a reload
keeps it. The page stores nothing else. Arabic switches the page direction to
right to left.

Occupation titles and activity names are machine translated at build time for
Italian, Spanish, French, Chinese, Arabic and Hindi. Italian and Spanish were
translated with the free MyMemory endpoint. MyMemory then hit its daily quota,
so French, Chinese, Arabic and Hindi were completed with the
`dict-chrome-ex` Google endpoint. The manifest records the endpoint per locale,
and every string is cached under `data/cache/translations`. The English O*NET
text is the reference: every missing translation falls back to it, and the
interface shows the English original as a secondary line where a translation is
present.

The translation tables live in `web/data/translations/<locale>.json`, with
provenance and coverage in `web/data/translations/manifest.json`. They are
merged into the bundle as optional `tr` fields by `pipeline/build_dataset.py`.
`npm run check:translations` fails on empty values, a locale missing from the
manifest, or more than 20 percent of a locale's strings being identical to the
English source, and prints coverage per locale.

The build step is:

```sh
python3 tools/translate_data.py
python3 pipeline/build_dataset.py --offline
```

To add a language, add one table to `web/js/i18n.js`, one entry to the
`SUPPORTED` list, and one option to the select in `web/index.html`. The layout
does not change.

## Privacy and offline use

- The page loads local scripts only, with the data inside one of them.
- The questionnaire makes no network request.
- The page stores nothing and sends nothing.
- The CSV export is created in the browser from a local blob.

The Playwright suite opens the page from `file://` and fails when any HTTP
request appears.

## Limits

- The score describes potential exposure. It does not predict job loss.
- The activity names are the original O*NET text in English.
- The blending model is the first version. A better model is a later task.
- The page covers the United States O*NET classification only.

## Layout

```text
pipeline/build_dataset.py   offline data build, standard library only
pipeline/xlsx.py            minimal xlsx reader
web/index.html              page markup
web/css/style.css           mobile-first styles
web/js/model.js             blending, similarity, uncertainty, priority
web/js/fuzzy.js             fuzzy occupation search
web/js/i18n.js              interface translations and number formats
web/js/app.js               questionnaire, results, CSV export
web/data/dataset.js         generated payload
validation/run_validation.js  tuning and held-out harness
validation/check_tuning.js    constant drift guard
tests/ui.spec.js            Playwright checks
```
