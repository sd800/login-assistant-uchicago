# Architecture

UChicago Login Assistant is a Manifest V3 extension that coordinates a confirmed sign-in across school entry pages, Okta, and Duo. It runs entirely in Chrome, without a backend or third-party runtime dependencies. For installation and everyday use, see the [README](../README.md).

## Code map

| Component | Responsibility |
| --- | --- |
| [Service worker](../extension/background.js) | Connects Chrome events to the controller and initializes storage and cleanup |
| [Controller](../extension/core/controller.js) | Owns approvals, navigation state, settings actions, and passkey jobs |
| [Routes](../extension/content/routes.js) and [policy](../extension/core/policy.js) | Identify supported pages and validate origins, credentials, and expiry |
| [Navigation shortcut](../extension/core/shortcut.js) and [start page](../extension/start.html) | Confirm my.UChicago navigation before its portal redirect |
| [Page adapters](../extension/content/) | Recognize entry, Okta, and Duo controls and perform authorized actions |
| [Passkey bridge](../extension/content/passkey-bridge.js) | Connects page WebAuthn calls to the isolated Duo adapter |
| [Passkey implementation](../extension/core/passkeys.js) | Validates requests and creates registration and assertion responses |
| [Vault](../extension/core/vault.js) and [encoding](../extension/core/encoding.js) | Encrypt credentials and encode authentication data |
| [Settings](../extension/settings.html), [popup](../extension/popup.html), and [confirmation](../extension/confirm.html) | Present account controls, status, and approval requests |
| [Localization](../extension/localization.js) and [locale preferences](../extension/core/locale.js) | Apply interface text and synchronize language choices |

## Sign-in lifecycle

A sign-in starts on my.UChicago, its portal, the Courses homepage, or a recognized UChicago Okta login page. The controller requires confirmation before releasing account credentials or starting an entry-page action. my.UChicago uses a confirmation page in the current tab; other entry pages use a separate confirmation window.

A dynamic [declarative navigation rule](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) redirects top-level GET requests for the HTTP or HTTPS my.UChicago homepage to `start.html`, before the server's portal redirect. It excludes other paths and nonempty query parameters. The rule exists only while the assistant is enabled, an account is saved, and my.UChicago access is available. Initialization, account changes, and permission changes synchronize it without rewriting an unchanged rule. An unreadable account removes the rule.

Only `start.html` is declared as a [web-accessible resource](https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources), allowing address-bar navigation and links from other sites. Its public markup contains no account information. Scripts, settings, and ordinary confirmation pages remain private. Frame restrictions and controller checks admit only the extension's current top-level start-page document; the public page cannot request account passwords. The controller uses `runtime.getContexts()` to validate that extension document at load and approval time, because `webNavigation.getFrame()` excludes extension pages. Ordinary website documents continue to use `webNavigation.getFrame()`. Split incognito mode allows that resource to open when the user has separately enabled the extension in private windows.

The start page shares the ordinary confirmation UI and keyboard behavior. Approval opens the fixed HTTPS AIS student endpoint in the same tab and starts the usual five-minute flow. Cancel opens the regular portal and suppresses a second prompt there, regardless of whether its content script or navigation event arrives first. Cancel can still leave the start page if the worker is unavailable. Pause, missing account data, or revoked access returns to the normal portal without approval.

Portal approval opens the fixed HTTPS AIS student endpoint without waiting for the portal body or navigation controls to render. The controller validates that exact target before navigation. AIS access is declared in the manifest, but there is no AIS form or page automation. Its server redirects create the school's authentication state; the extension does not prefetch, cache, or rebuild OAuth redirects. Courses approval opens the fixed Canvas login endpoint. The Okta adapter supports separate username and password steps, combined forms, and Duo redirects. Account management, password recovery, and one-time-code forms are excluded. The Okta adapter starts at document creation and responds to form mutations, lifecycle events, and input events. Exact active Okta fields and submit controls can be handled after they enter the DOM without waiting for layout rectangles, while hidden templates remain excluded. Confirmation immediately wakes the approved document without another detection request; each action still requires controller authorization. Entry confirmation does not wait for the page body to load. A fallback timer covers missed changes. It rechecks the form and authorization before submitting, waits for disabled buttons to become available, and submits a password at most once per document, including when multiple events arrive together.

