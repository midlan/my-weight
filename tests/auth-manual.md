# Manual auth + session tests

Most of the auth + Drive flow is covered by `auth.spec.js` (mocked GIS +
Drive harness, ~45 tests). This file lists the cases that **can't** be
automated, because they need real browser behavior — third-party-cookie
policy, popup-blocker UX, Google-side consent state, or real network
headers — that the Playwright mock can't faithfully reproduce.

Run through this checklist after any change to:

- `attemptAutoLogin`, `attemptSilentReauth`, `withReauth`, `handleFatal401`
- the `tokenClient.callback` / `error_callback` branches
- any Drive primitive that talks to a real Google endpoint

Everything else (first-visit auth, cached-token auto-login, expired-token
silent reauth happy + fail, explicit login happy path, mid-session 401
silent recovery + fatal fallback, logout, wipe, settings-save silent
fail, `pendingSilentReauth` dedup) is verified by `auth.spec.js` on
every CI run.

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

Google access tokens are 1 hour. Quickest way:

- DevTools → Application → Local Storage → `https://mojevaha.cz` →
  edit `my-weight:token`, set `expiresAt` to `0`. Reload.
  `loadStoredToken()` returns null; app falls through to silent re-auth.

## Scenarios

### M1. Explicit login, popups blocked

**Setup:** Block popups for the site. Click "Přihlásit se".

**Expected:**

- Browser blocks the popup; address bar shows the blocked-popup icon.
- App stays on auth section, nothing visibly happens.
- Address-bar icon → "Always allow popups for this site" → click
  "Přihlásit se" again → consent popup opens → records load.

**Why manual:** the popup blocker is a real-browser feature; the GIS
mock just resolves the token callback synthetically.

### M2. Expired cached token, 3p cookies blocked (real iframe)

**Setup:** Sign in, expire the cached token (set `expiresAt: 0`),
block 3p cookies, reload.

**Expected:**

- Loading spinner.
- Silent iframe to `accounts.google.com` is loaded but the 3p-cookie
  block prevents Google from reading its session cookie → silent
  attempt either errors quickly (via `error_callback`) or times out
  after 8 s.
- Auth section appears.
- Console: `Silent token request timed out (likely a blocked popup)`
  for the timeout case, or `Token client error` for an immediate
  failure.
- Clicking "Přihlásit se" (with popups allowed) opens a popup →
  consent → records load.

**Why manual:** the mock's `silentReauthSucceeds=false` fires
`error_callback` directly — it doesn't actually load the iframe, so
the real cookie/iframe interaction is only exercised here.

### M3. Mid-session 401, real 3p-cookie behavior

**Setup:**

- Signed in, app loaded.
- Trigger a transient 401 with DevTools response override on the next
  Drive request (revoking permission would also kill consent — see M4).
- Toggle 3p cookies allowed vs blocked between runs.

**Expected (3p cookies allowed):**

- 401 hits inside `withReauth`. `attemptSilentReauth` fires (iframe).
- Fresh access token returned, original call retries, save completes.
- `my-weight:token` refreshes with new `token` and new `expiresAt`.
- Network panel: one request to `accounts.google.com/o/oauth2/iframerpc`
  (or similar), followed by the retried Drive call.

**Expected (3p cookies blocked):**

- Silent reauth times out (8 s) or errors immediately.
- `handleFatal401()` runs: localStorage cleared, in-memory state reset,
  header logo resets to `72.5`, auth section + `Přihlášení vypršelo`
  alert.

**Why manual:** same iframe / 3p-cookie reason as M2.

### M4. Mid-session 401, permission revoked at Google account

**Setup:** Signed in. In another tab, revoke at
https://myaccount.google.com/permissions. Back in the app, save a record.

**Expected:**

- Silent reauth fires but fails (no consent on file).
- `handleFatal401()` → records cleared, logo reset to `72.5`, auth
  section + alert.
- "Přihlásit se" → popup will include the consent screen (because
  access was revoked). User re-grants → records load.

**Why manual:** Google's consent-revocation flow is Google-side state;
the mock has no equivalent.

### M5. Logout actually revokes at Google

**Setup:** Signed in. Open menu → "Odhlásit se".

**Expected:**

- Token revoked at Google (verify
  https://myaccount.google.com/permissions — entry for "Moje váha"
  should be gone).

**Why manual:** the in-app side of logout (state reset, auth section
shown, logo reset to 72.5) is covered automatically; only the
Google-side revocation needs a real account to verify.

### M6. Authorization header on retry

**Setup:** Trigger a mid-session 401 with DevTools response override.
Watch the Network panel during the silent-recovery retry.

**Expected:**

- When silent reauth succeeds and the original `uploadRecords` retries
  the PATCH/POST, the retry's `Authorization: Bearer ...` carries a
  different token than the failed request.

**Why manual:** the mock doesn't introspect request headers, and the
value of this check is specifically that the *real* network layer
attaches the fresh token.

## Cross-cutting checks

- **DevTools console** has no uncaught errors. `console.warn` for a
  failed silent reauth is expected; `console.error` followed by
  `handleFatal401` is expected on fatal 401.
- **localStorage state** after each scenario matches the expected auth
  state (present + valid, present + expired, or absent). DevTools →
  Application → Local Storage.
