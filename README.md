# <img src="docs/assets/phoenix-key-rounded.png" width="128" align="right" alt=""> Login Assistant for UChicago<br clear="right">

[Simplified Chinese](README_zh.md)

Login Assistant for UChicago is a personal Chrome extension that makes your UChicago account sign-in simpler and faster.

Signing in a school account should be a simple and quick process. Meanwhile, at the University of Chicago, the process can involve several steps across Okta and Duo. Users often need to enter their username and password on separate pages, wait through multiple redirects, select a verification method, and complete Duo authentication using a fingerprint or one-time code. Because this process is repeated frequently when accessing essential services such as my.UChicago and Canvas, reducing these repetitive interactions can make everyday access more efficient.

This Chrome extension streamlines the UChicago account sign-in flow with user approval each time. By automatically handling the repetitive steps in the process, it makes signing in faster and more convenient while leaving authentication under the user's control.

- Supports my.UChicago, Canvas, and third-party applications that use UChicago account sign-in.
- Automatically completes the UChicago account sign-in flow each time you authorize a sign-in (account and passkey setup needed beforehand).
- Securely stores account information and passkeys on your device using industry-standard encryption.
- Provides English and Simplified Chinese interfaces, with automatic light and dark mode support.
- Is fully open-source, with the complete source code and technical implementation publicly available on GitHub for transparency.

Current version: 1.8.3

Release date: October 1, 2026

## Installation

Requires desktop Google Chrome 122 or later. No server, build step, or dependency installation is needed to use the extension.

1. Download or clone this repository, or extract a project ZIP, into a permanent folder.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the **extension** folder inside the project.
4. **Settings** opens automatically after installation. You can reopen it from **UChicago Login Assistant** in Chrome's Extensions menu.

To update, replace the project files in the same folder, choose **Reload** on `chrome://extensions`, and refresh open sign-in pages. Do not uninstall as an update step: uninstalling removes this extension's saved account information and passkeys.

## Set up

### Save your account and choose an authorization method

In **Settings → Account**, enter your **CNetID or UCMEDID** and **Password**, then choose **Save**. Enter these details in the extension; it does not import passwords from Chrome's password manager. Keep the assistant enabled using the power icon in its popup.

In **Settings → Authorization step**, use **Device verification** or set a **Verification passphrase**.

If you choose **Device verification** (recommended), Chrome uses its system prompt, such as Touch ID or Windows Hello. Chrome chooses the available method. A green check shows when device verification is enabled. To turn it off, enter and confirm a new passphrase, then complete Chrome's device prompt. The device must support deriving an encryption key from its credential; otherwise it cannot be enabled.

To set or change a **Verification passphrase**, enter 6–128 characters and choose **Save**, then enter the same passphrase again and choose **Confirm**. The passphrase is saved only after the entries match. A green check shows when it is set.

### Add a Duo passkey

After you save an account without a usable passkey, the assistant asks whether to add one for one-click sign-in. Confirm that prompt, or choose **Settings → Duo & passkeys → Add a passkey**. The assistant starts a fresh student sign-in for setup.

1. The assistant opens Duo's options menu and chooses **Manage devices**. If Duo asks you to verify your identity, use an existing method and finish that step. The assistant then continues.
2. In device management, the assistant chooses **Add a device → Security key → Continue**. In the extension's **Add a passkey** window, choose **Continue**.
3. When Duo's device list shows the new security key, the assistant chooses **Back to login** and then **Security Key**. The key is ready for automatic verification after Duo completes registration.

The extension creates a new passkey locally and registers its public key with Duo. It does not import passkeys from Chrome, your operating system, or a physical security key. A key appearing in the extension alone does not prove that Duo completed registration. Keep another Duo verification method.

No Duo address needs to be entered. Allow the extension to access Duo pages in Chrome. Outside a sign-in you approved through the assistant, Duo passkey requests use Chrome's normal provider.

## Sign in

Open the service you want to use and confirm the assistant's sign-in prompt. Supported starting points include:

