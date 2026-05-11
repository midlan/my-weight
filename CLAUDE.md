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
  edit / delete individual entries, view a chart, import data from
  another my-weight account or from kaloricketabulky.cz, export their
  data as JSON, and wipe everything (typed-confirmation).

## File layout

- `public/` — everything that ships to the static host. Whatever
  lands in this directory is what Cloudflare Pages serves; drop
  a new file here and the next deploy picks it up automatically.
  - `public/index.html` — the entire app (markup + Tailwind CDN
    + inline JS).
  - `public/privacy.html` — standalone privacy policy page
    served at the same origin. Referenced from Google's OAuth
    consent screen and fetched lazily into an in-app modal so
    the SPA isn't navigated away. The content block is marked
    with `id="privacy-content"` for the loader to extract;
    everything else (Tailwind shell, back link) is page-only
    chrome.
- `.github/workflows/deploy-cloudflare-pages.yml` — GitHub
  Actions workflow that runs `wrangler pages deploy public` on
  every push to `main`. Requires repo secrets
  `CLOUDFLARE_API_TOKEN` (with Pages › Edit) and
  `CLOUDFLARE_ACCOUNT_ID`.
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
- File **content** downloads (`alt=media`) go through gapi
  (`gapi.client.drive.files.get({fileId, alt:'media'})`). The body
  comes back base64-wrapped — `content.googleapis.com` applies a
  content-sniffing safety wrapper exposed via
  `x-goog-safety-encoding: base64` — but the size penalty is in
  the microsecond range for our file sizes. Sticking to the
  Google-provided helpers keeps the call site auth/upgrade-friendly;
  rewriting it as a direct `fetch()` to `www.googleapis.com`
  produced no measurable speedup in testing and forfeits gapi's
  built-in auth handling. Metadata calls (list, headRevisionId-only,
  delete) also stay on gapi for the same reasons.

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
  - `theme` — `light` or `dark`. Absent (system mode) when the
    user lets the OS preference decide; explicitly stored only
    when the user picks one in the menu so a fresh device with a
    different system preference doesn't inherit a stale override.
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

- **In-memory cache** (`records`, `settings`, `fileId`, `revisionId`,
  `recordsLoaded`) is reset on logout. The wipe action also resets it
  locally and deletes the Drive file via `drive.files.delete`.
- **Sections** (`#loading-section`, `#auth-section`, `#app-section`)
  are mutually-exclusive panes inside the card. `showSection(name)`
  toggles them via inline `style.display` instead of a `.hidden`
  class so a `display: flex` (used for the min-h centering trick)
  doesn't override hide. Both loading and auth sections share
  `min-h-36` so the card stays the same height across the
  loading→auth handover; eliminates a card-resize blink.
- **Hamburger menu** (`#menu-overlay`) covers theme selection
  (system / světlý / tmavý), import / export, the privacy policy
  link, logout, and wipe. The menu button itself is only revealed
  when `showSection('app')` runs. Logout / wipe close the menu
  first so the underlying section transition is visible.
