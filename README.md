# <img src="docs/assets/phoenix-key-rounded.png" width="128" align="right" alt=""> Login Assistant for UChicago<br clear="right">

[Simplified Chinese](README_zh.md)

Login Assistant for UChicago is a personal Chrome extension that makes signing in to your UChicago account easier and faster.

After you confirm the sign-in prompt, the assistant enters your saved credentials and completes supported Okta sign-in steps. Duo verification runs automatically when a usable passkey is saved for your account; otherwise, you complete it yourself.

- Works with my.UChicago, Canvas, and third-party applications that use UChicago Okta.
- Follows the approved sign-in through redirects and different Duo subdomains, without manual Duo URL setup.
- Stores account details and newly registered passkeys in your Chrome profile.
- Includes English and Simplified Chinese interfaces with automatic light and dark appearance.

Current version: 1.6.10

Release date: August 29, 2026

## Installation

Requires desktop Google Chrome 120 or later. No server, build step, or dependency installation is needed to use the extension.

1. Download or clone this repository, or extract a project ZIP, into a permanent folder.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the **extension** folder inside the project.
4. **Settings** opens automatically after installation. You can reopen it from **UChicago Login Assistant** in Chrome's Extensions menu.

To update, replace the project files in the same folder, choose **Reload** on `chrome://extensions`, and refresh open sign-in pages. Do not uninstall as an update step: uninstalling removes this extension's saved account information and passkeys.

## Getting started

In **Settings → Account**, enter your **CNetID or UCMEDID** and **Password**, then choose **Save**. Account details must be entered in the extension; it does not import passwords from Chrome's password manager.

Make sure the assistant is enabled using the power icon in its popup. Then start from a service you want to use:

