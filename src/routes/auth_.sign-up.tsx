import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PRODUCT } from "@/config/product";
import { presentUserFacingError } from "@/lib/errors/present-error";

export const Route = createFileRoute("/auth_/sign-up")({
  head: () => ({
    meta: [
      { title: `Create your restaurant account — ${PRODUCT.shortName}` },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: SignUpPage,
});

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
      email: email.trim(),
      password,
      options: { emailRedirectTo: `${window.location.origin}/onboarding` },
    });
    setLoading(false);
    if (error) {
      toast.error(presentUserFacingError(error, "Sign-up failed.").message);
      return;
    }
    if (!data.session) {
      setAwaitingConfirmation(true);
      return;
    }
    navigate({ to: "/onboarding" });
  };

  if (awaitingConfirmation) {
    return (
      <main className="min-h-screen bg-[#f7f8f5] text-[#172019]">
        <div className="mx-auto flex min-h-screen w-full max-w-[560px] items-center justify-center px-5 py-10 sm:px-8">
          <div className="w-full rounded-2xl border border-[#dfe4df] bg-white p-8 text-center shadow-[0_18px_50px_rgba(23,61,34,0.08)]">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#55705a]">{PRODUCT.tagline}</p>
            <h1 className="mt-3 text-2xl font-semibold">Check your email</h1>
            <p className="mt-2 text-sm leading-6 text-[#667069]">
              We sent a confirmation link to <span className="font-medium">{email}</span>. Open it
              to activate your account and start setting up your restaurant.
            </p>
            <Link to="/auth" className="mt-6 inline-block text-sm font-semibold text-[#2f7139] hover:underline">
              Back to sign in
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#f7f8f5] text-[#172019]">
      <div className="mx-auto grid min-h-screen w-full max-w-[1280px] lg:grid-cols-[1.05fr_0.95fr]">
        <section className="relative hidden overflow-hidden bg-[#173d22] px-12 py-12 text-white lg:flex lg:flex-col lg:justify-between xl:px-16">
          <div className="absolute -right-32 -top-32 h-80 w-80 rounded-full border-[56px] border-white/5" />
          <div className="absolute -bottom-40 -left-32 h-96 w-96 rounded-full border-[70px] border-[#d7a653]/10" />
          <div className="relative z-10">
            <img src="/brand/lexibite-wordmark.svg" alt="LexiBite" className="h-11 w-auto max-w-[12rem] object-contain object-left" />
          </div>
          <div className="relative z-10 max-w-xl pb-8">
            <p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-[#d7a653]">{PRODUCT.tagline}</p>
            <h1 className="max-w-lg text-4xl font-semibold leading-[1.08] tracking-[-0.03em] xl:text-5xl">
              Set up your restaurant operating workspace.
            </h1>
            <p className="mt-6 max-w-md text-sm leading-7 text-white/70">
              Create the owner account first. You’ll configure your restaurant and invite your team during onboarding.
            </p>
          </div>
          <div className="relative z-10 text-xs text-white/50">{PRODUCT.name} · Restaurant administration</div>
        </section>

        <section className="flex min-h-screen items-center justify-center px-5 py-10 sm:px-8 lg:px-12 xl:px-16">
          <div className="w-full max-w-md">
            <div className="mb-8 lg:hidden">
              <img src="/brand/lexibite-wordmark.svg" alt="LexiBite" className="h-10 w-auto max-w-[11rem] object-contain object-left" />
              <p className="mt-3 text-xs font-semibold uppercase tracking-[0.18em] text-[#55705a]">{PRODUCT.tagline}</p>
            </div>

            <div className="mb-8">
              <p className="text-sm font-medium text-[#55705a]">Restaurant owner</p>
              <h2 className="mt-2 text-3xl font-semibold tracking-[-0.025em]">Create your account</h2>
              <p className="mt-2 text-sm leading-6 text-[#667069]">
                Your account is the first step. Restaurant setup comes next.
              </p>
            </div>

            <form onSubmit={submit} className="rounded-2xl border border-[#dfe4df] bg-white p-6 shadow-[0_18px_50px_rgba(23,61,34,0.08)] sm:p-8">
              <div className="space-y-5">
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[#59645d]">Email address</span>
                  <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)}
                    placeholder="owner@restaurant.com"
                    className="mt-2 h-12 w-full rounded-lg border border-[#d5dbd6] bg-white px-4 text-sm text-[#172019] outline-none transition placeholder:text-[#9aa39d] focus:border-[#2f7139] focus:ring-4 focus:ring-[#2f7139]/10" />
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[#59645d]">Password</span>
                  <input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}
                    className="mt-2 h-12 w-full rounded-lg border border-[#d5dbd6] bg-white px-4 text-sm text-[#172019] outline-none transition focus:border-[#2f7139] focus:ring-4 focus:ring-[#2f7139]/10" />
                  <span className="mt-1 block text-[11px] text-[#78817b]">At least 8 characters.</span>
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[#59645d]">Confirm password</span>
                  <input type="password" required minLength={8} autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                    className="mt-2 h-12 w-full rounded-lg border border-[#d5dbd6] bg-white px-4 text-sm text-[#172019] outline-none transition focus:border-[#2f7139] focus:ring-4 focus:ring-[#2f7139]/10" />
                </label>
              </div>

              <button type="submit" disabled={loading}
                className="mt-7 inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#2f7139] px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#275f30] focus:outline-none focus:ring-4 focus:ring-[#2f7139]/20 disabled:cursor-not-allowed disabled:opacity-60">
                {loading && <Loader2 className="size-4 animate-spin" />}
                {loading ? "Creating account…" : "Create restaurant account"}
              </button>

              <p className="mt-6 border-t border-[#edf0ed] pt-5 text-center text-xs text-[#78817b]">
                Already have an account?{" "}
                <Link to="/auth" className="font-semibold text-[#2f7139] hover:underline">Sign in</Link>
              </p>
            </form>

            <p className="mt-7 text-center text-[11px] text-[#8a928c]">{PRODUCT.name} · Restaurant administration</p>
          </div>
        </section>
      </div>
    </main>
  );
}
