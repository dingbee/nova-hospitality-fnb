import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { KeyRound, LockKeyhole, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NovaShell } from "@/components/shell/NovaShell";
import { getStaffAccessBootstrapFn } from "../staff-access.functions";
import { startPosSessionFn, endPosSessionFn } from "@/modules/restaurant/sales/pos-session.functions";
import { RESTAURANT_ROLE_LABELS } from "../permissions";\nimport { StaffAccessSessionContext, type StaffAccessSessionValue } from "../staff-access-context";

type ActiveStaffSession = {
  sessionId: string;
  tenantId: string;
  propertyId: string;
  staffUserId: string;
  staffMemberId: string;
  role: string;
  terminalId: string;
  expiresAt: string;
};

const SESSION_COOKIE = "lexibite_staff_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;

type StaffWorkspaceLink = { label: string; path: string };

const STAFF_WORKSPACES: Record<string, { title: string; defaultPath: string; links: StaffWorkspaceLink[] }> = {
  bartender: {
    title: "Bar & POS",
    defaultPath: "/admin/restaurant/pos",
    links: [{ label: "POS", path: "/admin/restaurant/pos" }],
  },
  chef: {
    title: "Kitchen",
    defaultPath: "/admin/restaurant/kitchen",
    links: [
      { label: "Kitchen", path: "/admin/restaurant/kitchen" },
      { label: "Menu", path: "/admin/restaurant/menu" },
      { label: "Inventory", path: "/admin/restaurant/inventory" },
    ],
  },
  kitchen_manager: {
    title: "Kitchen Operations",
    defaultPath: "/admin/restaurant/kitchen",
    links: [
      { label: "Kitchen", path: "/admin/restaurant/kitchen" },
      { label: "Menu", path: "/admin/restaurant/menu" },
      { label: "Inventory", path: "/admin/restaurant/inventory" },
    ],
  },
  inventory_manager: {
    title: "Inventory",
    defaultPath: "/admin/restaurant/inventory",
    links: [
      { label: "Inventory", path: "/admin/restaurant/inventory" },
      { label: "Stock", path: "/admin/restaurant/stock" },
      { label: "Inventory Control", path: "/admin/restaurant/inventory-control" },
    ],
  },
  purchasing_officer: {
    title: "Procurement",
    defaultPath: "/admin/restaurant/purchasing",
    links: [
      { label: "Purchasing", path: "/admin/restaurant/purchasing" },
      { label: "Procurement", path: "/admin/restaurant/procurement" },
      { label: "Requisitions", path: "/admin/restaurant/requisitions" },
      { label: "Suppliers", path: "/admin/restaurant/suppliers" },
    ],
  },
  accountant: {
    title: "Finance",
    defaultPath: "/admin/restaurant/reconciliation",
    links: [
      { label: "Reconciliation", path: "/admin/restaurant/reconciliation" },
      { label: "Profitability", path: "/admin/restaurant/profitability" },
      { label: "Fiscal", path: "/admin/restaurant/fiscal" },
      { label: "Payments", path: "/admin/restaurant/payments" },
      { label: "Receipts", path: "/admin/restaurant/receipts" },
    ],
  },
  viewer: {
    title: "Workspace",
    defaultPath: "/admin/restaurant",
    links: [{ label: "Overview", path: "/admin/restaurant" }],
  },
};

function readSessionCookie(): string | null {
  if (typeof document === "undefined") return null;
  const item = document.cookie.split("; ").find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return item ? decodeURIComponent(item.slice(SESSION_COOKIE.length + 1)) : null;
}

function writeSessionCookie(sessionId: string) {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; SameSite=Strict${secure}`;
}

function clearSessionCookie() {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${SESSION_COOKIE}=; Max-Age=0; Path=/; SameSite=Strict${secure}`;
}

