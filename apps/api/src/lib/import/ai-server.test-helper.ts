// A throwaway OpenAI-compatible server for tests. startMockAi(content) returns a server whose
// /chat/completions echoes `content` as the assistant message. Caller calls .stop().
export function startMockAi(content: unknown, opts?: { status?: number; bad?: boolean }) {
  const server = Bun.serve({
    port: 0, // ephemeral
    async fetch(req) {
      if (!req.url.endsWith("/chat/completions")) return new Response("nope", { status: 404 });
      if (opts?.status && opts.status !== 200) return new Response("err", { status: opts.status });
      if (opts?.bad) return new Response("not json", { status: 200 });
      const message = { role: "assistant", content: JSON.stringify(content) };
      return Response.json({ choices: [{ message }] });
    },
  });
  return { baseUrl: `http://localhost:${server.port}/v1`, stop: () => server.stop(true) };
}
