import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Loader2, UtensilsCrossed } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PRODUCT } from "@/config/product";

export const Route = createFileRoute("/auth_/sign-up")({
  head: () => ({
    meta: [
      { title: `Create your account — ${PRODUCT.shortName}` },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: SignUpPage,
});

/**
 * P12 §6 — self-serve account creation for a brand-new restaurant owner.
 * Mirrors /auth's visual language exactly (same card, same input styling)
 * so a first-time visitor sees one consistent system, not a different
 * "marketing" look bolted onto the product. On success, Supabase either
 * returns a session immediately (email confirmation disabled) or requires
 * confirmation first (data.session is null) — both are handled explicitly
 * rather than assuming one.
 */
function SignUpPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/onboarding" });
    });
  }, [navigate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      toast.error("Your password needs to be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      toast.error("Those passwords don't match.");
      return;
    }
    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/onboarding` },
    });
    setLoading(false);
    if (error) {
      // Supabase returns a generic message for an email already registered
      // (to avoid account enumeration) — pass it through as-is rather than
      // guessing at a friendlier one we can't actually verify.
      toast.error(error.message);
      return;
    }
    if (!data.session) {
      // Email confirmation is required before a session exists.
      setAwaitingConfirmation(true);
      return;
    }
    navigate({ to: "/onboarding" });
  };

  if (awaitingConfirmation) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
        <div className="w-full max-w-sm rounded-xl border bg-card p-8 text-center shadow-sm">
          <p className="inline-flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground">
            <UtensilsCrossed className="size-4 text-primary" /> {PRODUCT.tagline}
          </p>
          <h1 className="mt-3 text-xl font-semibold">Check your email</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            We sent a confirmation link to{" "}
            <span className="font-medium text-foreground">{email}</span>. Open it to activate your
            account and start setting up your restaurant.
          </p>
          <Link
            to="/auth"
            className="mt-6 inline-block text-sm font-medium text-primary hover:underline"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border bg-card p-8 shadow-sm">
        <p className="inline-flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground">
          <UtensilsCrossed className="size-4 text-primary" /> {PRODUCT.tagline}
        </p>
        <h1 className="mt-3 text-2xl font-semibold">Create your account</h1>
        <p className="mt-1 text-xs text-muted-foreground">You'll set up your restaurant next.</p>
        <div className="mt-6 space-y-4">
          <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Email
            <input
              type="email"
              required
              autoComplete="email"
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
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-2 w-full rounded-md border bg-background px-4 py-3 text-sm text-foreground outline-none focus:border-primary"
            />
            <span className="mt-1 block text-[11px] font-normal normal-case text-muted-foreground">
              At least 8 characters.
            </span>
          </label>
          <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Confirm password
            <input
              type="password"
              required
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="mt-2 w-full rounded-md border bg-background px-4 py-3 text-sm text-foreground outline-none focus:border-primary"
            />
          </label>
        </div>
        <button
          disabled={loading}
          className="mt-6 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {loading && <Loader2 className="size-4 animate-spin" />} Create account
        </button>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Already have an account?{" "}
          <Link to="/auth" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
