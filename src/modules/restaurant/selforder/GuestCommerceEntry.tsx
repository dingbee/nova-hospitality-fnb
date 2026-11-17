import { useEffect } from "react";

export function GuestCommerceEntry({ portalUrl }: { portalUrl: string }) {
  useEffect(() => {
    window.location.replace(portalUrl);
  }, [portalUrl]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-center">
      <p className="text-sm text-muted-foreground">Opening the restaurant menu…</p>
    </main>
  );
}
