import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

if (process.env.VERCEL) process.env.VITE_VERCEL = '1';

export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
