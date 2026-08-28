# Testing guide

This guide covers local checks and verification in Chrome. Install the extension using the [README](../README.md); the [architecture guide](DESIGN.md) explains its components and authorization model.

## Run local checks

Use Node.js 22 or later. The tests and checker use Node's built-in modules and need no dependency installation.

```sh
npm run check
npm test
```

The checker validates JavaScript syntax, manifest references, PNG assets, local resource loading, interface bindings, translation coverage, and README structure. `npm test` runs the interface, localization, and theme suites.

Select other suites by name:

```sh
npm test -- controller policy
npm test -- crypto bridge dom
```

Run every suite with:

```sh
npm run test:all
```

The test runner prints a summary on success and diagnostic output on failure. For a single case, use Node's test-name filter, for example:

```sh
node --test --test-name-pattern='a failed account save' test/ui.test.js
```

## Coverage

| Suite | Coverage |
| --- | --- |
| `ui` | Independent saves, preserved drafts, pause and retry controls, deletion, and confirmation shortcuts |
| `locale` | Translation keys, dates, language preferences, startup rendering, and cross-window updates |
| `theme` | Contrast, control visibility, icon proportions, and text spacing |
| `controller` | Approval, redirects, expiry, concurrency, worker restarts, settings actions, and activity retention |
| `policy` | Supported routes, HTTPS origins, credential matching, and grant limits |
| `crypto` | Encoding, registration data, independently checked signatures, encrypted storage, and PIN verification |
| `bridge` | WebAuthn request transfer, cancellation, expiry, and native fallback |
| `dom` | Entry links, Okta form recognition, delayed page content, and excluded forms |

Fixtures use synthetic accounts, requests, clocks, and browser/DOM substitutes. These tests do not run a real Chrome session or contact Okta or Duo.

## Check the interface in Chrome

Use a separate Chrome profile for development when practical. Load `extension/` as an unpacked extension and reload it after changes.

- Open Settings, the popup, and a confirmation window in both interface languages and system appearances. Check readable text, narrow layouts, visible focus, and labels on icon controls.
- Refresh Settings after choosing a language. The first visible text should use that language, and open windows should update when the choice changes.
- Save an account while leaving a passkey or PIN draft unsaved, then repeat with the other sections. Only the submitted section should be saved.
- Test the power control, retry action, and saved-data indicators. Indicators describe local storage, not registration or sign-in success.
- In a confirmation window, check Enter, Space, Escape, focused controls, PIN validation, cancellation, and expired requests.
- Check data deletion only in a profile whose extension data can safely be removed.

For cross-platform changes, repeat the relevant checks in desktop Chrome on each supported target operating system.

## Verify a school sign-in

Keep another working Duo verification method before testing local passkeys.

1. Start from the student portal, Courses, or an application that redirects to UChicago Okta. Confirm that the extension asks before submitting credentials.
2. Follow the recognized Okta steps and any Duo redirects in the same tab. Check that the intended application opens under the expected account.
3. Repeat with a fresh sign-in. An existing school session can skip authentication and cannot verify password or passkey handling.
4. Cancel a prompt and check that the same document does not immediately ask again. Use Retry sign-in to start another attempt.
5. Check that another tab, manual navigation, expired approval, pausing, and revoked site access cannot reuse an earlier approval.

When registering a passkey, verify three outcomes separately: the extension saved a local credential, Duo accepted the registration, and a later fresh sign-in succeeded with that credential. Also check PIN-required requests and the option to use another provider.

## Build a release archive

```sh
npm run package
```

Packaging runs static checks and writes a source directory, ZIP archive, and SHA-256 checksum to `dist/`. It does not run the test suites. The ZIP includes the extension, documentation, scripts, and tests; load its `extension/` directory in Chrome.

Before distributing an archive, extract it into a separate folder and check its manifest version, icon assets, and Settings page.
