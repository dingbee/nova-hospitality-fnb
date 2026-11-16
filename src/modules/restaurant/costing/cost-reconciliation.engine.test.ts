import {describe,expect,it} from "vitest";
import {assertUniqueSources,comparePurchasePrice,reconcileAllocation,reconcileCost} from "./cost-reconciliation.engine";
const base={tenantId:"t1",propertyId:"p1",periodStart:"2026-11-01",currency:"TZS",expectedMinor:10000,actualMinor:12500,sourceType:"stock_movement",sourceId:"m1",kind:"stock_quantity" as const};
describe("Phase 4 reconciliation kernel",()=>{
 it("omits balanced rows",()=>expect(reconcileCost({...base,actualMinor:10000})).toBeNull());
 it("records minor-unit variance",()=>expect(reconcileCost(base)?.varianceMinor).toBe(2500));
 it("applies configured threshold",()=>expect(reconcileCost({...base,thresholdMinor:2500})).toBeNull());
 it("rejects malformed currency and fractional minor units",()=>{expect(()=>reconcileCost({...base,currency:"TZS "})).toThrow();expect(()=>reconcileCost({...base,actualMinor:1.2})).toThrow()});
 it("requires exact allocation balance",()=>{expect(reconcileAllocation(10000,7000,3000).balanced).toBe(true);expect(()=>reconcileAllocation(10000,7000,2999)).toThrow()});
 it("compares only identical units and currencies",()=>{expect(comparePurchasePrice({expectedUnitMinor:100,actualUnitMinor:120,expectedUnit:"kg",actualUnit:"kg",expectedCurrency:"TZS",actualCurrency:"TZS"}).varianceMinor).toBe(20);expect(comparePurchasePrice({expectedUnitMinor:100,actualUnitMinor:120,expectedUnit:"kg",actualUnit:"g",expectedCurrency:"TZS",actualCurrency:"TZS"}).comparable).toBe(false)});
 it("rejects duplicate sources",()=>expect(()=>assertUniqueSources([{tenantId:"t",sourceType:"expense",sourceId:"x"},{tenantId:"t",sourceType:"expense",sourceId:"x"}])).toThrow());
});