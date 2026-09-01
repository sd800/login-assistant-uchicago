# Changelog

[Simplified Chinese](CHANGELOG_zh.md)

Changes by release, newest first.

## 1.6.17 - 2026-09-01

### Changed

- Refined privacy and data-protection guidance across the interface and documentation.

### Verification

- Focused interface and localization tests pass together with the static checks.

## 1.6.16 - 2026-08-29

### Changed

- Expanded the README introduction with the recurring Okta and Duo sign-in friction behind the project and how the extension streamlines that process.
- Simplified the Local data note to state what uninstalling the extension removes.

### Verification

- Static checks pass for README parity, version metadata, localization, and the manifest.

## 1.6.15 - 2026-08-29

### Changed

- Updated the extension description to emphasize a simpler and faster UChicago account sign-in.

### Verification

- Static checks pass for the manifest, version metadata, localization, and documentation.

## 1.6.13 - 2026-08-29

### Changed

- Verification PIN settings now show concise usage guidance and load the saved-state encryption note only after the section is opened.

### Verification

- All 62 focused Settings interface, localization, and theme tests pass.

## 1.6.12 - 2026-08-29

### Changed

- The Account encryption note now states that both the username and password are securely saved.

## 1.6.11 - 2026-08-29

### Changed

- Settings now explains the local encryption and explicitly authorized use of passwords and passkeys according to their saved state.

### Verification

- All 62 focused Settings interface, localization, and theme tests pass.

## 1.6.10 - 2026-08-29

### Added

- Added a concise destination line to the UChicago account sign-in confirmation.

### Changed

- Standardized second-person wording throughout the Simplified Chinese interface and documentation.

### Verification

- The focused confirmation and localization tests pass together with the static checks.

## 1.6.9 - 2026-08-29

### Changed

- Confirming sign-in on the my.UChicago portal now opens the fixed AIS student endpoint immediately, without waiting for the portal page or its navigation controls to render.
- Okta account fields and exact structural submit controls can now be processed as soon as they enter the active DOM, while hidden templates, recovery forms, one-time codes, errors, and ambiguous controls remain excluded.
- Expanded additive Chinese handling for Duo screens and added language-independent recognition of the method list and Manage devices control.

### Fixed

- Aligned each saved passkey account name and its **Current account** label on the same text line.

### Verification

- All 213 focused interface, localization, controller, passkey bridge, and page-adapter tests pass.

## 1.6.8 - 2026-08-29

### Added

- Added guided Duo passkey setup after saving an account, including a fresh school sign-in, device management, identity-verification guidance, registration confirmation, and return to login.
- Added direct sign-in confirmation for the HTTP and HTTPS my.UChicago homepage, plus supported portal, Courses, Okta application, and third-party application entry flows.
- Added automatic handling for Duo's remembered-device confirmation when it appears after verification.

### Changed

- A usable passkey for the saved account now keeps automatic Duo verification enabled. Without a usable key, Duo verification remains manual.
- Reworked **Duo & passkeys** to show the current verification method, account-linked passkeys, invalid status, and user-controlled deletion. The setup action is hidden while a usable key exists.
- Improved Okta and Duo page handling across redirects, delayed controls, changing Duo subdomains, and English or Simplified Chinese interfaces.
- Limited recent activity to 20 entries from the past 24 hours and opened Settings automatically after first installation.

### Fixed

- Intercepted compatible Duo Security Key requests before Chrome's passkey provider opens, including when Duo starts with another remembered verification method.
- Kept passkeys that Duo explicitly rejects, marked them **Invalid**, and added a guided replacement path without deleting local keys automatically.
- Prevented an English interface flash when a saved language is Simplified Chinese.

### Verification

- All 200 focused interface, localization, controller, passkey bridge, and page-adapter tests pass, together with the static checks.

## 0.2.11 - 2026-08-28

### Changed

- Improved initial language selection while preserving saved choices.
- Adjusted the settings wordmark text size.

### Fixed

- Prevented English text from briefly appearing before the saved language in settings, the popup, and confirmation windows.
- Kept the tab title neutral until localization is ready and preserved a usable page if the language preference cannot be read.

