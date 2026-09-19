import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { activateDemoSessionFn } from "@/modules/lexibite-demo/session.functions";
import { PRODUCT } from "@/config/product";
import { LexiBiteLoader } from "@/components/brand/LexiBiteLoader";

export const Route = createFileRoute("/lexibite/demo/activate")({
  ssr: false,
  head: () => ({
    meta: [
      { title: `Launching your demo — ${PRODUCT.shortName}` },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: DemoActivatePage,
});

/**
 * P02.3/P02.4 — landing page for the verification link Nolmark/Lovable
 * indirectly triggers (registerDemoProspect emails a Supabase-issued
 * action link redirecting here). supabase-js's default
 * `detectSessionInUrl: true` establishes the session from the URL itself;
 * this page only has to wait for that, then call the one server function
 * that turns "verified" into "a real, least-privilege demo session" —
 * everything authorization-relevant happens server-side in
 * activateDemoSessionFn, never here.
 */
function DemoActivatePage() {
  const navigate = useNavigate();
  const activate = useServerFn(activateDemoSessionFn);
  const [status, setStatus] = useState<"working" | "error">("working");
  const [message, setMessage] = useState("Verifying your email…");
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        setStatus("error");
        setMessage("This link is invalid or has expired. Please request a new demo link.");
        return;
      }
      try {
        const result = await activate({});
        navigate({ to: result.selfOrderUrl ?? result.launchUrl });
      } catch (e) {
        setStatus("error");
        setMessage(
          e instanceof Error ? e.message : "Couldn't start your demo session. Please try again.",
        );
      }
    })();
  }, [activate, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-sm rounded-xl border bg-card p-8 text-center shadow-sm">
        <img src="/brand/lexibite-wordmark.svg" alt={PRODUCT.name} className="mx-auto h-8 w-auto" />
        <p className="mt-2 text-xs uppercase tracking-widest text-muted-foreground">
          {PRODUCT.tagline}
        </p>
        <h1 className="mt-3 text-xl font-semibold">
          {status === "working" ? "Launching your demo" : "Couldn't launch your demo"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        {status === "working" && <LexiBiteLoader size="md" className="mx-auto mt-6" />}
      </div>
    </div>
  );
}
