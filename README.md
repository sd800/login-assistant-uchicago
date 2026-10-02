# <img src="docs/assets/phoenix-key-rounded.png" width="128" align="right" alt=""> Login Assistant for UChicago<br clear="right">

[Simplified Chinese](README_zh.md)

Login Assistant for UChicago is a personal Chrome extension that makes your UChicago account sign-in simpler and faster.

Signing in a school account should be a simple and quick process. Meanwhile, at the University of Chicago, the process can involve several steps across Okta and Duo. Users often need to enter their username and password on separate pages, wait through multiple redirects, select a verification method, and complete Duo authentication using a fingerprint or one-time code. Because this process is repeated frequently when accessing essential services such as my.UChicago and Canvas, reducing these repetitive interactions can make everyday access more efficient.

Login Assistant for UChicago streamlines the UChicago account sign-in flow with user approval each time. By automatically handling the repetitive steps in the process, it makes signing in faster and more convenient while leaving authentication under the user's control.

- Supports my.UChicago, Canvas, and third-party applications that use UChicago account sign-in.
- Automatically completes the UChicago account sign-in flow each time you authorize a sign-in after account and passkey setup.
- Securely stores account information and passkeys on your device using industry-standard encryption.
- Provides English and Simplified Chinese interfaces, with automatic light and dark mode support.
- Is fully open-source, with the complete source code and technical implementation publicly available on GitHub for transparency.

## Installation

Requires desktop Google Chrome 122 or later. The extension runs directly from the included `extension/` folder.

1. Download or clone this repository, or extract a project ZIP, into a permanent folder.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the **extension** folder inside the project.
4. **Settings** opens automatically after installation. You can reopen it from **UChicago Login Assistant** in Chrome's Extensions menu.

To update, replace the project files in the same folder, choose **Reload** on `chrome://extensions`, and refresh open sign-in pages. This preserves the saved account information and passkeys in the existing installation. Uninstalling removes the extension's locally saved data.

## Set up

Complete the following steps in **Settings**. Your account details and passkey private keys are protected by local encryption and used only for sign-ins you authorize.

### Protect your saved data

Open **Authorization step** and choose **Verify with your device**. Chrome presents Touch ID, Windows Hello, or your device's sign-in method. A green check confirms that protection is active.

The extension creates a random local encryption key and encrypts saved account details and passkey private keys with industry-standard AES-256-GCM. WebAuthn PRF binds protection of that encryption key to the device credential created for this extension. Fingerprint and face data remain inside your device's security system.

### Save your account

Open **Account**, enter your **CNetID or UCMEDID** and **Password**, and choose **Save**. Enter these details in the extension. They are encrypted on this device and become available only within a sign-in you explicitly confirm.

### Add a Duo passkey

After you save your account, confirm the prompt to add a passkey for one-click sign-in. You can also begin from **Settings → Duo & passkeys → Add a passkey**. The assistant starts a fresh student sign-in and guides the registration flow.

1. The assistant opens Duo's options menu and chooses **Manage devices**. Complete the identity check presented by Duo, and the assistant continues automatically.
2. In device management, the assistant chooses **Add a device → Security key → Continue**. In the extension's **Add a passkey** window, choose **Continue**.
3. When Duo's device list shows the new security key, the assistant chooses **Back to login** and then **Security Key**. The key is ready for automatic verification after Duo completes registration.

The extension generates a unique passkey key pair on this device. Its private key is protected locally with AES-256-GCM, and Duo registers the corresponding public key. During an approved sign-in, the private key signs Duo's challenge locally and remains on your device.

Chrome's site access lets the assistant handle recognized Duo pages within the sign-in flow you approved. Keep another Duo verification method available for account recovery and device management.

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

Verify with your device after confirming. The approval covers this sign-in in the current tab for up to five minutes, including supported redirects. With a usable saved passkey, the assistant selects **Security Key** in Duo and uses that passkey within the same approval. Duo manages trusted-browser status and presents an identity check whenever one is required; complete the check shown on the Duo page.

You can switch to another tab while supported sign-in steps continue in the approved tab. After Duo verification, the assistant selects **Yes, this is my device** when Duo presents that screen. An active school session returns directly to the application.

Begin from the application you want to access. The assistant supports school and third-party applications across different domains and recognizes the actual UChicago Okta sign-in pages they open. Each new sign-in receives its own confirmation.

### Controls and saved passkeys

| Control | Action |
| --- | --- |
| Power icon | Enable or pause the assistant |
| Circular arrow | Ask again on the current supported page after a canceled or stopped attempt |
| Settings icon | Manage the account, passkeys, authorization step, language, and local data |

