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
  - `public/manifest.webmanifest` — PWA manifest. Linked from
    `index.html`; declares the app name, `display: standalone`,
    theme/background colors, and the icon set. Lets mobile users
    "Add to Home Screen" and get a launcher icon that opens
    without browser chrome. The icon `src` carries a literal
    `__ICON_HASH__` placeholder in the source manifest; the
    deploy workflow substitutes it with the first 8 hex chars of
    `hashFiles('public/icon.svg', '.github/workflows/deploy-cloudflare-pages.yml')`
    — same inputs as the icons-cache key — and the post-deploy
    smoke test fails if the placeholder survives. The query
    string only changes when the icon source or its build pipeline
    changes, so unrelated commits don't churn the WebAPK install
    snapshot; when it does change, Chrome re-fetches the icon
    because the URL string is now different from the cached one.
  - `public/sw.js` — minimal service worker. Registered from
    `window.onload`; its only job is to exist so Chrome's
    install prompt criterion is satisfied. No caching, no
    fetch interception (offline mode is a non-goal).
  - Build metadata: an inline `<script>` early in `<head>` sets
    `window.__BUILD = { sha, date }`. Source HTML carries literal
    placeholders `__BUILD_SHA__` / `__BUILD_DATE__`; the deploy
    workflow rewrites them with `git rev-parse --short HEAD` and the
    current UTC ISO timestamp via `perl -i -pe`, dying if either
    placeholder doesn't appear exactly once. Local serves from the
    source tree keep the placeholders, and `showAbout()` detects
    that by `startsWith('__')` and labels them "dev (lokální
    sestavení)" instead. The About dialog (menu → "O aplikaci")
    is a plain Czech `alert()` with schema version, build SHA,
    release date, record count, and the repo URL.
  - PWA install UX (in `public/index.html`): the
    `beforeinstallprompt` event is captured into
    `deferredInstallPrompt`, which powers the "Nainstalovat
    aplikaci" menu button (hidden until the event fires) and
    a one-time first-login `confirm()` prompt. The localStorage
    key `my-weight:install-prompted` stores the ISO timestamp
    of when we last asked (or when the app got installed via
    the `appinstalled` event), so a future change could
    re-prompt after some interval without needing a migration.
    iOS Safari never fires `beforeinstallprompt`, so the
    button stays hidden on iOS and users install via Share →
    Add to Home Screen.
  - `public/privacy.html` — standalone privacy policy page
    served at the same origin. Referenced from Google's OAuth
    consent screen and fetched lazily into an in-app modal so
    the SPA isn't navigated away. The content block is marked
    with `id="privacy-content"` for the loader to extract;
    everything else (Tailwind shell, back link) is page-only
    chrome.
  - `public/404.html` — Cloudflare Pages' custom not-found page.
    Same Tailwind shell as privacy.html, Czech "stránka nenalezena"
    copy, link back to `/`. Without this file Pages used to fall
    back to serving index.html (200 OK) for any unmatched path,
    so typos like `/foo` looked like the app loaded successfully.
    The post-deploy smoke test fetches a random unknown path and
    asserts the response is 404 — catches the day Cloudflare ever
    re-enables SPA fallback on the project.
