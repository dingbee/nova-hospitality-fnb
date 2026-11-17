import { createFileRoute, Link } from "@tanstack/react-router";
import { MailCheck } from "lucide-react";
import { PRODUCT } from "@/config/product";

export const Route = createFileRoute("/auth_/sign-up")({
  head: () => ({
    meta: [
      { title: `Access by invitation — ${PRODUCT.shortName}` },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: SignUpPage,
});

function SignUpPage() {
  return (
    <main className="min-h-screen bg-[#f7f8f5] text-[#172019]">
      <div className="mx-auto flex min-h-screen w-full max-w-[620px] items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full rounded-2xl border border-[#dfe4df] bg-white p-8 text-center shadow-[0_18px_50px_rgba(23,61,34,0.08)] sm:p-10">
          <img
            src="/brand/lexibite-wordmark.svg"
            alt="LexiBite"
            className="mx-auto h-10 w-auto max-w-[11rem] object-contain"
          />
          <div className="mx-auto mt-8 flex size-12 items-center justify-center rounded-full bg-[#2f7139]/10 text-[#2f7139]">
            <MailCheck className="size-6" />
          </div>
          <p className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-[#55705a]">
            {PRODUCT.tagline}
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.025em]">
            Access is by invitation
          </h1>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-[#667069]">
            LexiBite is commercially provisioned. New customer owners do not create accounts
            themselves. Your LexiBite administrator must first issue access to your email address.
          </p>
          <div className="mt-7 rounded-xl border border-[#edf0ed] bg-[#f7f8f5] p-4 text-left text-sm text-[#59645d]">
            <p className="font-semibold text-[#172019]">Already onboarded?</p>
            <p className="mt-1 leading-6">
              Open the invitation email sent to your authorized address and follow its activation
              link. You will be taken directly into your provisioned workspace.
            </p>
          </div>
          <Link
            to="/auth"
            className="mt-7 inline-flex h-11 items-center justify-center rounded-lg bg-[#2f7139] px-6 text-sm font-semibold text-white transition hover:bg-[#275f30]"
          >
            Sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
