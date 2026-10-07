/**
 * LexiBite operational service configuration.
 *
 * Service/fulfilment is intentionally independent from payment timing.
 * Payment policy may consume the resolved service mode for its automatic
 * default, but never becomes the source of truth for how an operation serves
 * a guest.
 */
export const SERVICE_MODES = [
  "table_service",
  "self_service",
  "counter_service",
  "takeaway",
  "room_service",
] as const;
export type ServiceMode = (typeof SERVICE_MODES)[number];

export const SERVICE_MODE_LABELS: Record<ServiceMode, string> = {
  table_service: "Table service",
  self_service: "Self-service / collection",
  counter_service: "Counter service",
  takeaway: "Takeaway",
  room_service: "Room service",
};

export const COLLECTION_METHODS = [
  "staff_serves",
  "guest_collects",
  "pickup_counter",
  "room_delivery",
] as const;
export type CollectionMethod = (typeof COLLECTION_METHODS)[number];

export const COLLECTION_METHOD_LABELS: Record<CollectionMethod, string> = {
  staff_serves: "Staff serves",
  guest_collects: "Guest collects",
  pickup_counter: "Pickup counter",
  room_delivery: "Room delivery",
};

export const SERVICE_MODE_SETTINGS = ["auto", ...SERVICE_MODES] as const;
export type ServiceModeSetting = (typeof SERVICE_MODE_SETTINGS)[number];

export const COLLECTION_METHOD_SETTINGS = ["auto", ...COLLECTION_METHODS] as const;
export type CollectionMethodSetting = (typeof COLLECTION_METHOD_SETTINGS)[number];

export interface ResolvedServiceConfiguration {
  serviceMode: ServiceMode;
  collectionMethod: CollectionMethod;
  readyAlert: boolean;
}

function defaultServiceModeForOperatingMode(operatingMode: unknown): ServiceMode {
  switch (String(operatingMode ?? "")) {
    case "counter_service":
      return "counter_service";
    case "quick_service":
      return "takeaway";
    case "bar_service":
      return "table_service";
    default:
      return "table_service";
  }
}

function defaultCollectionMethodForServiceMode(serviceMode: ServiceMode): CollectionMethod {
  switch (serviceMode) {
    case "self_service":
      return "guest_collects";
    case "counter_service":
    case "takeaway":
      return "pickup_counter";
    case "room_service":
      return "room_delivery";
    default:
      return "staff_serves";
  }
}

function defaultReadyAlertForServiceMode(serviceMode: ServiceMode): boolean {
  return ["self_service", "counter_service", "takeaway"].includes(serviceMode);
}

export function resolveServiceConfiguration(settings: unknown): ResolvedServiceConfiguration {
  const root = (settings ?? {}) as {
    operations?: {
      serviceMode?: unknown;
      collectionMethod?: unknown;
      readyAlert?: unknown;
    };
    onboarding?: { operatingMode?: unknown };
  };

  const configuredMode = root.operations?.serviceMode;
  const serviceMode =
    SERVICE_MODES.includes(configuredMode as ServiceMode)
      ? (configuredMode as ServiceMode)
      : defaultServiceModeForOperatingMode(root.onboarding?.operatingMode);

  const configuredCollection = root.operations?.collectionMethod;
  const collectionMethod =
    COLLECTION_METHODS.includes(configuredCollection as CollectionMethod)
      ? (configuredCollection as CollectionMethod)
      : defaultCollectionMethodForServiceMode(serviceMode);

  const readyAlert =
    typeof root.operations?.readyAlert === "boolean"
      ? root.operations.readyAlert
      : defaultReadyAlertForServiceMode(serviceMode);

  return { serviceMode, collectionMethod, readyAlert };
}
