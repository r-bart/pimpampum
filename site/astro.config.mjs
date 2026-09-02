// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// The canonical origin. `site` feeds the sitemap, the canonical link and the Open Graph URL in
// src/pages/index.astro, so a page never spells its own address.
export default defineConfig({
  site: 'https://pimpampum.dev',
  integrations: [sitemap()],
});
