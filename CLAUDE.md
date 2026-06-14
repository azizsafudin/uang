# uang — project instructions

## Type safety (STRICT)

**Never use `as any`.** It is banned in this codebase — no exceptions in app/library code.

When you hit a type you can't satisfy:
- Model it correctly. If `insert()` takes a partial, build a complete object or give the type the optional fields it needs.
- Build explicit payloads that match the target schema exactly, rather than casting a wider object through.
- If you must narrow an external/UI value, assert to the **specific** type (`x as "asset" | "liability"`), never to `any`.
- Reach for `unknown` + a type guard when a value is genuinely dynamic.

Avoid `any` generally (prefer precise types). The one tolerated spot is Elysia route-handler context destructuring (`async ({ body, set }: any) => …`), an existing convention where typing the context is impractical — do not add new ones beyond that pattern.

## Stack notes
- Monorepo: `apps/api` (Elysia + Drizzle + libsql/SQLite), `apps/web` (React + TanStack Router/Query/DB), `packages/shared`. Runtime: Bun.
- Client/server share end-to-end types via Eden treaty (`apps/web/src/lib/api.ts` ← `apps/api/src/eden`).
- UI components: add shadcn components via the shadcn CLI.
