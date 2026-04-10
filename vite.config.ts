import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: '/',
  publicDir: 'configure/public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      output: mode === 'production' ? {
        assetFileNames: 'assets/[hash][extname]',
        chunkFileNames: 'assets/[hash].js',
        entryFileNames: 'assets/[hash].js',
      } : {},
    }
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./configure/src"),
    },
  },
}));