import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://www.videocompressonline.com',
  output: 'server',
  adapter: node({
    mode: 'standalone',
  }),
  integrations: [
    sitemap({
      // Exclude error pages from the sitemap — they shouldn't be indexed
      filter: (page) => !/(\/400|\/403|\/404|\/500)/.test(page),
    }),
  ],
  vite: {
    plugins: [
      tailwindcss()
    ],
    optimizeDeps: {
      exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
    },
    server: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      },
    },
  },
});