Okta recognition prioritizes input names and autocomplete attributes, the fixed sign-in submit ID, save controls, and native submit buttons. These structural identifiers work across interface languages; visible English and Chinese labels provide a fallback. Multiple matching primary controls are left untouched. New-password and one-time-code fields are excluded structurally, and nonempty Okta error containers stop automation regardless of their message language. The fixed sign-in ID and field definitions are present in Okta's [primary authentication form](https://github.com/okta/okta-signin-widget/blob/master/src/v1/views/primary-auth/PrimaryAuthForm.js).

An approved tab does not need to remain selected. While its five-minute flow is live, the controller disables automatic tab discarding and restores the tab's previous setting when authority ends. The service worker sends document-scoped wake messages after navigation commits, DOM readiness, page completion, startup recovery, and periodic maintenance. Entry, Okta, and Duo adapters treat these messages as event-driven rechecks, so their normal progress does not depend on foreground timer frequency. Mutation observers and lifecycle events remain the primary page-state signals; bounded timers provide fallback recovery.

The controller tracks four stages:

| Stage | Meaning |
| --- | --- |
| `entry` | Waiting to start an approved my.UChicago, portal, or Courses action |
| `handoff` | Following that entry's launch endpoint |
| `auth` | On an admitted Okta or Duo document |
| `transit` | Observing an intermediate or destination page without interacting with it |

Approval belongs to a tab and flow, not to the domain of the application being accessed. A third-party application can initiate UChicago sign-in, and the destination can also be outside `uchicago.edu`. Browser navigation events distinguish redirects and authentication submissions from manual navigation. A flow can visit multiple Duo subdomains or return directly to its destination without Duo.

Intermediate and destination pages receive no credentials or page automation. Reaching a destination ends automatic work; it does not establish that the application accepted the sign-in.

## Authorization boundaries

Page scripts request actions through the service worker. Before releasing credentials or processing a passkey request, the controller checks the extension sender, top-level tab and frame, current document, HTTPS origin, host access, and active flow. Settings and approval actions also require the corresponding extension page.

The lifetime limits are defined in [policy.js](../extension/core/policy.js):

| State | Limit |
| --- | --- |
| Confirmation page or window | Two minutes |
| Approved sign-in | Five minutes from initial confirmation |
| Entry handoff or redirect observation | Up to one minute, within the sign-in lifetime |
| Passkey approval | Current account and tab, within the original sign-in deadline |
| PIN lockout | Five minutes after five incorrect attempts |

A grant identifies the tab, flow, account, and approved credential/RP pairs. The initial confirmation covers those keys during this sign-in, including slow redirects and fresh challenges, without a second passkey choice. Challenge fingerprints and job start state are persisted before cryptography so a restarted worker cannot sign the same challenge again. Automatic assertions are bounded to twelve requests per flow. Redirects never renew approval. Registration still requires its own confirmation and can authorize the new key for the remaining flow. After the guided setup observes the new device in Duo, it selects that key and enables automatic verification. Failed or canceled guided setup does not make an unfinished key available for automatic verification. A key rejected by Duo is retained and marked invalid. Canceling the replacement prompt releases the current Duo request for manual verification; the next approved sign-in enters guided device management directly and keeps the registration confirmation at the actual credential-creation request.

Manual navigation, cancellation, expiry, pausing, changes to authentication settings, and revoked access invalidate affected approvals and requests. Pending messages are checked against the browser's current frame rather than trusting the page's reported location.

## Duo integration

