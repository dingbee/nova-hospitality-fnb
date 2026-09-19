export default function handler(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      service: "lexibite-api",
      version: "v1",
      runtime: "vercel-function",
      timestamp: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}
