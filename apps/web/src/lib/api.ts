import { treaty } from "@elysiajs/eden";
import type { App } from "../../../api/src/eden";

// Same-origin in production (the API serves this SPA under one domain), so the
// base is `${origin}/api`. In dev, VITE_API_URL points at the cross-origin API
// (http://localhost:3000). The `/api` prefix matches where the server mounts the
// API; the typed routes themselves stay root-relative (api.accounts…).
const base = import.meta.env.VITE_API_URL || window.location.origin;
// parseDate:false — Eden otherwise revives any date-like string (incl. plain
// "YYYY-MM-DD") into a Date object, diverging from our `string` response types.
// That broke the net-worth chart (recharts received Date objects on its axis).
export const api = treaty<App>(`${base}/api`, { fetch: { credentials: "include" }, parseDate: false });
