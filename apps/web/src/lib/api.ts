import { treaty } from "@elysiajs/eden";
import type { App } from "../../../api/src/eden";

const url = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
// parseDate:false — Eden otherwise revives any date-like string (incl. plain
// "YYYY-MM-DD") into a Date object, diverging from our `string` response types.
// That broke the net-worth chart (recharts received Date objects on its axis).
export const api = treaty<App>(url, { fetch: { credentials: "include" }, parseDate: false });
