# my-weight

A single-page personal weight tracker. The whole app is `index.html` —
no backend, no build step. Open the file (or serve it statically) and it runs.

## Concept

- User signs in with Google (OAuth via Google Identity Services).
- Records are stored as a single JSON file in the user's own Google Drive
  `appDataFolder`. The folder is hidden from the user's normal Drive UI and
  is scoped per-OAuth-client, so only this app can read or write it.
- The app developer cannot see user data — there is no server.
- Users can add records for any date (including years in the past),
  view a chart, and wipe everything with one click.

## File layout

- `index.html` — the entire app (markup + Tailwind CDN + inline JS).
- `CLAUDE.md` — this file.

## Tech / dependencies (all CDN, no install)

- Tailwind via `@tailwindcss/browser`.
- Google Identity Services (`accounts.google.com/gsi/client`) for sign-in.
- `gapi` client (`apis.google.com/js/api.js`) for Drive API calls.
- Chart.js 4 + `chartjs-adapter-date-fns` for the weight chart.

CSP allows `https://cdn.jsdelivr.net` for the above plus the Google
auth/api hosts. If you add another CDN package, it's already covered;
if you add another origin, update the CSP `<meta>`.

## Drive storage

- Scope: `https://www.googleapis.com/auth/drive.appdata` (app-data only,
  not full Drive access).
- File name: `weight_records.json` in `appDataFolder`.
- The file is found by listing with
  `q: name='weight_records.json' and 'appDataFolder' in parents`.
- After login, the entire file is loaded once into memory along with
  its `headRevisionId`. Subsequent saves do an explicit pre-flight
  metadata fetch (`drive.files.get` with `fields: 'headRevisionId'`)
  and compare against the cached revisionId — Drive API v3 silently
  ignores the standard `If-Match` HTTP header, so optimistic
  concurrency has to be done client-side.
- `uploadWithConflictRetry(applyIntent)` wraps `uploadRecords()`: if
  the remote revision differs (or the file is gone) it refetches the
  file, re-runs `applyIntent` on the fresh in-memory state, and
  retries (up to 3 times). `applyIntent` returns `false` to abort the
  retry when the user's change is no longer applicable on the new
  state (e.g. the edited record was deleted on another device, or the
  new datetime is now taken).
- After a successful PATCH/POST the response includes the new
  `headRevisionId` (we ask for it via `?fields=id,headRevisionId`)
  and the local `revisionId` is updated, so the next save can
  pre-flight against the freshest known revision.
- Race window between the pre-flight check and the PATCH is
  millisecond-scale and accepted as a known limit; for a single-user
  weight tracker it is small enough to ignore.

## Data file format — versioning and migration

This is the part most likely to bite a future change, so read carefully.

### Current schema (version 1)

```json
{
  "version": 1,
  "records": [
    { "datetime": "2026-05-02T07:14:00.000Z", "weight": 72.5 },
    { "datetime": "2026-05-03T07:31:00.000Z", "weight": 72.3, "note": "po běhu" }
  ],
  "settings": {
    "rangePreset": "30d"
  }
}
```

- `datetime` is **always UTC ISO 8601** (`new Date(...).toISOString()`).
  The `datetime-local` input value is converted to UTC at save time;
  display is converted back via `Intl.DateTimeFormat` at render time.
- `weight` is a number in kilograms.
- `note` is an **optional** non-empty string. Records without a note
  omit the key entirely (no empty string), so old records and new
  records-without-notes are byte-identical to the previous schema —
  no version bump or rewrite needed when the field was introduced.
- `settings` is an **optional** object holding cross-device app
  preferences (chart range preset, etc.). Adding new keys here is a
  forward-compatible change; readers ignore unknown keys, missing
  settings fall back to defaults. Currently:
  - `rangePreset` — one of `7d`, `30d`, `3m`, `6m`, `1y`, `all`.
  Saves are debounced (500 ms) on the device that changed the value
  and ride along with the regular records upload.
- Datetime is the unique key (matched at minute precision); a record's
  weight or note can change but two records can't share a minute.
- The schema version constant is `SCHEMA_VERSION` near the top of the
  inline `<script>`.

### Legacy shapes the app accepts on load

The `migrate(parsed)` function in `index.html` handles three cases:

1. **Bare array** (pre-versioning): `[{...}, {...}]` — wrapped in the
   v1 envelope.
2. **Versioned envelope with a different `version` field** — currently
   only v1 exists, so anything else triggers a rewrite. Add real
   migration logic when v2 ships.
3. **Per-record legacy `{date: "YYYY-MM-DD", weight}`** — converted to
   `{datetime, weight}` by treating the date as local **noon**
   (`new Date(date + "T12:00:00").toISOString()`). Noon was chosen so
   that timezone shifts can't push the moment onto an adjacent day.

Records that have neither a valid `datetime` nor a valid `date` are
**dropped** during migration, and dropping anything sets the
`migrated` flag.

### Rewrite-on-migration

When `migrate()` reports `migrated: true` and a file already exists,
`loadRecords()` rewrites the file once with the canonical v1 envelope
right after the first successful render. This keeps every subsequent
load on the fast path.

### Adding a new schema version

When you need to change the shape:

1. Bump `SCHEMA_VERSION` to `2`.
2. In `migrate()`, branch on `parsed.version`:
   - `1` → run a v1→v2 transform on `parsed.records`, set
     `migrated = true`.
   - `2` → use as-is.
3. Keep the v0 (bare-array) and per-record `{date, weight}` branches
   intact — old files in the wild may still be on disk.
4. The rewrite-on-load path will upgrade users transparently the first
   time they sign in after the change.

### Defensive rendering

Both `renderRecords()` and `renderChart()` filter out records whose
`datetime` doesn't parse, so a single bad row cannot crash the UI even
if migration somehow lets one slip through.

## Other implementation notes

- **In-memory cache** (`records`, `fileId`, `recordsLoaded`) is reset on
  logout. The wipe action also resets it locally and deletes the Drive
  file via `drive.files.delete`.
- **History list** is paginated (default 50, options 25/50/100/250/500,
  persisted in `localStorage` under `my-weight:pageSize`). Sorted
  newest-first; jumps back to page 1 after a save so the new entry is
  visible.
- **Chart** uses Chart.js's `time` scale. Default range is the last 1
  year. Quick-filter buttons set the range to 7d/30d/3m/6m/1y/all
  (`all` runs from the oldest record in memory). Manual `from`/`to`
  date inputs trigger a re-render. Point markers hide above 200 points
  to keep dense ranges readable.
- **Status line** under the form shows transient messages (`Načítám...`,
  `Ukládám...`, errors). The submit button is disabled while a save is
  in flight; the wipe button is also disabled during its own request.
- **Quota errors**: the Drive API reason `storageQuotaExceeded` is
  mapped to a friendly Czech message in `describeDriveError()`. Other
  errors fall through to the API message.

## Non-goals (deliberate)

- **Sharding / compression.** Even 30 years of daily records is well
  under 1 MB; the proportional fix when the file gets large is
  per-year sharding, not gzip. Not needed yet.
- **Offline mode.** Browser must be online to sync.
- **A backend.** The whole point is that the developer cannot see the
  data; introducing a server would defeat that.
- **Localization.** UI strings are Czech (`lang="cs"`). If you add
  another language, factor strings out first.

## Branch convention

Development happens on `claude/review-weight-tracker-app-doTLb` (and
similarly named feature branches). `main` is the deploy target.
