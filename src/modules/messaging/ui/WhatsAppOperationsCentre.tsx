/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this UI boundary. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  MessageSquare,
  Users,
  Megaphone,
  BarChart3,
  ShieldCheck,
  CheckCircle2,
  Clock3,
  Send,
} from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { StatCard } from "@/components/os/StatCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip } from "@/components/os/StatusChip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import {
  getWhatsAppCampaignWorkspaceFn,
  getWhatsAppConversationFn,
  getWhatsAppConversionReportFn,
  getWhatsAppUsageReportFn,
  listWhatsAppGuestCRMFn,
  listWhatsAppInboxFn,
} from "../operations.functions";

function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function money(value: number, currency: string) {
  return `${currency} ${Number(value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function WhatsAppOperationsCentre() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id as string | undefined;
  const propertyId = ws.data?.activePropertyId ?? undefined;
  const [locationId, setLocationId] = useState<string | undefined>();
  const [conversationId, setConversationId] = useState<string | undefined>();
  const filters = { tenantId: tenantId!, propertyId, locationId };

  const inboxFn = useServerFn(listWhatsAppInboxFn);
  const conversationFn = useServerFn(getWhatsAppConversationFn);
  const crmFn = useServerFn(listWhatsAppGuestCRMFn);
  const campaignsFn = useServerFn(getWhatsAppCampaignWorkspaceFn);
  const usageFn = useServerFn(getWhatsAppUsageReportFn);
  const conversionFn = useServerFn(getWhatsAppConversionReportFn);

  const inbox = useQuery({
    queryKey: ["whatsapp", "inbox", tenantId, propertyId, locationId],
    queryFn: () => inboxFn({ data: { ...filters, limit: 75 } }),
    enabled: Boolean(tenantId),
    refetchInterval: 30_000,
  });
  const conversation = useQuery({
    queryKey: ["whatsapp", "conversation", tenantId, propertyId, locationId, conversationId],
    queryFn: () => conversationFn({ data: { ...filters, conversationId: conversationId! } }),
    enabled: Boolean(tenantId && conversationId),
    refetchInterval: 15_000,
  });
  const crm = useQuery({
    queryKey: ["whatsapp", "crm", tenantId, propertyId],
    queryFn: () => crmFn({ data: { tenantId: tenantId!, propertyId, limit: 150 } }),
    enabled: Boolean(tenantId),
  });
  const campaigns = useQuery({
    queryKey: ["whatsapp", "campaigns", tenantId, propertyId, locationId],
    queryFn: () => campaignsFn({ data: filters }),
    enabled: Boolean(tenantId),
  });
  const usage = useQuery({
    queryKey: ["whatsapp", "usage", tenantId, propertyId, locationId],
    queryFn: () => usageFn({ data: { ...filters, limit: 1000 } }),
    enabled: Boolean(tenantId),
  });
  const conversion = useQuery({
    queryKey: ["whatsapp", "conversion", tenantId, propertyId, locationId],
    queryFn: () => conversionFn({ data: { ...filters } }),
    enabled: Boolean(tenantId),
  });

  if (!ws.isLoading && !ws.data?.tenant) {
    return (
      <EmptyState
        title="No restaurant tenant"
        description="You are not a member of a Restaurant & Bar OS tenant."
      />
    );
  }

  const conversations = (inbox.data ?? []) as any[];
  const messages = (conversation.data?.messages ?? []) as any[];
  const customers = (crm.data ?? []) as any[];
  const templates = (campaigns.data?.templates ?? []) as any[];
  const campaignRows = (campaigns.data?.campaigns ?? []) as any[];
  const usageTotals = (usage.data?.totals ?? []) as any[];
  const conv = conversion.data as any;
  const active = conversations.find((row) => row.id === conversationId);

  return (
    <div className="space-y-4">
      <PageHeader
        title="WhatsApp Operations"
        description="Tenant-scoped conversations, guest CRM, campaign governance and commerce performance."
        actions={
          <select
            className="rounded-md border bg-background px-2 py-1.5 text-sm"
            value={locationId ?? ""}
            onChange={(event) => setLocationId(event.target.value || undefined)}
          >
            <option value="">All outlets</option>
            {(ws.data?.locations ?? []).map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Conversations" value={String(conversations.length)} icon={MessageSquare} />
        <StatCard label="Guest profiles" value={String(customers.length)} icon={Users} />
        <StatCard label="Active campaigns" value={String(campaignRows.filter((row) => ["ready", "scheduled", "running"].includes(row.status)).length)} icon={Megaphone} />
        <StatCard label="Portal-to-order" value={conv ? `${(conv.sessionToOrderRate * 100).toFixed(1)}%` : "—"} icon={BarChart3} />
      </div>

      <Tabs defaultValue="inbox" className="space-y-4">
        <TabsList className="flex h-auto flex-wrap">
          <TabsTrigger value="inbox">Inbox</TabsTrigger>
          <TabsTrigger value="guests">Guest CRM & consent</TabsTrigger>
          <TabsTrigger value="campaigns">Templates & campaigns</TabsTrigger>
          <TabsTrigger value="reports">Usage & conversion</TabsTrigger>
        </TabsList>

        <TabsContent value="inbox">
          <div className="grid gap-4 xl:grid-cols-[minmax(280px,0.85fr)_minmax(0,1.5fr)]">
            <SectionCard title="Conversations" description="Most recently active WhatsApp conversations.">
              {conversations.length === 0 ? (
                <EmptyState title="No conversations" description="Verified WhatsApp guest conversations will appear here." icon={MessageSquare} />
              ) : (
                <ul className="divide-y">
                  {conversations.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        className={`w-full rounded-md px-2 py-3 text-left transition hover:bg-muted/60 ${conversationId === row.id ? "bg-muted" : ""}`}
                        onClick={() => setConversationId(row.id)}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">{row.guest?.display_name || row.guest?.phone_e164 || row.wa_user_id}</span>
                          <StatusChip>{row.status}</StatusChip>
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {row.latestMessage?.content || row.latestMessage?.message_type || "No message preview"}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">{formatDate(row.last_message_at)}</p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
            <SectionCard
              title={active ? (active.guest?.display_name || active.guest?.phone_e164 || active.wa_user_id) : "Conversation history"}
              description={active ? `${active.guest?.phone_e164 ?? active.wa_user_id} · ${active.status} · ${formatDate(active.last_message_at)}` : "Select a conversation to inspect messages and delivery state."}
            >
              {!conversationId ? (
                <EmptyState title="Select a conversation" description="Message history and delivery evidence will appear here." />
              ) : messages.length === 0 ? (
                <EmptyState title="No messages" description="This conversation has no stored messages." />
              ) : (
                <ol className="space-y-3">
                  {messages.map((message) => (
                    <li key={message.id} className={`max-w-[92%] rounded-lg border p-3 ${message.direction === "outbound" ? "ml-auto bg-muted/50" : "mr-auto"}`}>
                      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-medium">{message.direction === "outbound" ? "LexiBite / staff" : "Guest"}</span>
                        <StatusChip>{message.status}</StatusChip>
                      </div>
                      <p className="whitespace-pre-wrap text-sm">{message.content || `[${message.message_type}]`}</p>
                      <p className="mt-2 text-[11px] text-muted-foreground">{formatDate(message.created_at)}</p>
                      {message.last_error ? <p className="mt-1 text-xs text-destructive">{message.last_error}</p> : null}
                    </li>
                  ))}
                </ol>
              )}
              <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="size-3.5" /> Read-only operational view. Replies continue through the canonical, governed outbox.
              </p>
            </SectionCard>
          </div>
        </TabsContent>

        <TabsContent value="guests">
          <SectionCard title="Guest CRM & consent" description="Guest identity and the latest append-only WhatsApp consent evidence.">
            {customers.length === 0 ? (
              <EmptyState title="No guest profiles" description="Verified guest identities will appear after WhatsApp or Guest Portal engagement." icon={Users} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr><th className="py-2 pr-3">Guest</th><th className="py-2 pr-3">Language</th><th className="py-2 pr-3">Status</th><th className="py-2 pr-3">Marketing consent</th><th className="py-2 pr-3">Service updates</th><th className="py-2">Last seen</th></tr>
                  </thead>
                  <tbody className="divide-y">
                    {customers.map((guest) => (
                      <tr key={guest.id}>
                        <td className="py-2 pr-3"><div className="font-medium">{guest.display_name || "Guest"}</div><div className="text-xs text-muted-foreground">{guest.phone_e164}</div></td>
                        <td className="py-2 pr-3 uppercase">{guest.preferred_language}</td>
                        <td className="py-2 pr-3"><StatusChip>{guest.status}</StatusChip></td>
                        <td className="py-2 pr-3"><StatusChip tone={guest.marketingConsent?.state === "granted" ? "success" : "warning"}>{guest.marketingConsent?.state ?? "not recorded"}</StatusChip></td>
                        <td className="py-2 pr-3"><StatusChip>{guest.serviceUpdatesConsent?.state ?? "not recorded"}</StatusChip></td>
                        <td className="py-2 text-xs text-muted-foreground">{formatDate(guest.last_seen_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="campaigns">
          <div className="grid gap-4 xl:grid-cols-2">
            <SectionCard title="Message templates" description="Provider approval state, language and category from the WCE-06 registry.">
              {templates.length === 0 ? (
                <EmptyState title="No templates" description="Tenant-approved WhatsApp templates will appear here." />
              ) : (
                <ul className="divide-y">
                  {templates.map((template) => (
                    <li key={template.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                      <div><p className="font-medium">{template.template_name}</p><p className="text-xs text-muted-foreground">{template.language} · {template.category} · {formatDate(template.updated_at)}</p></div>
                      <StatusChip>{template.status}</StatusChip>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
            <SectionCard title="Campaigns" description="Scheduled/event state, audience scope and delivery controls.">
              {campaignRows.length === 0 ? (
                <EmptyState title="No campaigns" description="Governed WhatsApp campaigns will appear here once configured." icon={Megaphone} />
              ) : (
                <ul className="divide-y">
                  {campaignRows.map((campaign) => (
                    <li key={campaign.id} className="space-y-1 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{campaign.name}</span><StatusChip>{campaign.status}</StatusChip></div>
                      <p className="text-xs text-muted-foreground">{campaign.trigger_type === "scheduled" ? `Scheduled · ${formatDate(campaign.scheduled_at)}` : `Event · ${campaign.event_key}`} · {campaign.market_code}</p>
                      <p className="text-xs text-muted-foreground">Daily cap: {campaign.daily_cap ?? "—"} · Total cap: {campaign.total_cap ?? "—"}</p>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>
        </TabsContent>

        <TabsContent value="reports">
          <div className="grid gap-4 xl:grid-cols-2">
            <SectionCard title="WhatsApp-to-commerce conversion" description="Canonical Guest Portal sessions linked to restaurant orders.">
              <div className="grid gap-3 sm:grid-cols-2">
                <StatCard label="Sessions created" value={String(conv?.sessionsCreated ?? "—")} icon={Clock3} />
                <StatCard label="Sessions opened" value={String(conv?.sessionsOpened ?? "—")} icon={MessageSquare} />
                <StatCard label="Orders placed" value={String(conv?.ordersPlaced ?? "—")} icon={Send} />
                <StatCard label="Orders paid" value={String(conv?.ordersPaid ?? "—")} icon={CheckCircle2} />
              </div>
              <div className="mt-4 space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Session → order</span><strong>{conv ? `${(conv.sessionToOrderRate * 100).toFixed(1)}%` : "—"}</strong></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Order → paid</span><strong>{conv ? `${(conv.orderToPaidRate * 100).toFixed(1)}%` : "—"}</strong></div>
                {(conv?.paidRevenueByCurrency ?? []).map((item: any) => <div key={item.currency} className="flex justify-between"><span className="text-muted-foreground">Paid revenue ({item.currency})</span><strong>{money(item.amount, item.currency)}</strong></div>)}
              </div>
            </SectionCard>
            <SectionCard title="Usage and cost attribution" description="Append-only WCE-06 ledger, kept separate by component and currency.">
              {usageTotals.length === 0 ? (
                <EmptyState title="No usage ledger entries" description="Provider usage snapshots will appear after governed campaign dispatch is enabled." icon={BarChart3} />
              ) : (
                <ul className="divide-y">
                  {usageTotals.map((item) => (
                    <li key={item.component + item.currency} className="flex items-center justify-between gap-3 py-3">
                      <div><p className="font-medium">{item.component.replaceAll("_", " ")}</p><p className="text-xs text-muted-foreground">{item.quantity} unit(s) · {item.entries} ledger entry(s)</p></div>
                      <strong>{money(item.amount, item.currency)}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
