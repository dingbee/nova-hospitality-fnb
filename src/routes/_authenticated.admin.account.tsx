import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, KeyRound, LogOut, UserRound } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { usePrincipal } from "@/lib/rbac/usePermissions";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated/admin/account")({
  head: () => ({
    meta: [
      { title: "My Account — Restaurant & Bar OS" },
      { name: "description", content: "Manage your account credentials and active session." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: AccountPage,
});

function AccountPage() {
  const principal = usePrincipal();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const email = principal.data?.email ?? "";

  const updatePassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    setError(null);

    if (!currentPassword) {
      setError("Enter your current password.");
      return;
    }
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation do not match.");
      return;
    }
    if (!email) {
      setError("Your account identity could not be loaded. Refresh and try again.");
      return;
    }

    setSaving(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password: currentPassword,
      });
      if (signInError) throw signInError;

      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
      });
      if (updateError) throw updateError;

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setMessage("Password updated successfully.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update your password.");
    } finally {
      setSaving(false);
    }
  };

  if (principal.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading account…</div>;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="My account"
        description="Manage your account credentials and current session."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Account">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <UserRound className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{email || "—"}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {principal.data?.roles?.length
                  ? principal.data.roles.join(" · ")
                  : "Authenticated account"}
              </p>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Session">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <LogOut className="size-5" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">Authenticated</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Your session is protected by the existing authentication and authorization layer.
              </p>
            </div>
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Change password" description="Confirm your current password before setting a new one.">
        <form onSubmit={updatePassword} className="max-w-xl space-y-4">
          <label className="block text-sm">
            <span className="font-medium">Current password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              className="mt-2 w-full rounded-md border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary"
              disabled={saving}
            />
          </label>

          <label className="block text-sm">
            <span className="font-medium">New password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              className="mt-2 w-full rounded-md border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary"
              disabled={saving}
            />
          </label>

          <label className="block text-sm">
            <span className="font-medium">Confirm new password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              className="mt-2 w-full rounded-md border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary"
              disabled={saving}
            />
          </label>

          {error && (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          {message && (
            <p role="status" className="flex items-center gap-2 rounded-md border border-primary/20 bg-primary/10 px-3 py-2 text-sm text-primary">
              <CheckCircle2 className="size-4" />
              {message}
            </p>
          )}

          <button
            type="submit"
            disabled={saving}
            className="inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <KeyRound className="size-4" />
            {saving ? "Updating…" : "Update password"}
          </button>
        </form>
      </SectionCard>
    </div>
  );
}
