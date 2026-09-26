import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { useServerFn } from "@tanstack/react-start";
import { LockKeyhole, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import { startPosSessionFn, endPosSessionFn, bootstrapOwnerPosPinFn } from "../pos-session.functions";

type SessionValue = { sessionId: string | null; staffUserId: string | null };
const PosSessionContext = createContext<SessionValue>({ sessionId: null, staffUserId: null });
export const usePosStaffSession = () => useContext(PosSessionContext);

const STORAGE_KEY = "lexibite.pos.staff-session";

export function PosStaffGate({ children }: { children: ReactNode }) {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const propertyId = ws.data?.properties?.[0]?.id;
  const startFn = useServerFn(startPosSessionFn);
  const endFn = useServerFn(endPosSessionFn);
  const bootstrapFn = useServerFn(bootstrapOwnerPosPinFn);
  const [session, setSession] = useState<{ sessionId: string; staffUserId: string } | null>(() => {
    if (typeof window === "undefined") return null;
    try { return JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null"); } catch { return null; }
  });
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const logout = async () => {
    if (session?.sessionId) {
      try { await endFn({ data: { sessionId: session.sessionId } }); } catch {}
    }
    if (typeof window !== "undefined") window.sessionStorage.removeItem(STORAGE_KEY);
    setSession(null);
    setPin("");
  };

  useEffect(() => {
    if (!session) return;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void logout(), 30 * 60 * 1000);
    };
    const events = ["pointerdown", "keydown", "touchstart"];
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }));
    arm();
    return () => { clearTimeout(timer); events.forEach((e) => window.removeEventListener(e, arm)); };
  }, [session?.sessionId]);

  const submit = async () => {
    if (!tenantId || !propertyId || !/^\d{4,6}$/.test(pin)) {
      setError("Enter a valid 4–6 digit staff PIN.");
      return;
    }
    setBusy(true); setError("");
    try {
      const result = await startFn({ data: {
        tenantId, propertyId, pin, terminalId: "pos-web",
      }});
      const next = { sessionId: result.sessionId, staffUserId: result.staffUserId };
      setSession(next);
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setPin("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid PIN.");
    } finally { setBusy(false); }
  };

  const value = useMemo(() => ({ sessionId: session?.sessionId ?? null, staffUserId: session?.staffUserId ?? null }), [session]);

  if (session) {
    return (
      <PosSessionContext.Provider value={value}>
        <div className="relative">
          <div className="fixed right-3 top-3 z-50 flex items-center gap-2 rounded-full border bg-background/95 px-2 py-1 shadow-sm backdrop-blur">
            <span className="max-w-32 truncate px-2 text-[11px] text-muted-foreground">{session.staffUserId.slice(0, 8)}</span>
            <Button size="sm" variant="ghost" className="min-h-8 gap-1" onClick={() => void logout()}>
              <LogOut className="size-3.5" /> Switch
            </Button>
          </div>
          {children}
        </div>
      </PosSessionContext.Provider>
    );
  }

  return (
    <div className="min-h-[70vh] flex items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl border bg-card p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-3">
          <div className="rounded-xl border p-2"><LockKeyhole className="size-5" /></div>
          <div><h2 className="font-semibold">POS Staff Access</h2><p className="text-xs text-muted-foreground">Enter the staff PIN to take this till.</p></div>
        </div>
        <p className="mb-3 text-sm text-muted-foreground">Each staff member uses a personal PIN. The PIN identifies the operator and applies their existing role permissions.</p>
        <label className="mb-2 block text-xs font-medium">Staff PIN</label>
        <input autoFocus value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} inputMode="numeric" type="password" maxLength={6} className="mb-3 min-h-12 w-full rounded-md border bg-background px-4 text-center text-2xl tracking-[0.5em]" placeholder="••••" />

        {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
        {error === "Invalid staff PIN" && (
          <Button
            variant="outline"
            className="mb-3 min-h-10 w-full"
            disabled={busy}
            onClick={async () => {
              if (!tenantId || !propertyId || !/^\\d{4,6}$/.test(pin)) return;
              setBusy(true); setError("");
              try {
                await bootstrapFn({ data: { tenantId, propertyId, pin } });
                const result = await startFn({ data: { tenantId, propertyId, pin, terminalId: "pos-web" } });
                const next = { sessionId: result.sessionId, staffUserId: result.staffUserId };
                setSession(next);
                window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
                setPin("");
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not recover POS access.");
              } finally { setBusy(false); }
            }}
          >
            Set this PIN for my owner account
          </Button>
        )}
        <Button className="min-h-11 w-full" disabled={busy || pin.length < 4} onClick={() => void submit()}>
          {busy ? "Verifying…" : "Enter POS"}
        </Button>
      </div>
    </div>
  );
}
