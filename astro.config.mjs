// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://nadinekay.com', // TODO: update to real production domain before deploy
  vite: { plugins: [tailwindcss()] },
  integrations: [sitemap()],
});
