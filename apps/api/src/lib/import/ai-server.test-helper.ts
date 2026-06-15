// A throwaway OpenAI-compatible server for tests. startMockAi(content) returns a server whose
// /chat/completions echoes `content` as the assistant message. Caller calls .stop().
// rawContent: send `content` verbatim as the message string (e.g. to simulate a model
// that wraps JSON in ``` code fences) instead of JSON.stringify-ing it.
export function startMockAi(content: unknown, opts?: { status?: number; bad?: boolean; rawContent?: boolean }) {
  const server = Bun.serve({
    port: 0, // ephemeral
    async fetch(req) {
      if (!req.url.endsWith("/chat/completions")) return new Response("nope", { status: 404 });
      if (opts?.status && opts.status !== 200) return new Response("err", { status: opts.status });
      if (opts?.bad) return new Response("not json", { status: 200 });
      const text = opts?.rawContent ? String(content) : JSON.stringify(content);
      const message = { role: "assistant", content: text };
      return Response.json({ choices: [{ message }] });
    },
  });
  return { baseUrl: `http://localhost:${server.port}/v1`, stop: () => server.stop(true) };
}
