import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Mail, ShieldCheck, UserPlus, XCircle } from "lucide-react";
import { SectionCard } from "@/components/os/SectionCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useAdminMutation } from "@/hooks/use-admin-mutation";
import {
  inviteCommercialOwnerFn,
  listCommercialOwnerAccessFn,
  revokeCommercialOwnerInvitationFn,
} from "../commercial.functions";

export function CustomerOwnerAccessPanel({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const list = useServerFn(listCommercialOwnerAccessFn);
  const invite = useServerFn(inviteCommercialOwnerFn);
  const revoke = useServerFn(revokeCommercialOwnerInvitationFn);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");

  const access = useQuery({
    queryKey: ["commercial.ownerAccess", tenantId],
    queryFn: () => list({ data: { tenantId } }),
  });

  const inviteMutation = useAdminMutation({
    mutationFn: () =>
      invite({
        data: {
          tenantId,
          email: email.trim(),
          fullName: fullName.trim() || undefined,
        },
      }),
    successMessage: "Owner access issued",
    onSuccess: () => {
      setEmail("");
      setFullName("");
      void qc.invalidateQueries({ queryKey: ["commercial.ownerAccess", tenantId] });
    },
  });

  const revokeMutation = useAdminMutation({
    mutationFn: (invitationId: string) => revoke({ data: { invitationId } }),
    successMessage: "Pending owner invitation revoked",
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["commercial.ownerAccess", tenantId] });
    },
  });

  const rows = (access.data ?? []) as any[];
  const current = rows[0];

  return (
    <SectionCard
      title="Owner access"
      description="Customer access is issued here. Supabase Auth is used behind the scenes; Commercial Center remains the authority for who is allowed into this tenant."
      actions={
        current?.status === "accepted" ? (
          <Badge variant="outline" className="gap-1 border-emerald-400 text-emerald-700">
            <ShieldCheck className="size-3.5" /> Active
          </Badge>
        ) : current?.status === "pending" ? (
          <Badge variant="outline" className="gap-1">
            <Mail className="size-3.5" /> Invitation pending
          </Badge>
        ) : null
      }
    >
      {current?.status === "accepted" ? (
        <div className="rounded-lg border bg-muted/30 p-4 text-sm">
          <div className="font-medium">{current.full_name || "Customer owner"}</div>
          <div className="text-muted-foreground">{current.email}</div>
          <div className="mt-2 text-xs text-muted-foreground">
            Activated {current.accepted_at ? new Date(current.accepted_at).toLocaleString() : "—"}
          </div>
        </div>
      ) : current?.status === "pending" ? (
        <div className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="font-medium">{current.full_name || "Customer owner"}</div>
            <div className="truncate text-sm text-muted-foreground">{current.email}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Sent {current.last_sent_at ? new Date(current.last_sent_at).toLocaleString() : "—"}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={revokeMutation.isPending}
            onClick={() => revokeMutation.mutate(current.id)}
          >
            <XCircle className="mr-2 size-4" /> Revoke
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label>Owner name</Label>
              <Input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="e.g. Ahmed Hassan"
              />
            </div>
            <div>
              <Label>Owner email</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="owner@restaurant.co.tz"
              />
            </div>
          </div>
          <Button
            disabled={inviteMutation.isPending || !email.trim()}
            onClick={() => inviteMutation.mutate()}
          >
            <UserPlus className="mr-2 size-4" />
            {inviteMutation.isPending ? "Issuing access…" : "Issue owner access"}
          </Button>
          <p className="text-xs text-muted-foreground">
            New owners receive a Nolmark-issued email invitation. The invitation is bound to this
            customer workspace and becomes the tenant owner membership only after activation.
          </p>
        </div>
      )}
    </SectionCard>
  );
}