### Verification

- All 48 focused interface, localization, and theme tests pass, together with the selected data-reset regression. Coverage includes language defaults, saved choices, delayed reads, read failures, and concurrent changes.

## 0.2.10 - 2026-08-28

### Changed

- Rewrote both READMEs as repository guides covering installation, everyday use, passkey setup, privacy, permissions, and troubleshooting.
- Reworked Chinese settings, confirmations, controls, activity messages, and help text for more natural wording.
- Adjusted the settings wordmark text size.
- Refreshed the settings getting-started steps for school and third-party services, automatic Duo handling, and passkey registration.
- Matched the spacing above and below the version line in the settings footer.

### Verification

- All 43 focused interface, localization, and theme tests pass.

## 0.2.9 - 2026-08-28

### Changed

- Removed manual Duo URL setup and per-site status. Duo authorization follows the approved school sign-in flow across subdomains and HTTPS intermediaries.
- Supported third-party referring applications and destinations, including flows that return to an application without reaching Duo.
- Prepared Duo adapters before page scripts, with a bounded navigation handshake and native fallback outside approved flows.
- Retained only the past 24 hours of activity, up to 20 entries, with automatic local deletion and live settings updates.
- Adjusted the settings wordmark text size.

### Verification

- Focused flow, adapter, interface, localization, policy, and theme checks pass.

## 0.2.8 - 2026-08-28

### Changed

- Enlarged the settings header logo from 32px to 64px and increased the gap beside the wordmark to 14px.
- Updated the bilingual README and icon notes with the current display sizes.
- Removed the "For this tab only." line from the sign-in confirmation window and its Chinese translation.

### Verification

- All 9 focused theme checks and static checks pass.

## 0.2.7 - 2026-08-28

### Changed

- Replaced the archived Chinese README with a fully localized guide to the current release, aligned with English coverage and current Chinese interface labels.
- Expanded the setup, permissions, privacy, keyboard controls, and development instructions in both READMEs.
- Added lightweight README checks for section structure, tables, code literals, commands, and link destinations.
- Added a standalone independence statement at the end of both READMEs covering affiliation, sponsorship, and endorsement.

### Verification

- Static and focused documentation checks pass.

## 0.2.6 - 2026-08-28

### Added

- Added Enter/Space confirmation and Esc cancellation to the existing confirmation window, with accessible button shortcut metadata.
- Added a localized keyboard reminder on a separate line after the existing text in the collapsed Details section.

### Behavior

- Kept native Enter/Space behavior for inputs, passkey selection, other buttons, and the Details disclosure. Confirmation shortcuts ignore composition, modifier combinations, synthetic events, and held-key repeats.
- Routed shortcuts through the existing decision flow, retaining required PIN validation, disabled states, request expiry, and protection against duplicate in-flight decisions. Esc can close unavailable or expired requests.

### Verification

- All 33 focused UI and localization tests pass across two suites.

## 0.2.5 - 2026-08-28

### Changed

- Set Chinese interface tracking to `0.04em` and English tracking to `normal` across settings, the popup, and confirmation pages, including headings and form controls.
- Scaled saved-account and passkey indicators to the same 18px width as the header actions. The horizontal card keeps its proportions at about 13.8px high instead of appearing oversized.
- Removed the negative heading tracking. Tracking follows the selected language immediately and is computed using each element's own font size.
- Marked English brand text and each native-language option explicitly so they retain the correct typography within either interface language.
- Documented that Chrome-owned dialogs and native tooltips control their own typography and cannot be styled by the extension.

### Verification

- All 24 focused typography, theme, and localization tests pass.

## 0.2.4 - 2026-08-28

### Changed

- Redrew the saved-account indicator as a 26-by-20-pixel horizontal card with a larger circular portrait, an open shoulder outline, and separated account/password details.
- Preserved each status icon's intrinsic SVG proportions and disabled flex shrinking instead of assigning every icon the same square dimensions.
- Unified both settings save buttons as **Save**, with section-specific help text and matching Chinese labels.
- Reordered the bilingual footer wording to sponsorship before endorsement.
- Changed the power tooltip to state both the current enabled state and the click action. Concise English applies to these two tooltip strings only.

