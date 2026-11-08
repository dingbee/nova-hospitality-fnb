import { describe, expect, it } from "vitest";
import { financialReferenceSchema, integrationConnectionDescriptorSchema, integrationEventEnvelopeSchema, propertyMappingProposalSchema } from "./lb01.contracts";
const ids = { tenant:"10000000-0000-4000-8000-000000000001", property:"20000000-0000-4000-8000-000000000002", event:"30000000-0000-4000-8000-000000000003", aggregate:"40000000-0000-4000-8000-000000000004" };
describe("LB-01 integration contracts", () => {
  it("accepts mappings between distinct product identities", () => {
    expect(propertyMappingProposalSchema.safeParse({ integrationTenantId:ids.tenant, integrationPropertyId:ids.property, source:{product:"staynas",nativeTenantId:ids.tenant,nativePropertyId:ids.property}, target:{product:"lexibite",nativeTenantId:ids.aggregate,nativePropertyId:ids.event}, status:"pending", requestedAt:"2026-11-08T12:00:00Z", correlationId:"lb01-map-0001" }).success).toBe(true);
  });
  it("rejects mapping a product to itself", () => {
    const identity={product:"staynas",nativeTenantId:ids.tenant,nativePropertyId:ids.property};
    expect(propertyMappingProposalSchema.safeParse({integrationTenantId:ids.tenant,integrationPropertyId:ids.property,source:identity,target:identity,status:"pending",requestedAt:"2026-11-08T12:00:00Z",correlationId:"lb01-map-0002"}).success).toBe(false);
  });
  it("requires revocation evidence for revoked connections", () => {
    expect(integrationConnectionDescriptorSchema.safeParse({connectionId:ids.event,integrationTenantId:ids.tenant,localProduct:"staynas",remoteProduct:"lexibite",state:"revoked",grantedCapabilities:["property.read"],createdAt:"2026-11-08T12:00:00Z",updatedAt:"2026-11-08T12:01:00Z",revokedAt:null}).success).toBe(false);
  });
  it("requires UTC timestamps and rejects publication before occurrence", () => {
    const event={eventId:ids.event,eventType:"guest.checked_in",eventVersion:1,schemaVersion:"1.0.0",sourceProduct:"staynas",nativeTenantId:ids.tenant,integrationPropertyId:ids.property,aggregateId:ids.aggregate,occurredAt:"2026-11-08T12:02:00Z",publishedAt:"2026-11-08T12:01:00Z",correlationId:"lb01-event-0001",causationId:null,idempotencyKey:"lb01-idempotency-0001",payload:{bookingReference:"ST-001"}};
    expect(integrationEventEnvelopeSchema.safeParse(event).success).toBe(false);
    expect(integrationEventEnvelopeSchema.safeParse({...event,publishedAt:"2026-11-08T12:03:00Z"}).success).toBe(true);
    expect(integrationEventEnvelopeSchema.safeParse({...event,occurredAt:"2026-11-08T15:02:00+03:00",publishedAt:"2026-11-08T15:03:00+03:00"}).success).toBe(false);
  });
  it("requires ISO currency codes and integer minor-unit amounts", () => {
    expect(financialReferenceSchema.safeParse({externalTransactionReference:"folio-001",idempotencyKey:"lb01-finance-0001",currency:"TZS",amountMinor:250000,outcome:"pending",reversalOf:null,adjustmentOf:null}).success).toBe(true);
    expect(financialReferenceSchema.safeParse({externalTransactionReference:"folio-001",idempotencyKey:"lb01-finance-0001",currency:"TZ",amountMinor:25.5,outcome:"pending",reversalOf:null,adjustmentOf:null}).success).toBe(false);
  });
});
