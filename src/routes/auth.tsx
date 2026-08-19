import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Loader2, UtensilsCrossed } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PRODUCT } from "@/config/product";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [{ title: `Sign in — ${PRODUCT.shortName}` }, { name: "robots", content: "noindex,nofollow" }],
  }),
  component: AuthPage,
});

/**
 * Staff sign-in. The credentials contract is the appliance's own
 * `/auth/v1/token` endpoint — there is no external identity provider and no
 * public website to return to.
 */
function AuthPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/admin/restaurant" });
    });
  }, [navigate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    navigate({ to: "/admin/restaurant" });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border bg-card p-8 shadow-sm">
        <p className="inline-flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground">
          <UtensilsCrossed className="size-4 text-primary" /> {PRODUCT.tagline}
        </p>
        <h1 className="mt-3 text-2xl font-semibold">{PRODUCT.name}</h1>
        <p className="mt-1 text-xs text-muted-foreground">Staff terminal sign-in.</p>
        <div className="mt-6 space-y-4">
          <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Email
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-2 w-full rounded-md border bg-background px-4 py-3 text-sm text-foreground outline-none focus:border-primary"
            />
          </label>
          <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Password
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-2 w-full rounded-md border bg-background px-4 py-3 text-sm text-foreground outline-none focus:border-primary"
            />
          </label>
        </div>
        <button
          disabled={loading}
          className="mt-6 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {loading && <Loader2 className="size-4 animate-spin" />} Sign in
        </button>
      </form>
    </div>
  );
}