The manifest grants access to UChicago Okta, my.UChicago and its portal, Courses, AIS subdomains, and Duo subdomains. Cookie access is restricted to UChicago Okta, Duo and AIS hosts and is used only when guided setup has been confirmed. Static content scripts load at document start, with the isolated adapter listed before the main-world WebAuthn bridge. The bridge wraps both instance and prototype methods before page scripts can cache them; duplicate installation is ignored. The worker removes older dynamic registrations during initialization. See Chrome's [content script execution environments](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts#work_in_isolated_worlds) and [scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting).

The isolated adapter waits briefly for navigation state to identify the document. Unapproved requests and manual verification use Chrome's provider. A known approved flow that expires or loses its connection returns an error instead of starting a second, native authentication request. Host permission alone does not authorize a Duo request, and no individual Duo tenant is saved as a trusted site.

Duo verification is automatic whenever the saved account has a usable key, regardless of a manual preference saved by an older version. Without such a key, verification is manual. Automatic verification uses a separate navigation phase sequence. A compatible key request is handled immediately; an unmatched default request is held while the adapter opens Other options and selects Security key. Held requests are canceled before switching methods, without invoking Chrome's provider. DOM mutations and captured method selections trigger work without waiting for the periodic poll.

Saving an account without a usable key offers guided setup. The setup confirmation removes scoped cookies for UChicago Okta, Duo and AIS hosts before opening a fresh student-portal sign-in. Cookie enumeration includes partitioned cookies, and removal refuses shared parent-domain cookies. Cleanup re-reads Chrome state and makes up to three bounded attempts when a live tab rewrites a scoped cookie. It then creates a short-lived, account-bound setup intent for the new tab; the setup confirmation also authorizes that setup sign-in, so no second login prompt is shown. Starting setup alone does not enable automatic verification; successful registration does. It opens Manage devices and waits through identity verification, using an existing compatible key if available. While manual identity verification is needed, a localized inline notice asks the user to choose a method and complete verification. The notice never takes focus or clicks a method; it disappears after leaving that step, pausing, or expiry. On the device-management portal, it records a stable snapshot of security-key cards before choosing Add a device, Security key, and Continue.

The new local credential stays pending until the portal shows one additional security-key card with the previous cards intact. Only then does the adapter return to login and open the verification menu again. Card snapshots are stored as hashes in session state, without device names or phone numbers. Observing a device does not create or renew a user-presence grant. Security key selection is authorized first and acknowledged when the adapter dispatches the click. A menu rerender during authorization remains retryable instead of leaving the flow falsely marked as authenticating. Menu recognition combines semantic controls, accessible labels, nested method titles, the method-list structure, and the distinctive Manage devices structure. Label matching normalizes case, whitespace, and Unicode presentation differences; it does not require a particular method-label class. Ambiguous controls are not clicked. Other options receives action authorization as soon as the link is ready. A rerendered link remains retryable, and only observing the menu records completion for the flow. Pending default-method requests remain held while switching; matching Security key requests retain immediate processing. Accepted phase changes and completed clicks trigger a recheck; an unchanged inventory does not reschedule itself. Other setup actions remain single-use; unknown screens are left alone.

After verification, the optional device-remembering screen selects its affirmative control once in the approved document, including after manual Duo verification. The adapter requires the specific question and a unique affirmative choice, checks permission again before clicking, and never waits for that screen if it is absent.

## Passkey support

The provider creates local ES256/P-256 credentials. Registration responses use COSE public keys and `none` attestation; assertions use DER-encoded ECDSA signatures and persisted signature counters. Discoverable credentials and credential allow/exclude lists are supported. Existing passkeys in Chrome, the operating system, or a security key are not imported.

The relying-party ID must match the requesting Duo host or one of its parent domains within `duosecurity.com`, and the selected credential must match that ID and the request. The worker rechecks origin, document, permission, and flow before returning a response.