| Starting point | What happens after confirmation |
| --- | --- |
| [my.UChicago](https://my.uchicago.edu/) | Goes directly to student sign-in, skipping the portal; supports HTTP and HTTPS |
| [my.UChicago portal](https://portal.uchicago.edu/ais/) | Goes directly to student sign-in without waiting for the portal page to finish loading |
| [Courses homepage](https://courses.uchicago.edu/) | Opens the Canvas sign-in at `https://canvas.uchicago.edu/login/1` |
| A recognized UChicago Okta sign-in page, including `https://uchicago.okta.com/app/*` | Fills and submits the supported account and password steps |

The assistant asks:

> Sign in to UChicago with saved account?

Choose **Confirm** to continue or **Cancel** to stop the attempt. On my.UChicago, the prompt appears in the current tab and Cancel opens the regular portal. Pausing the assistant or removing the saved account restores the normal my.UChicago navigation. **Enter** or **Space** confirms when focus is on the page or Confirm button; **Esc** cancels. Inputs and other focused controls keep their normal keyboard behavior.

Start from the application you want to access, not the `uchicago.okta.com` account management home page. The referring application and final destination do not need to end in `uchicago.edu`. Redirects stay within the approved flow in the same tab; an existing session may also return directly to the application without visiting Duo.

After Duo verification, the assistant selects **Yes, this is my device** if Duo asks **Is this your device?**. If that page does not appear, sign-in continues normally.

### Popup and settings

| Control | Action |
| --- | --- |
| Power icon | Enable or pause the assistant |
| Circular arrow | Ask again on the current supported page after a canceled or stopped attempt |
| Settings icon | Manage the account, passkeys, PIN, language, and local data |

A card icon appears when an account and password are saved. A key icon appears when a local passkey exists; it does not indicate that Duo has accepted its registration.

Choose the interface language at the top of **Settings**. Changes apply immediately to extension windows. Your choice is remembered when you reopen or refresh the page. The appearance follows your system theme.

Choose **Save** to save your account details. If the saved account has no usable passkey, the assistant asks whether you want to add one for one-click sign-in. **Duo & passkeys** shows the current verification mode with a status icon. A usable passkey for the saved account keeps **Automatic verification** on; without one, Duo verification is manual. There is no mode switch. **Add a passkey** and its explanation are hidden while a usable key exists, and return when the last usable key is deleted or marked invalid. Duo may remember this browser and skip verification; when it asks again depends on Duo's policies.

Saved passkeys appear with a lock icon, their account, added date, and a delete control. A key explicitly rejected by Duo is marked **Invalid** and excluded from automatic use. The assistant offers to add a replacement. Canceling releases the current Duo verification for manual completion; the next sign-in goes directly to device management and asks again only when Duo is ready to create the replacement. Timeouts, cancellations, and unmatched requests do not establish that a key is invalid. Local keys are never deleted automatically, including when you register a replacement.

## Duo passkeys

The extension includes a software passkey provider. It creates new credentials locally and lets Duo register their public keys; it does not import existing passkeys from your browser, operating system, or security key.

### Add a passkey

1. After saving an account without a usable passkey, confirm the prompt to add one for one-click sign-in. You can also choose **Settings → Duo & passkeys → Add a passkey**. This confirmation starts a fresh student sign-in and covers that setup sign-in.
2. The assistant opens Duo's options menu and chooses **Manage devices**. Complete Duo's identity check if asked. A short message guides you to choose an existing method and finish verification; the assistant then continues automatically.
3. In device management, the assistant chooses **Add a device → Security key → Continue**. In the extension's **Add a passkey** window, choose **Continue**.
4. Once the new security key appears in Duo's device list, the assistant chooses **Back to login**, opens the options menu, and selects **Security Key**. A key appearing in the extension alone does not establish that Duo accepted its registration.
5. **Automatic verification** turns on once setup is complete and stays on while a usable passkey is saved. The Add a passkey button and its explanation disappear from Settings. A verification PIN is still needed if Duo requires it.

No Duo address needs to be entered or saved. Chrome must allow the extension to access Duo pages. Standalone Duo tabs and requests outside the approved flow use Chrome's normal passkey provider.

If a request is incompatible, choose **Use another passkey provider** when offered, or continue with your existing Duo method. Hardware attestation, platform-only authenticator requests, and some WebAuthn features are not supported. Duo's policies determine which credentials it accepts.

### Confirmation and verification PIN

Your initial confirmation covers the current sign-in in that tab for up to five minutes. With a usable saved passkey, the assistant chooses a usable passkey for your saved account without another passkey confirmation. Redirects do not restart the timer. A missing or invalid key, an unsupported request, or a required verification PIN may need your attention. A new sign-in needs a new confirmation.

When Duo requires identity verification, the extension checks the **Verification PIN** entered for that attempt, or lets you use another provider. You can set this optional PIN in settings using 6–128 characters. It is separate from your school password and device PIN, and does not lock the local vault. Five incorrect attempts pause PIN checks for five minutes.

Keep another Duo verification method.

## Privacy and security

Your account password, passkey private keys, and PIN verification record are encrypted with AES-GCM in the extension's local IndexedDB. The decryption key is also stored locally and can be used automatically by the extension. This does not protect saved credentials from someone who controls your device, Chrome profile, or extension environment.

- No developer server, analytics, advertising, cloud sync, cookie collection, or access to Chrome's password database.
- Account credentials are filled only on recognized UChicago Okta sign-in pages after approval. Passkey responses are restricted to Duo pages admitted into that flow; private keys remain local.
- Intermediate and destination sites receive no credentials or page automation from the extension. Those services and other passkey providers have their own privacy practices.
- Recent activity keeps at most 20 entries from the past 24 hours, excluding passwords, private keys, and full sign-in URLs. Older entries are deleted during periodic cleanup, at startup, and when activity is read or added.

### Permissions

| Permission or site access | Purpose |
| --- | --- |
| `storage` | Save settings, recent activity, and temporary sign-in state |
| `scripting` | Maintain Duo page integration |
| `webNavigation` | Track the approved flow and bind requests to the current tab and document |
| `alarms` | Clean up expired requests, approvals, and activity |
| `declarativeNetRequestWithHostAccess` | Show the confirmation page before my.UChicago redirects to the portal |
| `cookies` | Prepare a fresh school sign-in before guided passkey setup |
| `*://uchicago.okta.com/*` | Recognize and complete supported school sign-in steps |
| `*://*.duosecurity.com/*` | Handle compatible passkey requests within an approved sign-in |
| `https://portal.uchicago.edu/*` | Start the student sign-in from the portal |
| `https://courses.uchicago.edu/*` | Start Canvas sign-in from the Courses homepage |
| `*://*.ais.uchicago.edu/*` | Include AIS in the permitted student sign-in sites; server redirects continue normally |
| `*://my.uchicago.edu/` | Offer direct student sign-in from the HTTP or HTTPS homepage; account credentials are never filled on HTTP pages |

Manage these host permissions through Chrome's **Site access** controls. Access to Duo does not authorize unrelated Duo sign-ins; a valid approved flow is still required.

### Deleting data

**Settings → Local data → Delete local data** removes saved account credentials, local passkeys, and the PIN, and resets settings, language, and activity. Uninstalling the extension or deleting its Chrome profile also removes local credentials.

These actions do not delete your school account, remove registrations from Duo, or delete passkeys held by other providers. Remove obsolete registrations in Duo separately, and retain another way to sign in.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| No sign-in prompt | Save an account, enable the assistant, allow the relevant site access, and refresh a supported entry or actual Okta sign-in page. Account settings and password recovery pages are excluded. |
| A canceled attempt does not prompt again | Use the circular-arrow **Retry sign-in** control in the popup. |
| The flow stops at an entry page or Duo | Check Chrome's site access, then start and approve a new sign-in in the same tab. If the page or request is unsupported, continue manually. |
| Chrome's normal passkey dialog appears | Expected without a usable saved key, outside an approved flow, or after choosing another provider. If a usable key is saved, reload the extension and begin a fresh school sign-in. Unmatched or unsupported requests show an extension prompt before using another provider. |
| Another confirmation or PIN is required | Follow the request or choose another provider. Approval expires, and Duo may require fresh identity verification. |

## Development

Requires Node.js 22 or later. There are no third-party runtime or test dependencies.

```sh
npm run check                  # Static and documentation checks
npm test                       # Focused UI, localization, and theme tests
npm test -- controller policy  # Run selected test suites
npm run package                # Static checks and packaging
```

For a full test run, use `npm run test:all`. Packaging creates a source folder, ZIP, and SHA-256 checksum in `dist/`; it does not run the test suites again.

The loadable extension is in `extension/`, synthetic tests are in `test/`, and checks and packaging scripts are in `scripts/`.

Further reading: [Architecture](docs/DESIGN.md) · [Testing guide](docs/QA.md) · [Icon artwork](docs/ICON.md)

## Independence statement

This extension is an independent project. It is not affiliated with, sponsored by, or endorsed by the University of Chicago, Okta, Duo Security, or any other organization.