| Starting point | What happens after confirmation |
| --- | --- |
| [my.UChicago](https://my.uchicago.edu/) | Goes directly to student sign-in, skipping the portal; supports HTTP and HTTPS |
| [my.UChicago portal](https://portal.uchicago.edu/ais/) | Goes directly to student sign-in without waiting for the portal page to finish loading |
| [Courses homepage](https://courses.uchicago.edu/) | Opens the Canvas sign-in at `https://canvas.uchicago.edu/login/1` |
| A recognized UChicago Okta sign-in page, including `https://uchicago.okta.com/app/*` | Fills and submits the supported account and password steps |

The assistant asks:

> Sign in to UChicago with saved account?

Choose **Confirm** to continue or **Cancel** to stop. On my.UChicago, the prompt opens in the current tab and Cancel opens the regular portal. **Enter** or **Space** confirms when focus is on the page or Confirm button; **Esc** cancels. Focused inputs and controls keep their usual keyboard behavior.

Complete the selected authorization step after confirming. The approval covers this sign-in in the current tab for up to five minutes, including supported redirects. With a usable saved passkey, the assistant selects **Security Key** in Duo and uses that passkey without asking you to confirm it again. Duo may remember this browser and skip verification; Duo decides when verification is needed. If Duo asks you to verify your identity separately, complete that step yourself.

You can switch to another tab while supported sign-in steps continue in the approved tab. After Duo verification, if Duo asks **Is this your device?**, the assistant selects **Yes, this is my device**. An existing session may also return directly to the application without visiting Duo.

Start from the application you want to access, not the `uchicago.okta.com` account management home page. The referring application and destination need not end in `uchicago.edu`. A new sign-in requires a new confirmation.

### Controls and saved passkeys

| Control | Action |
| --- | --- |
| Power icon | Enable or pause the assistant |
| Circular arrow | Ask again on the current supported page after a canceled or stopped attempt |
| Settings icon | Manage the account, passkeys, authorization step, language, and local data |

A card icon in the popup means an account and password are saved. A key icon means a local passkey exists; it does not prove Duo has accepted its registration. Choose the interface language at the top of **Settings**; changes apply to extension windows immediately and persist after refresh. The appearance follows your system theme.

**Duo & passkeys** shows **Automatic verification** when the saved account has a usable passkey and **Manual verification** when it does not. The Add a passkey button is hidden while a usable key exists. Without one, complete Duo verification yourself. Saved passkeys list their account and added date and have a delete control.

A key Duo explicitly rejects is marked **Invalid** and excluded from automatic use. The assistant offers to add a replacement. Canceling leaves this sign-in for manual Duo verification; the next sign-in opens device management and asks again when Duo is ready to create the replacement. Timeouts, cancellations, and unmatched requests do not mark a key invalid. Invalid or replaced local keys remain until you delete them or clear local data.

If a passkey request is incompatible, choose **Use another passkey provider** when offered, or use another Duo method. Hardware attestation, platform-only authenticator requests, and some WebAuthn features are not supported. Duo's policies determine which credentials it accepts.

The verification passphrase differs from your school password and device PIN. Five consecutive incorrect entries pause checks for five minutes; after 15 consecutive incorrect entries, the extension deletes its saved local data. A successful entry resets the count. Canceling a device verification prompt does not count as an incorrect passphrase.

## Privacy and security

Your saved username, password, and passkey private keys are encrypted in this Chrome profile with AES-256-GCM using the browser's Web Crypto API. The extension generates a random encryption key. A verification passphrase protects that key through PBKDF2-SHA-256; supported device verification uses WebAuthn PRF. The passphrase is not saved as readable text. Device verification or a long, unique verification passphrase provides the strongest local protection this extension offers. If neither authorization method is active, the data remains encrypted, but sign-in no longer requires that additional verification step.

- Each sign-in requires your confirmation. Approval is limited to the current tab and account for up to five minutes. Before using saved credentials, the extension checks the current page, HTTPS origin, and approved sign-in flow.
- Your password is filled only on recognized UChicago Okta sign-in pages. Passkeys are generated locally: Duo registers their public keys, while private keys stay on your device and sign only compatible requests in the approved Duo flow. Intermediate and destination sites receive no account details from the extension.
- No developer server receives your data. The extension has no analytics, advertising, or cloud sync, and it does not read Chrome's password manager. During confirmed passkey setup, it clears scoped school sign-in cookies to start a fresh session; it does not save their values.
- Recent activity keeps at most 20 entries from the past 24 hours, without passwords, private keys, or full sign-in URLs. Older entries are deleted automatically.

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

**Settings → Local data → Delete local data** removes saved account credentials, local passkeys, and the verification passphrase, and resets settings, language, and activity. Fifteen consecutive incorrect passphrases perform the same local deletion. Uninstalling the extension or deleting its Chrome profile also removes local credentials.

These actions do not delete your school account, remove registrations from Duo, or delete passkeys held by other providers. Remove obsolete registrations in Duo separately, and retain another way to sign in.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| No sign-in prompt | Save an account, enable the assistant, allow the relevant site access, and refresh a supported entry or actual Okta sign-in page. Account settings and password recovery pages are excluded. |
| A canceled attempt does not prompt again | Use the circular-arrow **Retry sign-in** control in the popup. |
| The flow stops at an entry page or Duo | Check Chrome's site access, then start and approve a new sign-in in the same tab. If the page or request is unsupported, continue manually. |
| Chrome's normal passkey dialog appears | Expected without a usable saved key, outside an approved flow, or after choosing another provider. If a usable key is saved, reload the extension and begin a fresh school sign-in. Unmatched or unsupported requests show an extension prompt before using another provider. |
| Another confirmation or passphrase is required | Complete the authorization step or choose another provider. Approval expires, and Duo may require fresh identity verification. |

## Development

Requires Node.js 22 or later. There are no third-party runtime or test dependencies.

```sh
npm run check                  # Static and documentation checks
npm test                       # Focused UI, localization, and theme tests
npm test -- controller policy  # Run selected test suites
npm run package                # Static checks and packaging
```

For a full test run, use `npm run test:all`. Packaging creates a source folder, ZIP, and SHA-256 checksum in `dist/`; it does not run the test suites again.

The loadable extension is in `extension/`, synthetic tests are in `test/`, and checks and packaging scripts are in `scripts/`. The extension manifest is at the root of `extension/`; `background/` holds the service worker, `pages/` the extension pages, `ui/` shared interface files, `content/` site adapters, `core/` authentication logic, and `icons/` and `locales/` their respective assets.

Further reading: [Architecture](docs/DESIGN.md) · [Testing guide](docs/QA.md) · [Icon artwork](docs/ICON.md) · [Changelog](CHANGELOG.md)

## Independence statement

This extension is an independent project. It is not affiliated with, sponsored by, or endorsed by the University of Chicago, Okta, Duo Security, or any other organization.