- `.github/workflows/deploy-cloudflare-pages.yml` — GitHub
  Actions workflow that runs `wrangler pages deploy public` on
  every push to `main`. Requires repo secrets
  `CLOUDFLARE_API_TOKEN` (with Pages › Edit) and
  `CLOUDFLARE_ACCOUNT_ID`. Also generates the icon asset set
  (`favicon.ico`, `icon-192.png`, `icon-512.png`,
  `apple-touch-icon.png`, `icon-maskable.svg`) from
  `public/icon.svg` before deploy; the step is cached on the
  hash of `icon.svg` plus the workflow file, so it re-runs when
  the source SVG or the generation logic changes. All generated
  files are gitignored.

  Two roles for the generated assets:
  - **HTML head / iOS / browser tab** — `favicon.ico`,
    `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` are
    rasterized directly from `icon.svg` (no padding, edge-to-edge).
    They feed the `<link rel="icon">` tags and the iOS
    apple-touch-icon. Safari ignores manifest icons for PWA
    install on iOS, so apple-touch-icon is what lands there.
  - **PWA manifest** ships two SVG entries only — no PNG entries
    in the manifest:
    - `icon.svg` itself with `purpose: "any"` — edge-to-edge,
      for splash and any other surface that doesn't apply a mask.
    - `icon-maskable.svg` with `purpose: "maskable"` — the same
      icon with viewBox extended to `-156 -156 824 824` (156 px
      of margin per side, inscribing the rounded square + its
      circumscribed circle of radius 176√2 + 80 ≈ 328.9 inside
      Android's 80%-diameter maskable safe circle) AND an opaque
      white rect filling that extended viewBox. The opaque white
      fill is intentional even though the W3C spec says the UA
      "MUST composite transparent maskable pixels onto a solid
      fill" for us: on-device testing on Samsung One UI + Chrome
      showed the transparent safe-zone padding being actively
      stripped at WebAPK install time, contradicting the spec but
      shipping anyway, leaving the icon back at its edge-to-edge
      bbox and the launcher clipping its rounded corners.
      Pre-compositing onto opaque white in CI sidesteps the bug
      (no transparency for Chrome to strip), and the spec's
      "user agent's choice" composite color (not normative,
      varies between Chromium pipelines — observed as both white
      and black) doesn't enter the picture. On the launcher the
      OS mask carves its preferred shape out of the white-filled
      canvas with the green rounded rect in its center — same
      look as Messenger / Chrome / Gmail.
- `functions/_middleware.js` — Cloudflare Pages edge middleware
  that runs before static assets are served. Today's only job is
  301-redirecting the bare CF Pages aliases (`my-weight.pages.dev`,
  `dev.my-weight.pages.dev`) to the custom domains so the app has
  one canonical origin (matters for OAuth, SEO, link sharing).
  Per-deployment preview URLs (`<hash>.my-weight.pages.dev`) are
  intentionally not redirected — those are the URLs the deploy
  workflow's smoke step hits. Wrangler picks up `functions/`
  automatically when `pages deploy public` runs from the repo
  root (which the workflow's deploy step does).
- `tests/` — automated test infra (npm-scoped to this dir so the
  rest of the project stays toolchain-free). Every spec navigates
  to `public/.test-built.html` (gitignored) — a pre-inlined copy
  of `index.html` produced by `fixtures.js` at module load via
  `scripts/inline-svg.mjs`. One source URL = one merged coverage
  entry, and logo tests exercise the same SVG-inlined shape the
  deploy pipeline ships.
  - `tests/fixtures.js` — shared `test` / `expect` / `PAGE_URL`
    exports. Builds the `.test-built.html` snapshot once per
    worker and wraps Playwright's `test` to start V8 coverage
    around each test and feed the result into monocart-reporter.
  - `tests/migrate.spec.js` — pure-function tests for `migrate()`
    and `toMinuteKey()` (legacy schema branches, future-version
    reload guard, etc.).
  - `tests/records.spec.js` — record-CRUD logic exercised through
    `page.evaluate` against top-level functions. No mocked Drive
    needed; operates on the in-memory `records` object.
  - `tests/helpers.spec.js` — pure helpers (`formatDateTime`,
    `recordsAsList`, etc.) plus locale-driven formatting (Playwright
    is pinned to `cs-CZ` in config).
  - `tests/logo.spec.js` — `displayLogoWeight` / `updateLogoFromLatest`
    via the inlined SVG that's present at script-load.
  - `tests/auth.spec.js` — mocked Google Identity + Drive harness.
    `MOCK_INIT` (an `addInitScript`) stubs `window.google`,
    `window.gapi`, and the upload-path `fetch` so the inline app
    script talks to an in-memory store. Knobs on `window.__mock`
    (`tokenIsValid`, `silentReauthSucceeds`, `forceNextGetError`,
    `forceNextFetchError`, `forceNextDeleteError`,
    `forceNextFetchDelay`) and a `calls[]` log let tests force
    401 / silent-reauth / quota / 404 / latency scenarios and
    assert what was called. Real Google hosts are aborted via
    `context.route` so nothing escapes.
  - `tests/a11y.spec.js` — `@axe-core/playwright` WCAG 2.0 / 2.1 AA
    scan against auth section, app section (with mock records), and
    menu overlay. Drives each state directly via top-level functions
    (`showSection`, `renderRecords`) instead of going through auth,
    so axe scans a deterministic DOM. Chromium-only (a11y violations
    are DOM-content checks; cross-browser would be duplicate work).
  - `tests/smoke.spec.js` — post-deploy boot check against the live
    deployed URL. Opens `SMOKE_URL` in a real headless browser,
    waits for `#auth-section` to appear (so gapi + gis loaded, the
    inline script ran without throwing, and `showSection('auth')`
    fired), and asserts no console errors. Catches deploy regressions
    the offline unit suite can't: CSP changes blocking inline scripts,
    moved or renamed CDN deps, GIS / gapi API surface changes,
    Tailwind classes missing from the built CSS. Skipped when
    `SMOKE_URL` is unset so local default runs stay quiet.
  - `tests/playwright.config.js`, `tests/package.json`,
    `tests/package-lock.json` — Playwright runner config and pinned
    deps. `tests/node_modules` is gitignored. The config defines two
    suite × three browser projects: `unit-{chromium,webkit,firefox}`
    runs the mocked Drive / GIS suite against the local
    `.test-built.html` (smoke ignored), `smoke-{chromium,webkit,firefox}`
    runs only `smoke.spec.js`. The deploy workflow targets each step's
    project subset explicitly so pre-deploy doesn't try to reach
    `SMOKE_URL` and post-deploy doesn't re-run the offline suite.
    Cross-browser matters because iOS users only get Webkit, and each
    engine has its own Intl / localStorage / popup quirks. V8 coverage
    in `fixtures.js` is chromium-gated (`page.coverage` is a chromium-
    only API), so coverage numbers reflect chromium runs.
  - `tests/coverage-reports/` (gitignored) — `monocart-reporter`
    output: `coverage/index.html` (browseable per-file line/branch
    report), `coverage/lcov.info`, `coverage/coverage-summary.json`,
    `report.html`, `report.json`. CI uploads this directory as an
    artifact on every workflow run (`coverage-report-<run_id>`,
    14-day retention) so users without a local dev env can read
    coverage straight from the Actions run page.
  - `tests/auth-manual.md` — manual OAuth / popup / 3p-cookies
    checklist that's firmly outside automated-test scope.
- `scripts/inline-svg.mjs` — single implementation of the
  `<img data-inline-svg>` → inlined-SVG substitution, used as a CLI
  by the deploy workflow and imported as an ES module by
  `tests/fixtures.js`. Exact-one match required; non-zero exit if
  the marker doesn't appear exactly once.
- `CLAUDE.md` — this file.

## Tech / dependencies

- Tailwind v4 — **compiled in CI** (not the browser runtime). Source
  is `src/tailwind.css`; the CI workflow downloads the standalone
  `tailwindcss-linux-x64` binary from the tailwindlabs/tailwindcss
  GitHub releases and runs it to emit a minified
  `public/tailwind.css` before the Cloudflare Pages deploy. The
  standalone binary is used (vs. the npm CLI) because it bundles the
  Tailwind engine — the npm CLI relies on a `node_modules/tailwindcss/`
  walkable from the source CSS to satisfy `@import "tailwindcss";`,
  which requires either a `package.json` + `npm install` in the repo
  or a similar setup. The standalone binary needs none of that. Both HTML files link it via `<link rel="stylesheet"
  href="tailwind.css" />`. The generated file is gitignored — only
  `src/tailwind.css` is the source of truth. The browser-runtime
  build (`@tailwindcss/browser@4`) was replaced because it caused
  a flash of unstyled content on hard reload (the runtime scans the
  DOM and injects styles only after parse). Custom-variant declarations
  (`@custom-variant dark`) and the small custom-CSS block
  (cursor / number-input spinner suppression) live in
  `src/tailwind.css`. Auto-content detection scans `public/**/*.html`
  via an explicit `@source` directive in the source file.
- Google Identity Services (`accounts.google.com/gsi/client`) for sign-in.
- `gapi` client (`apis.google.com/js/api.js`) for Drive API calls.
- Chart.js 4 + `chartjs-adapter-date-fns` for the weight chart, via
  `cdn.jsdelivr.net`.

CSP lives in `public/_headers` as a real HTTP response header that
Cloudflare Pages emits on every response (the file used to live as a
`<meta http-equiv>` in `public/index.html`, but Lighthouse flagged
meta-tag CSPs as weaker — a meta CSP only applies after the parser
reaches the tag). The same file ships HSTS (`Strict-Transport-Security:
max-age=31536000`). CSP allows `https://cdn.jsdelivr.net` (Chart.js)
plus the Google auth/api hosts. Tailwind no longer needs jsdelivr at
runtime, but the CSP entry stays because Chart.js still loads from
there. If you add another origin, update `public/_headers` (and
re-deploy — Cloudflare Pages only re-reads the file at deploy time).
The post-deploy smoke test asserts both headers are actually present
on the deployed root, so a `_headers` typo (Cloudflare silently
ignores malformed lines) fails the build instead of slipping into
prod unnoticed.

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

### Current schema (version 2)

```json
{
  "version": 2,
  "records": {
    "2026-05-02T07:14:00.000Z": { "weight": 72.5 },
    "2026-05-03T07:31:00.000Z": { "weight": 72.3, "note": "po běhu" }
  },
  "settings": {
    "rangePreset": "30d"
  }
}
```

- `records` is an **object keyed by the record's UTC datetime** —
  always a minute-precision ISO 8601 string
  (`YYYY-MM-DDTHH:MM:00.000Z`). The key is the *only* place the
  datetime lives in the data; the value object never repeats it.
  Storing the datetime as the key gives a structural uniqueness
  guarantee: two records *cannot* share a minute, even if a future
  bug forgets the app-layer duplicate check.
- The `datetime-local` input value is converted to UTC at save time
  and rounded to minute precision via `toMinuteKey()`; display is
  converted back via `Intl.DateTimeFormat` at render time.
- `weight` is a number in kilograms.
- `note` is an **optional** non-empty string. Records without a note
  omit the key entirely (no empty string).
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
- The schema version constant is `SCHEMA_VERSION` near the top of the
  inline `<script>`.

### In-memory shape vs. iteration

The in-memory `records` variable is exactly the v2 object — code
operates on it directly (`records[key]`, `delete records[key]`,
etc.). For anything that needs sorted iteration (chart render,
history list, finding the newest record, etc.), a `recordsAsList()`
helper materializes the object into an array of records with the
datetime hoisted back into each entry, sorted ascending. The output
is transient (rebuilt every call), so don't rely on object identity
across renders — `expandedNotes` is therefore a `Set` of keys, not a
WeakSet of record objects.

Edit/delete UI state tracks records by key, not by array index:
`editingKey` and `deletingKey` (empty string == no row). Row DOM
nodes carry `data-key` so query selectors can locate them after
re-renders.

### Legacy shapes the app accepts on load

The `migrate(parsed)` function in `index.html` handles four cases:

1. **v2 envelope** (`{version: 2, records: {<key>: {...}}, ...}`) —
   fast path, no rewrite.
2. **v1 envelope** (`{version: 1, records: [{datetime, weight, note?}]}`)
   — array converted to object; `migrated = true` triggers rewrite.
3. **Bare array** (pre-versioning): `[{...}, {...}]` — same conversion
   as v1, `migrated = true`.
4. **Per-record legacy `{date: "YYYY-MM-DD", weight}`** — converted to
   minute-precision keyed records by treating the date as local **noon**
   (`new Date(date + "T12:00:00").toISOString()`). Noon was chosen so
   that timezone shifts can't push the moment onto an adjacent day.

Records that have neither a valid `datetime` (or key) nor a valid
`date` are **dropped** during migration, and dropping anything sets
the `migrated` flag. When a v1/v0/legacy record's normalized key
collides with another (e.g. two same-minute entries that v1 somehow
let through), the last write wins and `migrated` is set.

### Rewrite-on-migration

When `migrate()` reports `migrated: true` and a file already exists,
`loadRecords()` rewrites the file once with the canonical v2 envelope
right after the first successful render. This keeps every subsequent
load on the fast path.

### Unreadable-data recovery flow

If `migrate()` ends up with **zero extracted records** despite the
input looking like it carried data (`inputHadContent` true — non-empty
array, non-empty records object, or any other non-null parsed value
that isn't an empty `{}`), it returns `unrecognized: true` and
suppresses the `migrated` flag so `loadRecords()` won't silently
overwrite the file. The load handler instead surfaces a `confirm()`:

- **OK** → download the raw bytes as `my-weight-YYYY-MM-DD.json`
  (so the user has a copy to inspect) and overwrite the Drive file
  with an empty v2 envelope. App continues with an empty list.
- **Cancel** → stay on the loading section with a Czech "reload
  after manual repair" message; no Drive write happens, so the
  broken file is preserved for diagnosis.

The conflict-refetch path (`fetchContentByFileId` called from inside
`uploadWithConflictRetry`) intentionally *doesn't* trigger this
prompt — interrupting an in-flight save with a recovery dialog
would be jarring, and a save is about to overwrite the file anyway.

### Future-version reload guard

`migrate()` also defends against the *opposite* direction — JS that's
older than the on-disk schema. If `parsed.version > SCHEMA_VERSION`
(e.g. a stale tab or a CDN-cached bundle reading a file that a newer
deploy already upgraded), it calls `location.reload()` once to pick
up fresh JS. The `sessionStorage` key
`my-weight:reloaded-for-newer-schema` guards against an infinite loop
when the server itself is serving older code (intentional rollback,
or a deploy gone wrong): the second time we encounter a future
version without the loop-breaking key being clearable, we throw with
a user-visible Czech message instead of reloading again.

The error thrown to halt processing before the reload navigation
lands carries `err.isReloadPending = true`; every Drive-call catch
checks this flag and `return`s silently so the user doesn't see a
"Chyba při ukládání" alert flash for a page that's about to unload.

The import path passes `migrate(parsed, { source: 'import' })`,
which disables the reload behavior — a user-initiated import of a
newer-format file should fail with an alert, not unexpectedly
refresh the page.

### Adding a new schema version

When you need to change the shape:

1. Bump `SCHEMA_VERSION` to `3`.
2. In `migrate()`, add a branch that recognizes v3 input as-is and
   v2 input as needing conversion. Keep the v1, v0 (bare-array), and
   per-record `{date, weight}` branches intact — old files in the
   wild may still be on disk.
3. The rewrite-on-load path will upgrade users transparently the first
   time they sign in after the change.

### Defensive rendering

Both `renderRecords()` and `renderChart()` filter out records whose
`datetime` doesn't parse, so a single bad row cannot crash the UI even
if migration somehow lets one slip through.

## Header logo (7-segment LCD)

The header logo is a scale icon with a 4-position 7-segment LCD
display. JS toggles the `.on` class on individual segment elements
to show the latest weight value. Layout / segment encoding lives in
`scale-icon-docs.md` (at repo root); a standalone playground
(`demo.html`, also at root) lets you eyeball segment combos. Both
the favicon and the playground load the static `public/icon.svg`
(it paints "72.5" via `.default-on` classes).

The SVG is **a single source of truth** — `public/icon.svg`. In
`public/index.html` it is referenced as a normal `<img>` with a
`data-inline-svg` marker attribute:

```html
<img src="icon.svg" alt="" data-inline-svg />
```

`id="logo"`, `class="w-12 h-12"`, and `aria-hidden="true"` are
baked into the SVG root element (favicon use ignores them). The
CI workflow has a single Perl one-liner that slurps both files,
substitutes every `<img data-inline-svg>` for the contents of
`icon.svg`, accumulates the substitution count, and dies if the
count isn't exactly 1. Exactly-one is a deliberate guardrail —
an accidental second occurrence (e.g. example markup in prose)
fails the build instead of silently rewriting the wrong place.

The repo's `public/index.html` stays clean — only the CI working
copy gets the inline expansion. Because of the count-check
guardrail, avoid writing literal `<img ... data-inline-svg ...>`
text in comments or docs; refer to the marker as
"`data-inline-svg`" alongside a bare `<img>` instead.

Key pieces in `public/index.html`:

- A `LOGO_AVAILABLE` flag is set once at script load by querying
  `#logo .seg-1-a`. When the inliner ran in CI the selector
  resolves; when it didn't (e.g. the page is served from a working
  copy without running the inliner), `#logo` is still an `<img>` and
  the selector returns null — every `setLogo*`, `displayLogoWeight`,
  and `updateLogoFromLatest` short-circuits. A `console.warn` makes
  the disabled state obvious.
- Initial paint uses `.default-on` classes baked into the SVG to
  render "72.5" before JS runs. When `LOGO_AVAILABLE` is true the
  script synchronously strips all `.default-on` classes and calls
  `displayLogoWeight(72.5)` to hand control over to JS — same
  segments, just driven by `.on` instead, so no visible transition.
- The SVG's internal `<style>` scopes `.seg` / `.dp` / `.on` selectors
  with `#logo` so they can't collide with anything else on the page.
- `displayLogoWeight(w)` clamps to `[0, LOGO_MAX]` (currently 199.9)
  and writes the four digits via `setLogoDigit` / `setLogoDecimal`.
  Values ≥ 100 use all three integer positions plus one decimal;
  values < 100 leave position 0 (and, when applicable, position 1)
  blank.
- `updateLogoFromLatest()` finds the newest valid record by datetime
  and calls `displayLogoWeight(newest.weight)`; with zero records
  it falls back to 72.5.
- The hook runs once at the top of `renderChart()` so every action
  that re-renders the chart (load / save / edit / delete / wipe /
  import / theme change) keeps the logo in sync. `renderChart()`'s
  early `Chart === 'undefined'` bailout sits *below* the logo
  update so a Chart.js load failure doesn't freeze the logo.
- The logout handler doesn't re-render the chart (chart is
  destroyed), so it calls `updateLogoFromLatest()` directly to
  drop the display back to the 72.5 default.

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
- **Developer email** (`__DEVELOPER_EMAIL__`) is kept out of the public
  git repo and substituted at deploy time from the `DEVELOPER_EMAIL`
  GitHub Actions secret. The placeholder appears in two files,
  exactly twice each (href + visible text): `public/index.html`
  (a hidden `<a id="dev-email-src">` near the bottom of `<body>`)
  and `public/privacy.html` (the `<a id="dev-email-link">` on the
  contact line). The workflow's "Inject developer email" step
  perl-substitutes both and dies if the per-file count isn't 2;
  post-deploy smoke greps both served pages for the surviving
  placeholder.

  Cloudflare's Email Address Obfuscation (Scrape Shield) rewrites
  the deployed `mailto:` + visible email into a `__cf_email__`
  anchor with a `data-cfemail` hex blob (single-byte XOR with the
  key prepended) and auto-injects `email-decode.min.js`, which
  decodes them back on `DOMContentLoaded`. The standalone
  `privacy.html` direct visit gets the decoder for free because
  it's a full HTML response; the modal-fetch path doesn't, because
  the decoder only scans the document once on initial load — it
  ignores DOM nodes inserted via `fetch()` + `DOMParser`.
  `loadPrivacyContent()` bridges that by reading the
  Cloudflare-decoded `textContent` of `#dev-email-src` (which
  *did* get decoded on the main page load) and writing it into
  `#dev-email-link` in the grafted modal content. The check
  `decodedEmail.startsWith('__')` skips the patch when the
  placeholder hasn't been substituted (local serves), so dev
  mode still works without the secret — the modal will just
  show `__DEVELOPER_EMAIL__` literally, which is fine for testing.
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
