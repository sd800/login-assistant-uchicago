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
| `dom` | Fixed entry navigation, Okta form recognition, delayed page content, multilingual Duo controls, and excluded forms |

Fixtures use synthetic accounts, requests, clocks, and browser/DOM substitutes. These tests do not run a real Chrome session or contact Okta or Duo.

## Check the interface in Chrome

Use a separate Chrome profile for development when practical. Load `extension/` as an unpacked extension and reload it after changes.

- Open Settings, the popup, and a confirmation window in both interface languages and system appearances. Check readable text, narrow layouts, visible focus, and labels on icon controls.
- Refresh Settings after choosing a language. The first visible text should use that language, and open windows should update when the choice changes.
- Save an account or PIN while leaving drafts in other fields. Verify that a usable account key forces automatic verification, including after reloading an older manual preference. The Add a passkey button and its explanation must be hidden while a usable key exists. Deleting or invalidating the last usable key must restore manual verification and the setup action; pending or other-account keys must not hide it. Setup must ask before clearing scoped login cookies, must retry a transient rewrite and must not navigate if clearing still fails, and must open one preapproved student sign-in tab after confirmation. It enables automatic verification only after the new device is confirmed in Duo. Check the green check, yellow warning, and account-lock icons.
- Test the power control, retry action, and saved-data indicators. Indicators describe local storage, not registration or sign-in success.
- In a confirmation window, check Enter, Space, Escape, focused controls, PIN validation, cancellation, and expired requests.
- Check data deletion only in a profile whose extension data can safely be removed.

For cross-platform changes, repeat the relevant checks in desktop Chrome on each supported target operating system.

## Verify a school sign-in

Keep another working Duo verification method before testing local passkeys.

1. Start from my.UChicago using HTTP and HTTPS, the student portal, Courses, or an application that redirects to UChicago Okta. On my.UChicago, confirmation should open in the current tab without a blocked-resource page; Confirm should skip the portal and open AIS student sign-in. Confirming on the student portal should also open the fixed AIS sign-in without waiting for portal content. Also test a link from another site. Other supported entry pages should keep their confirmation window.
2. Follow the recognized Okta steps and any Duo redirects in the same tab. Check delayed forms, controls that appear before the page finishes painting, disabled buttons becoming enabled, and buttons reused between username and password screens. Confirmation and page changes should advance the form without waiting for a timer, and repeated renders must not submit a password twice. Check that the intended application opens under the expected account.
3. Repeat with a fresh sign-in. Verify English first, then repeat the recognized Okta and Duo screens with Simplified Chinese. Verify the English Duo menu both with automatic selection and by manually selecting Security Key after a remembered Touch ID method. Other options must remain retryable if the link is replaced before the click, and must not reopen after the menu has appeared. If Duo asks whether this is your device after verification, the affirmative choice should be clicked once; the negative choice must remain untouched. If the page is absent, sign-in should continue without waiting. An existing school session can skip authentication and cannot verify password or passkey handling.
4. Cancel a prompt and check that the same document does not immediately ask again. Canceling the my.UChicago shortcut should open the regular portal without a second prompt. Check Enter, Space, Escape, expiry, and Retry sign-in on that page. Pausing the extension or removing the account should restore my.UChicago's normal portal redirect. Requests for other paths, real query parameters, subframes, and POSTs must not use the navigation shortcut.
5. Check that another tab, manual navigation, expired approval, pausing, and revoked site access cannot reuse an earlier approval.

Save an account without a usable key and accept the setup prompt, or use Add a passkey, to start the enrollment sequence: Other options, Manage devices, manual identity verification, Add a device, Security key, and Continue. A short notice in the selected language should guide the manual identity check without taking focus or covering controls, then disappear on device management. The adapter must not interrupt identity verification or reopen its menu. A saved local key remains pending until the device list shows one additional security key. Then Back to login may reopen the menu once and choose Security Key.

Check fresh sign-ins with a usable account key, no matching key, a deleted or invalid key, PIN-required requests, and the option to use another provider. In automatic mode, a default unmatched request must not open native UI. The menu must select Security key automatically, including nested method cards, and its request must immediately reach the extension. Wait longer than 30 seconds before Duo: a usable key must still work without another passkey confirmation inside the original five-minute window. Expiry, another tab, and changing accounts must not reuse that approval. Confirm that a key marked Invalid remains visible and is never deleted by retrying or registering a replacement. Accept its replacement prompt to enter device management immediately. Cancel it to finish the current Duo verification manually; the next sign-in must enter device management without repeating that prompt and ask again only at credential creation. Generic errors and timeouts must not mark keys invalid. A registration or assertion response is separate from Duo accepting it; confirm the result on the destination page.

## Build a release archive

```sh
npm run package
```

Packaging runs static checks and writes a source directory, ZIP archive, and SHA-256 checksum to `dist/`. It does not run the test suites. The ZIP includes the extension, documentation, scripts, and tests; load its `extension/` directory in Chrome.

Before distributing an archive, extract it into a separate folder and check its manifest version, icon assets, and Settings page.
