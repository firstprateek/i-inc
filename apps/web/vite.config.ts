import { defineConfig } from "vite";

// In development the API comes from the daemon; in production the daemon serves this build.
export default defineConfig({
  server: { proxy: { "/api": "http://127.0.0.1:7420" } },
  build: { outDir: "dist", emptyOutDir: true },
});
