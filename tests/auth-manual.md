# Manual auth + session tests

Manual checklist for the OAuth + Drive auth flow under realistic browser
conditions. Run through this after any change to:

- `attemptAutoLogin`, `attemptSilentReauth`, `withReauth`, `handleFatal401`
- the `tokenClient.callback` / `error_callback` branches
- any Drive primitive (`uploadRecords`, `fetchFromDrive`, `findAppDataFile`,
  `fetchContentByFileId`, `readRemoteRevision`, `wipeAllData`'s delete)

No automated test framework here — this is a single-page app driven from a
real browser. Walk the scenarios below.

## The three auth paths

1. **Page-load silent (`attemptAutoLogin`)** — only fires when localStorage
   already contains a token record. Uses an iframe to `accounts.google.com`;
   needs third-party cookies to succeed.
2. **Explicit login button** — popup window. Needs popups allowed for the
   site.
3. **Mid-session 401 recovery (`attemptSilentReauth`)** — fires when a
   Drive call returns 401 inside `withReauth`. Iframe-based; needs
   third-party cookies. Falls through to `handleFatal401` on failure.

## Setting up browser conditions

### Third-party cookies

**Chrome:**

- `chrome://settings/cookies` → "Block third-party cookies" /
  "Allow all cookies".
- Or: incognito + the "Block third-party cookies in Incognito" toggle.

**Firefox:**

- Settings → Privacy & Security → Enhanced Tracking Protection.
- "Strict" blocks 3p cookies broadly; "Standard" allows most.

### Popups

**Chrome:**

- `chrome://settings/content/popups` → add the site to Block or Allow.
- Or: visit the site, trigger a popup, click the address-bar
  blocked-popup icon to allow.

### Forcing token expiry without waiting an hour

Google access tokens are 1 hour. Quick ways to simulate expiry:

- **Page-load path**: DevTools → Application → Local Storage →
  `https://mojevaha.cz` → edit `my-weight:token`, set `expiresAt` to `0`.
  Reload. `loadStoredToken()` returns null; app falls through to silent
  re-auth.
- **Real mid-session 401**: in another tab, open
  https://myaccount.google.com/permissions, find "Moje váha", revoke
  access. Back in the app, do a save — next Drive call returns 401.
  (Note: silent reauth will also fail in this case, because consent is
  gone — good for testing the fatal-401 fallback, not the recovery
  happy path.)
- **Single transient 401 (Chrome only)**: DevTools → Network → right-
  click a `googleapis.com` request → "Override content" / "Override
  response headers", return 401. Lets you exercise the silent-recovery
  path cleanly without revoking consent.

## Scenarios

### S1. First-ever visit (no localStorage)

**Setup:** Fresh incognito or `localStorage.clear()`. Reload.

**Expected:**

- Loading spinner briefly visible.
- Auth section appears.
- No popup, no console warning about blocked popups.
- 3p-cookies / popup-blocker settings irrelevant — silent is skipped.

### S2. Returning visit with valid cached token

**Setup:** Sign in successfully. Refresh within ~1 hour.

**Expected:**

- Loading spinner.
- App section appears, records render.
- No popup, no silent iframe.

### S3. Returning visit, expired cached token, 3p cookies allowed

**Setup:**

- Sign in once. Edit localStorage `expiresAt` to `0`. Reload.
- 3p cookies allowed.

**Expected:**

- Loading spinner.
- Silent iframe to `accounts.google.com` fires invisibly.
- Records load, app section appears.
- No popup, no user interaction. `my-weight:token` in localStorage is
  refreshed with a new `expiresAt` ~1h in the future.

### S4. Returning visit, expired cached token, 3p cookies blocked

**Setup:** Same as S3 but 3p cookies blocked.

**Expected:**

- Loading spinner.
- Silent attempt either errors quickly (via `error_callback`) or times
  out after 8 s.
- Auth section appears.
- Console: `Silent token request timed out (likely a blocked popup)` for
  the timeout case, or `Token client error` for an immediate failure.
- Clicking "Přihlásit se" (with popups allowed) opens a popup → consent
  → records load.

### S5. Explicit login, popups allowed

**Setup:** Auth section visible. Click "Přihlásit se".

**Expected:**

- Google consent popup opens (account chooser or consent screen
  depending on prior grants).
- Pick account → popup closes.
- Records load, app section appears.
- localStorage now contains `my-weight:token`.

### S6. Explicit login, popups blocked

**Setup:** Block popups for the site. Click "Přihlásit se".

**Expected:**

- Browser blocks the popup; address bar shows the blocked-popup icon.
- App stays on auth section, nothing visibly happens.
- Address-bar icon → "Always allow popups for this site" → click
  "Přihlásit se" again → flow proceeds as S5.

### S7. Mid-session 401, 3p cookies allowed (silent recovery — happy path)

**Setup:**

- Signed in, app loaded.
- Trigger a transient 401 with DevTools response override on the next
  Drive request (revoking permission doesn't work here — it kills
  consent and silent reauth can't recover).

**Expected:**

- User does a save / edit / delete.
- 401 hits inside `withReauth`. `attemptSilentReauth` fires (iframe).
- 3p cookies allow it → fresh access token returned.
- Original call retries → succeeds.
- Save completes; user sees no auth interruption.
- `my-weight:token` refreshes with new `token` and new `expiresAt`.
- Network panel: one (mostly invisible) request to
  `accounts.google.com/o/oauth2/iframerpc` or similar, followed by the
  retried Drive call.

### S8. Mid-session 401, 3p cookies blocked (fatal fallback)

**Setup:** Same as S7 but 3p cookies blocked.

**Expected:**

- 401 → silent reauth attempt → times out (8 s) or errors immediately.
- Console: `Silent re-auth on 401 failed`.
- Original 401 re-thrown.
- Catch block calls `handleFatal401()`:
  - `my-weight:token` removed from localStorage.
  - In-memory `records` / `settings` / `fileId` / `revisionId` reset.
  - Header logo display resets to the placeholder `72.5` —
    **verify** the previous user's weight is not visible on the
    auth screen.
  - Auth section shown.
  - Alert: `Přihlášení vypršelo, přihlaste se znovu.`
- "Přihlásit se" → popup → re-auth → app reloads with records.

### S9. Mid-session 401, permission revoked at Google account

**Setup:** Signed in. In another tab, revoke at
https://myaccount.google.com/permissions. Back in the app, save a record.

**Expected:**

- Silent reauth fires but fails (no consent on file).
- `handleFatal401()` → records cleared, logo reset to 72.5, auth
  section + alert.
- "Přihlásit se" → popup will include the consent screen (because
  access was revoked). User re-grants → records load.

### S10. Logout

**Setup:** Signed in. Open menu → "Odhlásit se".

**Expected:**

- Token revoked at Google (check
  https://myaccount.google.com/permissions — entry for "Moje váha"
  should be gone).
- `my-weight:token` removed from localStorage.
- Menu closes, auth section shown.
- In-memory state (`records`, `settings`, `fileId`, `revisionId`,
  `recordsLoaded`, paging, edit mode) reset.
- Header logo display resets to the placeholder `72.5` — **verify**
  the previous user's weight is not visible on the auth screen.

### S11. Wipe all data

**Setup:** Signed in with at least one record. Menu → "Smazat všechna
data". Type `smazat vše` exactly. Confirm.

**Expected:**

- Loading spinner with `Mažu data...`.
- Drive file `weight_records.json` deleted in `appDataFolder` (verify
  on another signed-in device, or by signing in fresh and seeing an
  empty state).
- App section shows empty state, no records.
- Alert: `Data byla smazána.`

### S12. Settings save during 401 (background path)

**Setup:** Signed in. Trigger a mid-session 401 (override or revoke).
Change theme in the menu (triggers debounced `scheduleSettingsSave`).

**Expected:**

- 500 ms after the click, the save fires.
- 401 → silent reauth → fails.
- Console: `Failed to save settings`.
- **No alert, no auth-section redirect** — settings saves are
  intentionally silent. The next user-initiated Drive op surfaces the
  auth screen via `handleFatal401()`.

## Cross-cutting checks

- **No double popup or double iframe**: two near-simultaneous saves
  under an expired token should share a single silent-reauth attempt
  (the `pendingSilentReauth` promise is deduplicated). Trigger by
  spamming save + edit while the token is expired; only one iframe
  request should appear in the Network panel.
- **localStorage state after each scenario** matches the expected auth
  state (present + valid, present + expired, or absent). DevTools →
  Application → Local Storage.
- **DevTools console** has no uncaught errors. `console.warn` for a
  failed silent reauth is expected; `console.error` followed by
  `handleFatal401` is expected on fatal 401.
- **Authorization header on retry**: when silent reauth succeeds and
  `uploadRecords` retries the PATCH/POST, Network panel should show
  the retry with a fresh `Bearer ...` token (different last few chars
  than the failed request).
