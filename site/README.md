# Pimpampum site

The landing page at <https://pimpampum.dev>, built with Astro. One page, `src/pages/index.astro`,
plus `public/llms.txt` for agents and `public/robots.txt`.

The version shown on the page is read from the repository's `package.json` at build time.
`scripts/check-release-versions.mjs` fails a release if the page spells a version literally.

```bash
npm ci
npm run dev      # local server at http://localhost:4321
npm run build    # static output in dist/
npm run preview
```

Node.js 22.12 or newer. The site has no runtime dependency on the daemon; it links to GitHub
Releases, npm and the Omarchy plugin mirror.