### Added

- Added a collapsed bilingual Privacy section to the Settings help column.

### Verification

- All 35 focused UI, localization, and theme tests pass, including an aspect-ratio regression check for the status icons.
- Inspected isolated light/dark SVG previews of the account card at native and 4x scales; reviewed the privacy copy against the local implementation.

## 0.2.3 - 2026-08-28

### Changed

- Reduced the popup width from 320px to 280px, tightened vertical spacing, and used a single-line brand header. The 28px Power, Retry sign-in, and Settings controls remain keyboard accessible; the popup height follows its content.
- Added separate account-card and key indicators for a saved account/password pair and locally saved passkeys. Each appears only when the corresponding data exists, independently of passkey selection or Duo configuration.
- Hid the Duo status line unless a Duo site is configured.
- Extended the affiliation, endorsement, and sponsorship disclaimer to cover any other organization, in both interface languages.
- Refined the Local data controls and related copy in both interface languages.

### Added

- Added `CHANGELOG_zh.md` with the complete version history and links between the two languages.
- Included both changelogs in release packages and added a check that their version/date sequences match.

### Verification

- All 116 local tests and static checks pass, including independent saved-data indicators, hidden unconfigured Duo status, and deletion confirmation/cancellation.

## 0.2.2 - 2026-08-28

### Changed

- Replaced the popup's separate on/off switch row with a power icon in the header, to the left of Retry sign-in and Settings.
- Kept immediate state saving, repeat-click protection, and recovery after a failed update. A maroon background indicates enabled; a gray outline icon indicates paused.
- Retained keyboard access, accessible switch state, and English and Chinese action tooltips without adding visible labels.

### Added

- Added this changelog to the source and release package.
- Added a release check that requires the package version, extension version, and newest changelog entry to agree.

### Verification

- All 114 local tests and static checks pass, including icon order, saved power state, and localized tooltips.

## 0.2.1 - 2026-08-28

### Changed

- Restored a two-column settings page with configuration on the left and help on the right. Saved passkeys and verification PIN remain collapsed by default.
- Separated Save account from Save settings. Saving either section preserves drafts in the other section; account changes require a password and clear only the selected passkey association.
- Added an immediately saved popup on/off switch and icon controls for Settings and Retry sign-in. Reduced Duo status to a single line without an empty passkey count.
- Standardized interactive red at `#800000` in both system appearances, with readable text, control borders, and focus indicators.
- Added an explicit settings footer stating that the project is not affiliated with, endorsed by, or sponsored by the University of Chicago, Okta, or Duo Security.
- Updated English and Chinese interface copy together.

### Verification

- Expanded the local suite to 114 passing tests, including independent saves, draft preservation, toggle persistence, and error recovery.

## 0.2.0 - 2026-08-28

### Added

- Added confirmation on `https://portal.uchicago.edu/ais/`, followed by the Student my.UChicago sign-in link.
- Added confirmation on `https://courses.uchicago.edu/`, followed by the fixed Canvas `/login/1` endpoint.
- Added the corresponding portal and Courses site permissions while retaining exact entry-route restrictions.

### Changed

- Improved recognition of Okta application sign-in forms under `/app/*`, including delayed identifier, password, and combined forms.
- Carried approved entry flows through their fixed launch endpoints in the same tab without a duplicate Okta confirmation. Retained approval expiry and restrictions on credential release.
- Simplified the bilingual settings, popup, and confirmation interfaces; removed the redundant popup storage footer.

### Verification

- Expanded the local suite to 98 passing tests, including entry routing, delayed forms, cancellation, and revoked site access.

## 0.1.0 - 2026-08-28

### Added

- Packaged the initial release with confirmation before recognized Okta sign-in steps and local account storage.
- Added a local software passkey provider for a configured Duo site, with explicit consent and verification PIN support.
- Added default US English and selectable Simplified Chinese, with shared language preferences and automatic system light/dark appearance.
- Added the maroon phoenix-and-key icon with transparent rounded corners and explicit Okta and Duo site permissions.

### Verification

- The saved release included 72 passing local tests.