function allowedForRole(role: string, pathname: string): boolean {
  const workspace = STAFF_WORKSPACES[role];
  if (!workspace) return false;
  return workspace.links.some((link) =>
    link.path === "/admin/restaurant"
      ? pathname === "/admin/restaurant" || pathname === "/admin/restaurant/"
      : pathname === link.path || pathname.startsWith(`${link.path}/`),
  );
}

export function StaffAccessGateway() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const bootstrapFn = useServerFn(getStaffAccessBootstrapFn);
  const startFn = useServerFn(startPosSessionFn);
  const endFn = useServerFn(endPosSessionFn);
  const bootstrap = useQuery({
    queryKey: ["staff-access.bootstrap"],
    queryFn: () => bootstrapFn(),
    staleTime: 0,
    retry: 1,
  });

  const [propertyId, setPropertyId] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const access = bootstrap.data;
  const properties = access?.properties ?? [];
  const selectedProperty = properties.find((property) => property.id === propertyId) ?? properties[0] ?? null;
  const activeSession = access?.activeSession ?? null;\n  const refetchBootstrap = bootstrap.refetch;
  const cookieSessionId = readSessionCookie();
  const sessionIsBound = Boolean(activeSession && cookieSessionId === activeSession.sessionId);
  const sessionRole = sessionIsBound ? activeSession?.role ?? null : null;

  useEffect(() => {
    if (!properties.length) {
      if (propertyId) setPropertyId("");
      return;
    }
    if (!propertyId || !properties.some((property) => property.id === propertyId)) {
      setPropertyId(properties[0].id);
    }
  }, [properties, propertyId]);

  const endSession = useCallback(async () => {
    if (!activeSession) {
      clearSessionCookie();
      await refetchBootstrap();
      return;
    }
    setBusy(true);
    setError("");
    try {
      // Do not clear the browser token or show the PIN screen unless the
      // database confirms that the previous actor session was ended.
      await endFn({ data: { sessionId: activeSession.sessionId } });
      clearSessionCookie();
      await queryClient.invalidateQueries({ queryKey: ["staff-access.bootstrap"] });
      await refetchBootstrap();
      setPin("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The session could not be ended safely.");
    } finally {
      setBusy(false);
    }
  }, [activeSession?.sessionId, endFn, queryClient, refetchBootstrap]);

  useEffect(() => {
    if (!sessionIsBound) return;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void endSession(), 30 * 60 * 1000);
    };
    const events = ["pointerdown", "keydown", "touchstart"];
    events.forEach((event) => window.addEventListener(event, arm, { passive: true }));
    arm();
    return () => {
      clearTimeout(timer);
      events.forEach((event) => window.removeEventListener(event, arm));
    };
  }, [sessionIsBound, activeSession?.sessionId, endSession]);

  useEffect(() => {
    if (!sessionIsBound || !sessionRole || sessionRole === "general_manager" || sessionRole === "restaurant_manager") return;
    const workspace = STAFF_WORKSPACES[sessionRole];
    if (!workspace) return;
    if (!allowedForRole(sessionRole, pathname)) {
      void navigate({ to: workspace.defaultPath as never, replace: true });
    }
  }, [sessionIsBound, sessionRole, pathname, navigate]);

  const submitPin = async () => {
    if (!access?.canActivate || !access.tenantId || !selectedProperty) {
      setError("This account is not authorised to activate staff access.");
      return;
    }
    if (!/^\d{4,6}$/.test(pin)) {
      setError("Enter your 4–6 digit PIN.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await startFn({
        data: {
          tenantId: access.tenantId,
          propertyId: selectedProperty.id,
          pin,
          terminalId: "pos-web",
        },
      });
      writeSessionCookie(result.sessionId);
      setPin("");
      await queryClient.invalidateQueries({ queryKey: ["staff-access.bootstrap"] });
      await refetchBootstrap();
    } catch (e) {
      setError(e instanceof Error ? e.message : "PIN verification failed.");
    } finally {
      setBusy(false);
    }
  };

  const sessionValue = useMemo<StaffAccessSessionValue>(() => ({
    sessionId: sessionIsBound ? activeSession?.sessionId ?? null : null,
    staffUserId: sessionIsBound ? activeSession?.staffUserId ?? null : null,
    staffMemberId: sessionIsBound ? activeSession?.staffMemberId ?? null : null,
    role: sessionIsBound ? activeSession?.role ?? null : null,
    propertyId: sessionIsBound ? activeSession?.propertyId ?? null : null,
  }), [sessionIsBound, activeSession]);

  if (bootstrap.isLoading) {
    return <div className="flex min-h-screen items-center justify-center p-6 text-sm text-muted-foreground">Verifying LexiBite access…</div>;
  }

  if (bootstrap.isError || !access) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-4">
        <section className="w-full max-w-md rounded-2xl border bg-card p-6 shadow-sm">
          <ShieldCheck className="mb-3 size-6 text-destructive" />
          <h1 className="text-lg font-semibold">Access verification unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">LexiBite could not verify this account's access policy. No operational workspace has been opened.</p>
          <Button className="mt-5 w-full" onClick={() => void bootstrap.refetch()}><RefreshCw className="mr-2 size-4" />Retry verification</Button>
        </section>
      </main>
    );
  }

  // Owner and founder/platform-admin access remains direct and does not require a PIN.
  if (access.platformAdmin || access.owner || !access.hasRestaurantMembership) {
    return <NovaShell><Outlet /></NovaShell>;
  }

  if (!access.canActivate) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-4">
        <section className="w-full max-w-md rounded-2xl border bg-card p-6 shadow-sm">
          <LockKeyhole className="mb-3 size-6" />
          <h1 className="text-lg font-semibold">Manager authorisation required</h1>
          <p className="mt-2 text-sm text-muted-foreground">Staff cannot activate this terminal with an email/password account. Ask an authorised manager to sign in and open Staff Access.</p>
          <Button variant="outline" className="mt-5 w-full" onClick={() => window.location.assign("/auth")}>Return to sign in</Button>
        </section>
      </main>
    );
  }

  if (sessionIsBound && sessionRole && (sessionRole === "general_manager" || sessionRole === "restaurant_manager")) {
    return (
      <StaffAccessSessionContext.Provider value={sessionValue}>
        <div className="relative">
          <NovaShell><Outlet /></NovaShell>
          <div className="fixed right-3 top-3 z-[60]">
            <Button size="sm" variant="secondary" className="gap-2 shadow-md" disabled={busy} onClick={() => void endSession()}>
              <LogOut className="size-4" /> Switch staff
            </Button>
          </div>
        </div>
      </StaffAccessSessionContext.Provider>
    );
  }

  if (sessionIsBound && sessionRole && STAFF_WORKSPACES[sessionRole]) {
    const workspace = STAFF_WORKSPACES[sessionRole];
    return (
      <StaffAccessSessionContext.Provider value={sessionValue}>
        <div className="min-h-screen bg-background">
          <header className="sticky top-0 z-40 border-b bg-card/95 px-4 py-3 backdrop-blur sm:px-6">
            <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">LexiBite · Staff Access</p>
                <h1 className="truncate text-base font-semibold">{workspace.title}</h1>
                <p className="text-xs text-muted-foreground">{RESTAURANT_ROLE_LABELS[sessionRole as keyof typeof RESTAURANT_ROLE_LABELS] ?? sessionRole}</p>
              </div>
              <Button size="sm" variant="outline" className="shrink-0 gap-2" disabled={busy} onClick={() => void endSession()}>
                <LogOut className="size-4" /> Switch staff
              </Button>
            </div>
            <nav aria-label="Staff workspace" className="mx-auto mt-3 flex max-w-7xl gap-2 overflow-x-auto">
              {workspace.links.map((link) => (
                <Link key={link.path} to={link.path as never} className="whitespace-nowrap rounded-md border px-3 py-2 text-sm hover:bg-muted">
                  {link.label}
                </Link>
              ))}
            </nav>
          </header>
          <main className="mx-auto max-w-7xl p-4 sm:p-6"><Outlet /></main>
        </div>
      </StaffAccessSessionContext.Provider>
    );
  }

  // A manager's account must have an assigned PIN before it can activate this gateway.
  if (sessionIsBound && activeSession) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-4">
        <section className="w-full max-w-md rounded-2xl border bg-card p-6 shadow-sm">
          <LockKeyhole className="mb-3 size-6 text-destructive" />
          <h1 className="text-lg font-semibold">No workspace mapped to this role</h1>
          <p className="mt-2 text-sm text-muted-foreground">This staff role has no configured operational landing page. Ask the owner or manager to review the role assignment.</p>
          <Button className="mt-5 w-full" disabled={busy} onClick={() => void endSession()}>End staff session</Button>
        </section>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7f8f5] p-4 text-[#172019]">
      <section className="w-full max-w-md rounded-2xl border border-[#dfe4df] bg-white p-6 shadow-[0_18px_50px_rgba(23,61,34,0.08)] sm:p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-xl border border-[#dfe4df] p-2"><KeyRound className="size-5 text-[#2f7139]" /></div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#55705a]">LexiBite · Staff Access</p>
            <h1 className="mt-1 text-xl font-semibold">Enter your PIN</h1>
          </div>
        </div>
        <p className="mb-5 text-sm leading-6 text-[#667069]">
          This terminal was authorised by a manager. Your PIN identifies you and opens only the workspace assigned to your role.
        </p>
        <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.12em] text-[#59645d]" htmlFor="staff-access-property">Property</label>
        <select
          id="staff-access-property"
          value={selectedProperty?.id ?? ""}
          onChange={(event) => { setPropertyId(event.target.value); setPin(""); setError(""); }}
          disabled={busy || properties.length <= 1}
          className="mb-4 h-12 w-full rounded-lg border border-[#d5dbd6] bg-white px-3 text-sm outline-none focus:border-[#2f7139] focus:ring-4 focus:ring-[#2f7139]/10"
        >
          {properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
        </select>
        {selectedProperty && !selectedProperty.pinConfigured ? (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            No manager PIN is assigned yet. Staff may still use their own PINs; the manager workspace remains locked until the owner assigns a manager PIN in Staff & Roles.
          </div>
        ) : null}
        <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.12em] text-[#59645d]" htmlFor="staff-access-pin">Personal PIN</label>
        <input
          id="staff-access-pin"
          autoFocus
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
          onKeyDown={(event) => { if (event.key === "Enter") void submitPin(); }}
          inputMode="numeric"
          type="password"
          autoComplete="off"
          maxLength={6}
          className="mb-4 h-14 w-full rounded-lg border border-[#d5dbd6] bg-white px-4 text-center text-2xl tracking-[0.5em] outline-none focus:border-[#2f7139] focus:ring-4 focus:ring-[#2f7139]/10"
          placeholder="••••"
        />
        {error ? <p role="alert" className="mb-4 text-sm text-destructive">{error}</p> : null}
        <Button className="h-12 w-full bg-[#2f7139] text-white hover:bg-[#275f30]" disabled={busy || pin.length < 4 || !selectedProperty} onClick={() => void submitPin()}>
          {busy ? "Verifying…" : "Open my workspace"}
        </Button>
        {activeSession && !sessionIsBound ? (
          <Button variant="ghost" className="mt-2 w-full" disabled={busy} onClick={() => void endSession()}>
            End previous terminal session
          </Button>
        ) : null}
        <p className="mt-5 text-center text-xs text-[#78817b]">Switching staff ends the current operational session and returns here.</p>
      </section>
    </main>
  );
}
