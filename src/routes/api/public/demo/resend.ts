import { createFileRoute } from "@tanstack/react-router";
import { handleDemoPublicApi } from "@/modules/lexibite-demo/http.server";

async function dispatch(request: Request): Promise<Response> {
  return (await handleDemoPublicApi(request)) ?? new Response("Not found.", { status: 404 });
}

export const Route = createFileRoute("/api/public/demo/resend")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => dispatch(request),
      POST: async ({ request }) => dispatch(request),
    },
  },
});
