# Project website

The product website lives in `web/`. It introduces Login Assistant for UChicago, demonstrates the sign-in flow, and guides visitors through installation. The production address is `https://uchi-login.songming.org/`.

## Browse locally

Double-click `web/index.html` to open the English website, or `web/zh.html` for Simplified Chinese. Both pages use relative links and local images, styles, and classic JavaScript. The website runs directly from a local folder.

The interactive preview illustrates the assistant's sign-in flow. Confirm plays the sequence, Cancel keeps the visitor in control, and Try it again resets the preview. The download link points to GitHub's source archive; visitors load its `extension/` folder in Chrome.

On HTTP and HTTPS, `/index.html`, `/index`, and `/index/` redirect to the homepage while preserving query parameters and fragments. Homepage links also use the root address. Local-file browsing keeps the original file links. The `web/index/` entry provides the directory route for static hosting.

## Publish with GitHub Pages

1. Commit and push the website and `.github/workflows/pages.yml` to `main`.
2. In the repository's **Settings → Pages → Build and deployment**, choose **GitHub Actions** as the source.
3. Set **Custom domain** to `uchi-login.songming.org`. Configure that subdomain's DNS CNAME to point to `sd800.github.io`.
4. Run **Deploy website to GitHub Pages** from the Actions tab. Subsequent pushes affecting `web/`, its checker, or the workflow deploy automatically.
5. Enable **Enforce HTTPS** when GitHub finishes provisioning the certificate.

The workflow validates the website, then uploads only `web/` as the Pages artifact. Pull requests run validation. Deployment runs from `main` with the `github-pages` environment and GitHub's Pages and identity-token permissions.

Custom domains for Actions-based Pages deployments are configured in repository settings. See GitHub's [custom workflow guide](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) and [custom domain guide](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).

## Maintain the website

- `web/index.html` and `web/zh.html` contain the independently localized content.
- `web/assets/site.css` defines the layout, system appearance, 15px body text, and responsive styles.
- `web/assets/site.js` controls the illustrative preview and address-copy action.
- `web/assets/` also contains the existing phoenix-and-key artwork and favicon.
- `web/robots.txt` and `web/sitemap.xml` use the production domain for search discovery.

Run `npm run check:web` after website edits. It checks local resources, fragments, language structure, JavaScript syntax, offline dependencies, and deployment scope. Check the English and Chinese pages at desktop and narrow widths in light and dark appearances, including local-file browsing and reduced-motion settings.

Keep the website's feature and security statements aligned with the extension. Update both language pages together, using natural wording for each audience.