User presence and user verification are distinct [WebAuthn concepts](https://www.w3.org/TR/webauthn-3/). Confirmation supplies presence; the verification flag is set only after the PIN entered for that approval passes verification. A click alone does not supply identity verification.

Conditional and silent requests also pass through the adapter before any native call. In automatic mode they can be held while switching a default method; otherwise an unsupported selected method waits for an explicit provider choice. The provider supports `credProps` and Duo same-site legacy `appid`/`appidExclude` hints. Assertions still use the WebAuthn relying-party hash and return `appid: false`; no legacy U2F credential is imported. Platform-only authenticators, enterprise attestation, and other WebAuthn extensions are unsupported. During automatic verification, an incompatible request opens an extension prompt; only an explicit provider choice invokes native fallback. Identity checks without a matching local key remain manual. The extension does not provide hardware attestation.

## Passkey status

A generated response, its delivery to the Duo page, and Duo's acceptance are different events. The main-world bridge acknowledges only reconstruction and return to the page; it does not prove network submission or successful authentication.

An explicit visible unregistered-key or removed-key message may mark the latest delivered credential as invalid. The adapter ignores pre-existing errors, generic failures, timeouts, and cancellations. The worker rejects stale jobs, documents, and expired outcomes. An allow-list mismatch or missing inventory card does not establish invalidity.

Invalid keys remain in the vault, appear with an Invalid label in Settings, and are excluded from automatic selection. A replacement action starts setup within the existing flow without extending its lifetime or renewing presence. No status transition, cancellation, cleanup, or replacement deletes a local credential. Only explicit user deletion or clearing local account data removes saved keys.

## Storage and privacy

| Storage | Contents |
| --- | --- |
| Extension IndexedDB | An encrypted vault containing the account, passkey private keys, and PIN verification record; the vault's nonexportable AES key |
| `chrome.storage.local` | Enabled state, derived automatic-verification state, account-matched passkey ID, language preference, PIN attempt limits, and recent activity |
| `chrome.storage.session` | Flows, confirmation requests, passkey jobs, and temporary grants |

The vault uses AES-256-GCM with a fresh nonce for each write. PIN checks use a salted PBKDF2-SHA-256 record. Local and session storage access is restricted to trusted extension contexts using Chrome's [storage access controls](https://developer.chrome.com/docs/extensions/reference/api/storage).

The vault key is a nonexportable CryptoKey held in extension-owned IndexedDB and used locally by the extension. Encryption and decryption happen on the device, keeping account credentials, passkey private keys, and the PIN verification record protected at rest. The verification PIN provides local user verification for supported WebAuthn requests that require it. The extension has no cloud backup or synchronization.

Activity contains at most 20 entries from the past 24 hours. Cleanup runs on startup, periodically, and when activity is read or added. Entries omit passwords, private keys, and full authentication URLs.

Clearing local account data removes saved credentials and PIN information and resets settings, language, activity, and pending approvals. It does not delete the school account or registrations held by Duo. Uninstalling or losing the Chrome profile also removes access to locally saved credentials.

## Interface behavior

Account and PIN forms save independently. The popup's power control saves immediately while preserving drafts in other sections. Duo verification is displayed as a status, without a mode switch. The Add a passkey action and its explanation are hidden while the saved account has a usable key. Settings lists passkeys with account information, creation time, invalid-state labels, and individual deletion controls. Matching excludes pending registrations and explicitly rejected keys. Without a usable key, Duo method selection and verification remain with the user; a separately requested setup flow can still add a new local passkey.

The interface supports English and Simplified Chinese. Language changes update open extension windows without replacing form fields or altering sign-in state. Each page applies its language before revealing content, avoiding an initial flash of another language. Dates use the device's time zone. The shared stylesheet follows system appearance and provides keyboard focus states and language-appropriate spacing.

Confirmation shortcuts use the same validation and approval path as the buttons. Enter and Space confirm from the page or Confirm button; Escape cancels. Inputs, selectors, links, and other focused controls retain their normal keyboard behavior.

## Testing

Automated coverage includes state transitions, storage, cryptography, page adapters, localization, and interface handlers. Browser layout and acceptance by school services require separate checks. See the [testing guide](QA.md) for commands, coverage, and manual verification steps.
