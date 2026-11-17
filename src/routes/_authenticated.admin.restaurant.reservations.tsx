import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CalendarCheck, Check, Clock3, Loader2, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/os/EmptyState";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import {
  listGuestReservationsFn,
  updateGuestReservationStatusFn,
} from "@/modules/restaurant/reservations/reservations.functions";

export const Route = createFileRoute("/_authenticated/admin/restaurant/reservations")({
  head: () => ({
    meta: [
      { title: "Reservations — LexiBite" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ReservationsWorkspace,
});

function ReservationsWorkspace() {
  const workspace = useRestaurantWorkspace();
  const tenantId = workspace.data?.tenant?.id ?? "";
  const properties = (workspace.data?.properties ?? []) as Array<{
    id: string;
    name: string;
    timezone?: string;
  }>;
  const locations = (workspace.data?.locations ?? []) as Array<{
    id: string;
    name: string;
    property_id: string;
    is_storage?: boolean;
  }>;
  const queryClient = useQueryClient();
  const listReservations = useServerFn(listGuestReservationsFn);
  const updateReservation = useServerFn(updateGuestReservationStatusFn);
  const [propertyId, setPropertyId] = useState("");
  const [locationId, setLocationId] = useState("");

  const property = properties.find((item) => item.id === propertyId) ?? properties[0];
  const propertyLocations = locations.filter(
    (location) => location.property_id === (property?.id ?? propertyId) && !location.is_storage,
  );

  useEffect(() => {
    if (!propertyId && properties.length) setPropertyId(properties[0].id);
  }, [propertyId, properties]);
  useEffect(() => {
    if (propertyLocations.length && !propertyLocations.some((location) => location.id === locationId)) {
      setLocationId(propertyLocations[0].id);
    }
  }, [propertyLocations, locationId]);

  const range = useMemo(
    () => ({
      from: new Date().toISOString(),
      to: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
    }),
    [],
  );
  const reservationsQuery = useQuery({
    queryKey: ["guest-reservations", tenantId, property?.id, locationId, range],
    enabled: Boolean(tenantId && property?.id && locationId),
    queryFn: () =>
      listReservations({
        data: {
          tenantId,
          propertyId: property!.id,
          locationId,
          from: range.from,
          to: range.to,
        },
      }),
  });

  const statusMutation = useMutation({
    mutationFn: (input: {
      reservationId: string;
      status: "confirmed" | "seated" | "completed" | "cancelled" | "no_show";
    }) =>
      updateReservation({
        data: {
          tenantId,
          propertyId: property!.id,
          locationId,
          ...input,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["guest-reservations", tenantId] });
    },
  });

  const timezone = property?.timezone || "Africa/Dar_es_Salaam";
  const reservations = reservationsQuery.data ?? [];

  if (workspace.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading reservation workspace…</div>;
  }
  if (!tenantId) {
    return <EmptyState title="No restaurant tenant" description="Join a Restaurant & Bar OS tenant to manage reservations." />;
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <header>
        <div className="flex items-center gap-2">
          <CalendarCheck className="size-5 text-primary" aria-hidden />
          <h1 className="text-2xl font-semibold tracking-tight">Guest reservations</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage Guest Portal reservations against the outlet's live table inventory.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Property
          <select
            value={property?.id ?? ""}
            onChange={(event) => {
              setPropertyId(event.target.value);
              setLocationId("");
            }}
            className="mt-1 block h-10 w-full rounded-lg border border-border bg-background px-3"
          >
            {properties.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label className="text-sm">
          Outlet
          <select
            value={locationId}
            onChange={(event) => setLocationId(event.target.value)}
            className="mt-1 block h-10 w-full rounded-lg border border-border bg-background px-3"
          >
            {propertyLocations.map((location) => (
              <option key={location.id} value={location.id}>{location.name}</option>
            ))}
          </select>
        </label>
      </div>

      {reservationsQuery.isError ? (
        <p className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
          {reservationsQuery.error instanceof Error
            ? reservationsQuery.error.message
            : "Reservations could not be loaded."}
        </p>
      ) : null}
      {statusMutation.isError ? (
        <p className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
          {statusMutation.error instanceof Error
            ? statusMutation.error.message
            : "Reservation status could not be updated."}
        </p>
      ) : null}

      {reservationsQuery.isPending ? (
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading upcoming reservations…
        </div>
      ) : reservations.length === 0 ? (
        <EmptyState
          title="No upcoming reservations"
          description="Confirmed guest reservations for the next 30 days will appear here."
        />
      ) : (
        <div className="space-y-3">
          {reservations.map((reservation: any) => (
            <article key={reservation.id} className="rounded-xl border border-border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-semibold">{reservation.guest_name}</h2>
                    <Badge variant={reservation.status === "confirmed" ? "default" : "secondary"}>
                      {reservation.status.replaceAll("_", " ")}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {reservation.booking_reference} · {reservation.guest_phone_e164}
                  </p>
                </div>
                <div className="text-right text-sm">
                  <p className="font-medium">
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: timezone,
                    }).format(new Date(reservation.starts_at))}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Intl.DateTimeFormat(undefined, {
                      timeStyle: "short",
                      timeZone: timezone,
                    }).format(new Date(reservation.ends_at))}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1"><Users className="size-4" /> {reservation.party_size} guests</span>
                <span className="inline-flex items-center gap-1"><Clock3 className="size-4" /> Table {reservation.restaurant_tables?.code ?? "Unassigned"}</span>
                <span>Source: {reservation.source.replaceAll("_", " ")}</span>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {reservation.status === "confirmed" ? (
                  <Button
                    size="sm"
                    disabled={statusMutation.isPending}
                    onClick={() => statusMutation.mutate({ reservationId: reservation.id, status: "seated" })}
                  >
                    <Check className="mr-1 size-3.5" /> Seat guest
                  </Button>
                ) : null}
                {reservation.status === "seated" ? (
                  <Button
                    size="sm"
                    disabled={statusMutation.isPending}
                    onClick={() => statusMutation.mutate({ reservationId: reservation.id, status: "completed" })}
                  >
                    Complete
                  </Button>
                ) : null}
                {["requested", "confirmed"].includes(reservation.status) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={statusMutation.isPending}
                    onClick={() => statusMutation.mutate({ reservationId: reservation.id, status: "cancelled" })}
                  >
                    Cancel
                  </Button>
                ) : null}
                {reservation.status === "confirmed" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={statusMutation.isPending}
                    onClick={() => statusMutation.mutate({ reservationId: reservation.id, status: "no_show" })}
                  >
                    No-show
                  </Button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
