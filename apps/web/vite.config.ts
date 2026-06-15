import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: {
    // Defaults match the single-stack dev setup; override WEB_PORT / API_PROXY_TARGET
    // to run an isolated stack (e.g. a second worktree) without clashing.
    port: Number(process.env.WEB_PORT ?? 5173),
    // Mirror production's single origin in dev: the browser only ever talks to the
    // web port, and `/api` is proxied to the API process. So the SPA uses its own
    // origin (no VITE_API_URL), there's no CORS, and session cookies are first-party
    // to the web origin — same model as the deployed single service.
    // changeOrigin:false keeps the Host as the browser's origin, so better-auth
    // infers the origin the browser actually uses.
    proxy: {
      "/api": { target: process.env.API_PROXY_TARGET ?? "http://localhost:3000", changeOrigin: false },
    },
  },
});
