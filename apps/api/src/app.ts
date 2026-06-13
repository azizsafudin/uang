import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { auth } from "./auth";
import { onboarding } from "./routes/onboarding";

export function createApp() {
  return new Elysia()
    .use(cors({
      origin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
      credentials: true,
    }))
    .get("/health", () => ({ ok: true }))
    .use(onboarding)
    // Mount better-auth's handler at /api/auth/*
    .mount("/api/auth", auth.handler);
}

export type App = ReturnType<typeof createApp>;