A card icon in the popup confirms that an account and password are saved. A key icon identifies a locally protected passkey; Duo device management displays its registration status. Choose the interface language at the top of **Settings**; changes apply to extension windows immediately and persist after refresh. The appearance follows your system theme.

**Duo & passkeys** shows **Automatic verification** when the saved account has a usable passkey. **Manual verification** lets you use your preferred Duo method, and adding a passkey activates automatic verification. Saved passkeys list their account and added date and include a delete control. The setup action stays focused on the current account and appears when it is ready for a passkey.

A key explicitly rejected by Duo is marked **Invalid** and set aside from automatic verification. The assistant guides a replacement through Duo device management. Choosing your preferred Duo method completes the current sign-in, and the next approved sign-in resumes replacement setup. The status is based on Duo's explicit response, while timeouts, cancellations, and unmatched requests preserve the current key state. Every local key remains under your control until you delete it or clear local data.

For a request that requires another authenticator capability, choose **Use another passkey provider** or select another Duo method. The built-in provider handles local ES256 passkeys and compatible Duo WebAuthn requests, while Chrome handles provider-specific capabilities. Duo applies its credential policy to every registration and verification.

## Privacy and security

Your saved username, password, and passkey private keys are encrypted in this Chrome profile with AES-256-GCM using the browser's Web Crypto API. The extension generates a random encryption key, and device verification uses WebAuthn PRF to protect it. Chrome completes Touch ID, Windows Hello, or the corresponding system sign-in method inside the device security system. Biometric data remains there.

- Each sign-in requires your confirmation. Approval is limited to the current tab and account for up to five minutes. Before using saved credentials, the extension checks the current page, HTTPS origin, and approved sign-in flow.
- Account details stay confined to recognized UChicago Okta sign-in pages. Passkeys are generated locally: Duo registers their public keys, while private keys stay on your device and sign compatible requests within the approved Duo flow.
- All processing stays on your device. The extension operates independently of analytics, advertising, cloud sync, and developer data servers. Confirmed passkey setup clears scoped school sign-in cookies to start a fresh session and immediately discards their values.
- Recent activity contains status and time information only, with at most 20 entries from the past 24 hours. Older entries are deleted automatically.

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
| `*://my.uchicago.edu/` | Offer direct student sign-in from the HTTP or HTTPS homepage; credential entry takes place on the recognized HTTPS Okta page |

Manage these host permissions through Chrome's **Site access** controls. The assistant binds Duo actions to the tab, account, and sign-in flow you approved.

### Deleting data

**Settings → Local data → Delete local data** removes saved account credentials and local passkeys, and resets settings, language, and activity. Uninstalling the extension or deleting its Chrome profile also removes local credentials.

Your school account, Duo registrations, and passkeys held by other providers remain available. Manage Duo registrations from Duo device management and keep another verification method ready for account recovery.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Sign-in prompt is not visible | Save an account, enable the assistant, allow the relevant site access, and refresh a supported entry or actual Okta sign-in page. The assistant keeps account settings and password recovery pages dedicated to their original purpose. |
| Resume after canceling | Use the circular-arrow **Retry sign-in** control in the popup. |
| Continue from an entry page or Duo | Confirm Chrome's site access, then start and approve a fresh sign-in in the same tab. Use the method presented by the site for a provider-specific step. |
| Chrome presents its passkey provider | A usable local key and approved flow activate automatic verification. Reload the extension and begin a fresh school sign-in to restore that state. The assistant presents a provider choice for requests assigned to another authenticator. |
| Duo presents a fresh identity check | Complete device verification or choose the Duo method you want to use. Each approved sign-in carries a fresh five-minute authorization window. |

## Development

Requires Node.js 22 or later. The project uses Node's built-in runtime and test modules.

```sh
npm run check                  # Static and documentation checks
npm test                       # Focused UI, localization, and theme tests
npm test -- controller policy  # Run selected test suites
npm run package                # Static checks and packaging
```

For a full test run, use `npm run test:all`. Packaging performs the static checks and creates a source folder, ZIP, and SHA-256 checksum in `dist/`. Run `npm run test:all` before packaging for the full test suite.

The loadable extension is in `extension/`, synthetic tests are in `test/`, and checks and packaging scripts are in `scripts/`. The extension manifest is at the root of `extension/`; `background/` holds the service worker, `pages/` the extension pages, `ui/` shared interface files, `content/` site adapters, `core/` authentication logic, and `icons/` and `locales/` their respective assets.

Further reading: [Architecture](docs/DESIGN.md) · [Testing guide](docs/QA.md) · [Icon artwork](docs/ICON.md) · [Changelog](CHANGELOG.md)

## Independence statement

This extension is an independent project. It is not affiliated with, sponsored by, or endorsed by the University of Chicago, Okta, Duo Security, or any other organization.