- **Dark mode**: a `<style type="text/tailwindcss">` block declares
  `@custom-variant dark (&:where(.dark, .dark *))`, so the `dark:`
  Tailwind variant fires when `<html>` carries the `dark` class
  (not on the default `prefers-color-scheme` media query). A small
  inline script in `<head>` sets the class synchronously from the
  OS preference before first paint to avoid a flash; `applyTheme()`
  in the main script overrides this once `settings.theme` is
  loaded. The menu's theme selector writes the chosen value to
  `settings.theme` (or removes the key when the user picks
  "Systém") and `scheduleSettingsSave()` syncs both `rangePreset`
  and `theme` to Drive in one upload. The chart's tick / grid /
  title colors are set programmatically per theme (Chart.js draws
  on canvas — `dark:` classes don't reach it). `applyTheme()`
  triggers a chart re-render so the canvas restyles immediately.
- **Privacy modal** (`#privacy-overlay`) is a separate fixed-position
  overlay (z-50, body-scroll-locked while open) that lazy-loads the
  `privacy-content` element from `privacy.html` via `fetch()` on
  first open and caches the parsed DOM children. Loading uses the
  same loading-section spinner during the fetch so first-open
  doesn't blink. Subsequent opens are instant from the cache. The
  consent line under the login button and the menu button both
  trigger the same `openPrivacy()` flow.
- **History list** is paginated (default 10; options
  10/25/50/100/250/500). The page-size selector and prev/next
  controls sit *above* the list. Sorted newest-first; jumps back
  to page 1 after a save. **Page size is not persisted** — every
  page load starts at 10. The list itself uses normal block flow
  (no inner `overflow-auto`) so the page scrolls naturally.
- **Chart** uses Chart.js's `time` scale. Default for new users is
  `7d`; the last preset is persisted via `settings.rangePreset`
  (synced through Drive, so devices stay in sync). Quick-filter
  buttons set the range to 7d/30d/3m/6m/1y/all (`all` runs from
  the oldest record in memory). The active preset button is
  highlighted. Manual `from`/`to` date inputs trigger a re-render
  and clear the highlighted preset (the manual range is local-only,
  not synced). Tick labels and tooltip dates use
  `Intl.DateTimeFormat(undefined, ...)` for the user's browser
  locale. Point markers hide above 200 points; chart animation is
  disabled to avoid tweening on each save.
- **Auth flow**: `attemptAutoLogin()` only triggers a silent token
  request when `localStorage` has a prior token record (even if
  expired) — first-visit / fresh-incognito users skip silent and
  see the login button immediately, avoiding the popup-blocked
  warning that browsers throw on auto-fired popups without a user
  gesture. A token-client `error_callback` plus an 8-second timeout
  bail to the auth screen if the silent request hangs.
- **Silent re-auth on 401 (mid-session)**: Drive primitives
  (`findAppDataFile`, `fetchFromDrive`, `fetchContentByFileId`,
  `readRemoteRevision`, `uploadRecords`, `wipeAllData`'s delete) are
  wrapped in `withReauth()`. On a 401 the helper calls
  `attemptSilentReauth()` (a promise-wrapped
  `requestAccessToken({prompt:'none'})` with the same 8s timeout)
  and retries the failed call once. Distinct from `attemptAutoLogin`:
  this path only refreshes the access token and never calls
  `onSignIn()`, so the in-flight save/load resumes seamlessly. The
  token-client `callback`/`error_callback` branch on a
  `pendingSilentReauth` state object to route the response back to
  the awaiting promise. If silent re-auth itself fails, the original
  401 bubbles up and each user-action catch block calls
  `handleFatal401()` — clears the token, shows auth section, alerts
  "Přihlášení vypršelo". Silent re-auth uses an iframe to
  `accounts.google.com`; with third-party cookies blocked it will
  typically fail and the user falls back to the explicit login
  button (which opens a popup).
- **New-record form**: a "teď" button is shown by default; clicking
  it swaps in a `datetime-local` input. On touch devices
  (`matchMedia('(pointer: coarse)')`) the input also fires
  `showPicker()` so the picker opens with a single tap. Saving in
  "teď" mode stamps `new Date().toISOString()` at submit time;
  saving in custom mode keeps the entered datetime in the input
  after success so adding back-dated days in a row is one
  date-bump per save. The submit button shows `Ukládám...` inline
  during the upload (no layout shift). Form blocks submission
  while a row is in edit mode.
- **Edit / delete in the history**: each row has icon buttons
  (edit, trash). Edit toggles the row to a flex-col layout with
  inputs for [datetime, weight] on top and a full-width
  `<textarea>` for the note below; cancel button restores. Delete
  shows an in-row spinner replacing the trash icon while the
  upload runs. Both actions fall through `uploadWithConflictRetry`
  so concurrent edits on another device are preserved.
- **Import / export** (in the menu): export downloads the current
  Drive payload as `my-weight-YYYY-MM-DD.json`. Import auto-detects
  the format — native (versioned envelope or bare-array legacy)
  passes through `migrate()`; kaloricketabulky.cz exports are
  recognized via `parsed.data.values` (each item is
  `{from: epoch_ms, value: kg}`); only `values` is read, the
  `target` array (goal weight) is ignored. Duplicates at minute
  precision are skipped; the user confirms the count. A "?" button
  next to "Importovat data" pops a `prompt()` with copy-able
  instructions including the kaloricketabulky URL pre-filled with
  today's date.
- **Errors and progress**: errors are surfaced via `alert()` (no
  status-line layout shift); transient progress messages reuse the
  loading-section spinner where appropriate (`Mažu data...`,
  `Importuji...`, `Načítám zásady...`). Edit-row save failures keep
  the row in edit mode and restore the typed values into the
  inputs so the user can retry without re-typing.
- **Optimistic concurrency**: saves go through
  `uploadWithConflictRetry(applyIntent)`. Each save function passes
  an `applyIntent` callback that mutates `records`/`settings`
  deterministically. On conflict the helper refetches and replays
  the callback against the fresh state. `applyIntent` returns
  `false` to abort retry when the change is no longer applicable
  (e.g. `saveEdit`'s record was deleted on another device, or
  `saveRecord`'s datetime is now taken). Conflict outcomes per
  action are mapped to specific Czech alerts.
- **Quota errors**: the Drive API reason `storageQuotaExceeded` is
  mapped to a friendly Czech message in `describeDriveError()`.
  Other errors fall through to the API message.

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

Two long-lived branches the deploy workflow watches:

- `main` → production. Cloudflare Pages serves it at
  `www.mojevaha.cz` and at `my-weight.pages.dev`.
- `dev` → staging. Cloudflare Pages serves it at
  `dev.mojevaha.cz` (custom domain attached to this branch
  alias in the Pages dashboard).

Any other branch can also be deployed manually via the workflow's
`workflow_dispatch` trigger — Cloudflare creates a per-branch URL
of the form `<branch>.my-weight.pages.dev` for ad-hoc tests.

For small, low-risk edits in this single-author project, commit
straight to `main`. For anything that needs eyeballs before users
see it, push to `dev` first, verify at `dev.mojevaha.cz`, then
merge `dev` → `main`. Feature branches + PRs are optional and
worthwhile for larger shape-changing work or when collaborating.
