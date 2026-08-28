# Architecture

UChicago Login Assistant is a Manifest V3 extension that coordinates a confirmed sign-in across school entry pages, Okta, and Duo. It runs entirely in Chrome, without a backend or third-party runtime dependencies. For installation and everyday use, see the [README](../README.md).

## Code map

| Component | Responsibility |
| --- | --- |
| [Service worker](../extension/background.js) | Connects Chrome events to the controller and initializes storage and cleanup |
| [Controller](../extension/core/controller.js) | Owns approvals, navigation state, settings actions, and passkey jobs |
| [Routes](../extension/content/routes.js) and [policy](../extension/core/policy.js) | Identify supported pages and validate origins, credentials, and expiry |
| [Page adapters](../extension/content/) | Recognize entry, Okta, and Duo controls and perform authorized actions |
| [Passkey bridge](../extension/content/passkey-bridge.js) | Connects page WebAuthn calls to the isolated Duo adapter |
| [Passkey implementation](../extension/core/passkeys.js) | Validates requests and creates registration and assertion responses |
| [Vault](../extension/core/vault.js) and [encoding](../extension/core/encoding.js) | Encrypt credentials and encode authentication data |
| [Settings](../extension/settings.html), [popup](../extension/popup.html), and [confirmation](../extension/confirm.html) | Present account controls, status, and approval requests |
| [Localization](../extension/localization.js) and [locale preferences](../extension/core/locale.js) | Apply interface text and synchronize language choices |

## Sign-in lifecycle

A sign-in starts on the my.UChicago portal, the Courses homepage, or a recognized UChicago Okta login page. The controller opens a confirmation window before releasing account credentials or starting an entry-page action.

Portal approval opens the validated Student my.UChicago link. Courses approval opens the fixed Canvas login endpoint. The Okta adapter supports separate username and password steps, combined forms, and Duo redirects. Account management, password recovery, and one-time-code forms are excluded. A password is submitted at most once per document, including when multiple messages arrive together.

The controller tracks four stages:

| Stage | Meaning |
| --- | --- |
| `entry` | Waiting to start an approved portal or Courses action |
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
| Confirmation window | Two minutes |
| Approved sign-in | Five minutes |
| Entry handoff or redirect observation | Up to one minute, within the sign-in lifetime |
| Selected-passkey presence grant | One use within 30 seconds of confirmation |
| PIN lockout | Five minutes after five incorrect attempts |

A grant identifies its tab, flow, relying party, and credential. The worker persists its consumption before beginning cryptography, preventing a restarted worker from reusing it. Redirects do not renew the grant. Registration always requires its own confirmation.

Manual navigation, cancellation, expiry, pausing, changes to authentication settings, and revoked access invalidate affected approvals and requests. Pending messages are checked against the browser's current frame rather than trusting the page's reported location.

## Duo integration

The manifest grants access to UChicago Okta, the two entry sites, and Duo subdomains. While enabled, the worker registers two Duo adapters at document start: a bridge in the page's main world and an adapter in Chrome's isolated world. This split lets the bridge handle WebAuthn calls without giving the page access to extension storage. See Chrome's [content script execution environments](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts#work_in_isolated_worlds) and [scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting).

The isolated adapter waits briefly for navigation state to identify the document. Requests outside an approved flow return to Chrome's native provider without forwarding passkey options to the worker. Host permission alone does not authorize a Duo request, and no individual Duo tenant is saved as a trusted site.

## Passkey support

The provider creates local ES256/P-256 credentials. Registration responses use COSE public keys and `none` attestation; assertions use DER-encoded ECDSA signatures and persisted signature counters. Discoverable credentials and credential allow/exclude lists are supported. Existing passkeys in Chrome, the operating system, or a security key are not imported.

The relying-party ID must match the requesting Duo host or `duosecurity.com`, and the selected credential must match that ID and the request. The worker rechecks origin, document, permission, and flow before returning a response.

User presence and user verification are distinct [WebAuthn concepts](https://www.w3.org/TR/webauthn-3/). Confirmation supplies presence; the verification flag is set only after the PIN entered for that approval passes verification. A click alone does not supply identity verification.

Conditional and silent requests stay with Chrome's provider. Platform-only authenticators, enterprise attestation, and extensions other than `credProps` are unsupported. An incompatible request uses the native fallback or returns an explicit error. The extension does not provide hardware attestation.

## Storage and privacy

| Storage | Contents |
| --- | --- |
| Extension IndexedDB | An encrypted vault containing the account, passkey private keys, and PIN verification record; the vault's nonexportable AES key |
| `chrome.storage.local` | Enabled state, selected passkey, language preference, PIN attempt limits, and recent activity |
| `chrome.storage.session` | Flows, confirmation requests, passkey jobs, and temporary grants |

The vault uses AES-256-GCM with a fresh nonce for each write. PIN checks use a salted PBKDF2-SHA-256 record. Local and session storage access is restricted to trusted extension contexts using Chrome's [storage access controls](https://developer.chrome.com/docs/extensions/reference/api/storage).

The extension can use its encryption key automatically. Encryption therefore does not protect credentials from an attacker controlling the Chrome profile, extension, or device. The verification PIN does not lock the vault. There is no cloud backup or synchronization.

Activity contains at most 20 entries from the past 24 hours. Cleanup runs on startup, periodically, and when activity is read or added. Entries omit passwords, private keys, and full authentication URLs.

Clearing local account data removes saved credentials and PIN information and resets settings, language, activity, and pending approvals. It does not delete the school account or registrations held by Duo. Uninstalling or losing the Chrome profile also removes access to locally saved credentials.

## Interface behavior

Account settings, passkey selection, and PIN updates are saved independently. Saving one section preserves drafts in the others. The popup's power control saves immediately; it does not depend on either settings Save button.

The interface supports English and Simplified Chinese. Language changes update open extension windows without replacing form fields or altering sign-in state. Each page applies its language before revealing content, avoiding an initial flash of another language. Dates use the device's time zone. The shared stylesheet follows system appearance and provides keyboard focus states and language-appropriate spacing.

Confirmation shortcuts use the same validation and approval path as the buttons. Enter and Space confirm from the page or Confirm button; Escape cancels. Inputs, selectors, links, and other focused controls retain their normal keyboard behavior.

## Testing

Automated coverage includes state transitions, storage, cryptography, page adapters, localization, and interface handlers. Browser layout and acceptance by school services require separate checks. See the [testing guide](QA.md) for commands, coverage, and manual verification steps.
