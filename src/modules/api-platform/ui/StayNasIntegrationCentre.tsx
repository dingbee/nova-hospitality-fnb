import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

type Connection = {
  id: string;
  integration_tenant_id: string;
  integration_property_id: string;
  local_property_id: string;
  remote_tenant_id: string;
  remote_property_id: string;
  remote_product: string;
  status: string;
  correlation_id: string;
  local_approved_at: string | null;
  remote_approved_at: string | null;
};

type PairingInvitation = {
  contractVersion: string;
  integrationTenantId: string;
  integrationPropertyId: string;
  correlationId: string;
  sourceProduct: string;
  sourceTenantId: string;
  sourcePropertyId: string;
  targetProduct: string;
};

async function lb01Request(payload: Record<string, unknown>) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in again before managing product integrations.");
  const response = await fetch("/api/integrations/lb01/manage", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    cache: "no-store",
    body: JSON.stringify(payload),
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(result.error ?? "LB-01 request failed."));
  return result;
}

export function StayNasIntegrationCentre() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [localPropertyId, setLocalPropertyId] = useState("");
  const [remoteTenantId, setRemoteTenantId] = useState("");
  const [remotePropertyId, setRemotePropertyId] = useState("");
  const [invitationJson, setInvitationJson] = useState("");
  const [invitation, setInvitation] = useState<PairingInvitation | null>(null);
  const [handoffCodes, setHandoffCodes] = useState<Record<string, string>>({});
  const [importCodes, setImportCodes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    const result = await lb01Request({ action: "list" });
    setConnections(Array.isArray(result.connections) ? result.connections as Connection[] : []);
  }, []);

  useEffect(() => {
    let active = true;
    void lb01Request({ action: "list" }).then((result) => {
      if (active) setConnections(Array.isArray(result.connections) ? result.connections as Connection[] : []);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Unable to load LB-01 connections.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const runAction = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "LB-01 operation failed.");
    } finally {
      setBusy(null);
    }
  };

  const createConnection = async () => {
    await runAction("create", async () => {
      let remoteTenant = remoteTenantId.trim();
      let remoteProperty = remotePropertyId.trim();
      let canonical: Partial<PairingInvitation> = {};
      if (invitationJson.trim()) {
        const parsed = JSON.parse(invitationJson) as Partial<PairingInvitation>;
        if (parsed.contractVersion !== "1.0.0" || parsed.targetProduct !== "lexibite"
          || !parsed.integrationTenantId || !parsed.integrationPropertyId || !parsed.correlationId
          || !parsed.sourceTenantId || !parsed.sourcePropertyId) {
          throw new Error("The pairing invitation is invalid or targets another product.");
        }
        canonical = parsed;
        remoteTenant = parsed.sourceTenantId;
        remoteProperty = parsed.sourcePropertyId;
      }
      if (!localPropertyId.trim() || !remoteTenant || !remoteProperty) {
        throw new Error("Enter the local property ID and the peer tenant/property IDs, or paste a pairing invitation.");
      }
      const result = await lb01Request({
        action: "create",
        localPropertyId: localPropertyId.trim(),
        remoteTenantId: remoteTenant,
        remotePropertyId: remoteProperty,
        ...(canonical.integrationTenantId ? {
          integrationTenantId: canonical.integrationTenantId,
          integrationPropertyId: canonical.integrationPropertyId,
          correlationId: canonical.correlationId,
        } : {}),
      });
      setInvitation(result.pairingInvitation as PairingInvitation);
      setInvitationJson("");
      setRemoteTenantId("");
      setRemotePropertyId("");
      await refresh();
      setNotice("Connection mapping created. Share the pairing invitation with the peer product administrator.");
    });
  };

  const issueHandoff = async (connectionId: string) => {
    await runAction("issue:" + connectionId, async () => {
      const result = await lb01Request({ action: "issue_handoff", connectionId });
      setHandoffCodes((current) => ({ ...current, [connectionId]: String(result.handoffCode) }));
      setNotice("A short-lived handoff code was created. Share it with the matching peer administrator; it expires in 15 minutes.");
    });
  };

  const importHandoff = async (connectionId: string) => {
    const code = importCodes[connectionId]?.trim() ?? "";
    await runAction("import:" + connectionId, async () => {
      if (!code) throw new Error("Paste the handoff code received from the peer administrator.");
      await lb01Request({ action: "import_handoff", connectionId, code });
      setImportCodes((current) => ({ ...current, [connectionId]: "" }));
      await refresh();
      setNotice("Peer credential exchanged server-to-server and stored encrypted. The raw credential was never returned to this browser.");
    });
  };

  const approve = async (connectionId: string) => {
    await runAction("approve:" + connectionId, async () => {
      const result = await lb01Request({ action: "approve", connectionId });
      await refresh();
      setNotice(result.deliveryStatus === "accepted"
        ? "Local approval recorded and securely delivered to the peer. The connection activates after both products approve."
        : result.deliveryStatus === "awaiting_peer_credential"
          ? "Local approval recorded. Import the peer handoff code, then retry delivery."
          : "Local approval recorded, but delivery needs a retry. The approval remains pending.");
    });
  };

  const retry = async (connectionId: string) => {
    await runAction("retry:" + connectionId, async () => {
      const result = await lb01Request({ action: "retry", connectionId });
      await refresh();
      setNotice(result.deliveryStatus === "accepted" ? "Approval notification delivered." : "Delivery remains pending; check peer configuration and retry.");
    });
  };

  const revoke = async (connectionId: string) => {
    if (!window.confirm("Revoke this product connection? This is terminal and blocks its credentials.")) return;
    await runAction("revoke:" + connectionId, async () => {
      await lb01Request({ action: "revoke", connectionId, reason: "Revoked by authorized property administrator" });
      setHandoffCodes((current) => { const next = { ...current }; delete next[connectionId]; return next; });
      await refresh();
      setNotice("Local connection revoked. Its issued service credentials and unused handoff codes are invalidated.");
    });
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">StayNas × LexiBite</h1>
        <p className="mt-1 text-sm text-muted-foreground">Reciprocal property mapping, secure credential exchange and two-sided approval.</p>
      </header>

      <section className="rounded-xl border bg-muted/20 p-4 text-sm">
        <h2 className="font-semibold">Connection sequence</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
          <li>Create the mapping on one product and share its pairing invitation.</li>
          <li>The peer administrator accepts that invitation against their local property.</li>
          <li>Each side issues a handoff code; the other side imports it. The long-lived credential moves server-to-server and is encrypted at rest.</li>
          <li>Each product administrator approves locally. Signed notifications travel in both directions; activation requires both approvals.</li>
        </ol>
      </section>

      {error ? <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div> : null}
      {notice ? <div role="status" className="rounded-lg border border-emerald-600/20 bg-emerald-600/5 p-3 text-sm">{notice}</div> : null}

      <section className="rounded-xl border p-4">
        <h2 className="font-semibold">Create or accept a property mapping</h2>
        <p className="mt-1 text-xs text-muted-foreground">Use your local property ID. To accept an existing pairing, paste the JSON invitation; otherwise enter the peer's native tenant and property IDs.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="text-sm">Local property ID
            <input className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm" value={localPropertyId} onChange={(event) => setLocalPropertyId(event.target.value)} placeholder="UUID of your property" />
          </label>
          <label className="text-sm">Peer tenant ID
            <input className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm" value={remoteTenantId} onChange={(event) => setRemoteTenantId(event.target.value)} placeholder="UUID of peer tenant" disabled={Boolean(invitationJson.trim())} />
          </label>
          <label className="text-sm">Peer property ID
            <input className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm" value={remotePropertyId} onChange={(event) => setRemotePropertyId(event.target.value)} placeholder="UUID of peer property" disabled={Boolean(invitationJson.trim())} />
          </label>
          <label className="text-sm md:col-span-2">Pairing invitation JSON (accept existing mapping)
            <textarea className="mt-1 min-h-24 w-full rounded-md border bg-background px-3 py-2 font-mono text-xs" value={invitationJson} onChange={(event) => setInvitationJson(event.target.value)} placeholder="Paste pairing invitation JSON from the other product" />
          </label>
        </div>
        <button type="button" onClick={() => void createConnection()} disabled={busy === "create"} className="mt-3 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {busy === "create" ? "Creating…" : "Create connection mapping"}
        </button>
      </section>

      {invitation ? (
        <section className="rounded-xl border border-primary/30 p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">Pairing invitation — share with peer administrator</h2>
            <button type="button" className="rounded-md border px-3 py-1.5 text-xs" onClick={() => void navigator.clipboard.writeText(JSON.stringify(invitation, null, 2))}>Copy JSON</button>
          </div>
          <pre className="mt-3 overflow-x-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(invitation, null, 2)}</pre>
        </section>
      ) : null}

      <section className="rounded-xl border p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Product connections</h2>
            <p className="text-xs text-muted-foreground">Secrets and encrypted credential material are never listed.</p>
          </div>
          <button type="button" className="rounded-md border px-3 py-1.5 text-xs" onClick={() => void runAction("refresh", refresh)} disabled={busy !== null}>Refresh</button>
        </div>
        {loading ? <p className="mt-4 text-sm text-muted-foreground">Loading connections…</p> : connections.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">No StayNas/LexiBite property mappings yet.</p> : (
          <div className="mt-4 space-y-4">
            {connections.map((connection) => (
              <article key={connection.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">{connection.remote_product} · {connection.status}</div>
                    <div className="mt-1 text-xs text-muted-foreground">Connection {connection.id} · Correlation {connection.correlation_id}</div>
                    <div className="mt-1 text-xs text-muted-foreground">Local approval: {connection.local_approved_at ? "recorded" : "pending"} · Peer approval: {connection.remote_approved_at ? "recorded" : "pending"}</div>
                  </div>
                  <span className={"rounded-full px-2 py-1 text-xs " + (connection.status === "active" ? "bg-emerald-600/10 text-emerald-700" : connection.status === "revoked" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>{connection.status}</span>
                </div>
                {handoffCodes[connection.id] ? (
                  <div className="mt-3 rounded-md bg-muted p-3">
                    <div className="text-xs font-medium">One-time handoff code · expires in 15 minutes</div>
                    <div className="mt-1 break-all font-mono text-sm">{handoffCodes[connection.id]}</div>
                    <button type="button" className="mt-2 rounded border px-2 py-1 text-xs" onClick={() => void navigator.clipboard.writeText(handoffCodes[connection.id])}>Copy code</button>
                  </div>
                ) : null}
                {connection.status !== "revoked" ? (
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className="rounded-md border px-3 py-2 text-xs" disabled={busy !== null} onClick={() => void issueHandoff(connection.id)}>Issue handoff code</button>
                      <button type="button" className="rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50" disabled={busy !== null} onClick={() => void approve(connection.id)}>Approve and notify peer</button>
                      <button type="button" className="rounded-md border px-3 py-2 text-xs" disabled={busy !== null || !connection.local_approved_at} onClick={() => void retry(connection.id)}>Retry delivery</button>
                      <button type="button" className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive" disabled={busy !== null} onClick={() => void revoke(connection.id)}>Revoke</button>
                    </div>
                    <div>
                      <label className="text-xs">Import peer handoff code</label>
                      <div className="mt-1 flex gap-2">
                        <input className="min-w-0 flex-1 rounded-md border bg-background px-2 py-2 font-mono text-xs" value={importCodes[connection.id] ?? ""} onChange={(event) => setImportCodes((current) => ({ ...current, [connection.id]: event.target.value }))} placeholder="43-character code" />
                        <button type="button" className="rounded-md border px-3 py-2 text-xs" disabled={busy !== null} onClick={() => void importHandoff(connection.id)}>Import</button>
                      </div>
                    </div>
                  </div>
                ) : <p className="mt-3 text-xs text-muted-foreground">This connection is terminally revoked.</p>}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
