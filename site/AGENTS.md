# Working on the site

This directory is the public landing page for Pimpampum. Read the repository's `CLAUDE.md` first;
its rules apply here. `CLAUDE.md` in this directory is a symbolic link to this file.

- Keep the install story identical to the root `README.md`: the macOS app and
  `omarchy plugin add` first, the npm package under "advanced".
- Never write a version literal in `src/pages/index.astro`; it imports `package.json`.
- `public/llms.txt` must say what `docs/agents.md` says: an agent stops and asks the operator, and
  never runs `pimpampum install` unattended.
- Run `npm run build` before finishing. `astro dev --background` starts the dev server; stop it with
  `astro dev stop`.
