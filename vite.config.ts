import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  // Local development and Cloudflare Pages serve from the domain root.
  // GitHub Pages builds opt in explicitly with `--mode github-pages`.
  base: mode === 'github-pages' ? '/HUNTZONE/' : '/',
  plugins: [react()],
  test: { environment: 'jsdom' },
}));
