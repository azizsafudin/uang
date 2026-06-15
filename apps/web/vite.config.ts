import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: {
    port: 5173,
    // Mirror production's single origin in dev: the browser only ever talks to
    // :5173, and `/api` is proxied to the API process on :3000. So the SPA uses
    // its own origin (no VITE_API_URL), there's no CORS, and session cookies are
    // first-party to :5173 — same model as the deployed single service.
    // changeOrigin:false keeps the Host as localhost:5173, so better-auth infers
    // the origin the browser actually uses.
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: false },
    },
  },
});
