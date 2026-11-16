/** Deterministic Phase 4 cost reconciliation kernel. Monetary values are integer minor units. */
export type VarianceKind = "stock_quantity" | "purchase_price" | "operating_expense" | "allocation" | "data_integrity";
export type Severity = "info" | "low" | "medium" | "high" | "critical";
export interface ReconciliationInput { tenantId:string; propertyId:string|null; periodStart:string; currency:string; expectedMinor:number; actualMinor:number; sourceType:string; sourceId:string; kind:VarianceKind; thresholdMinor?:number }
export interface ReconciliationVariance { tenantId:string; propertyId:string|null; periodStart:string; currency:string; sourceType:string; sourceId:string; kind:VarianceKind; expectedMinor:number; actualMinor:number; varianceMinor:number; severity:Severity; explanation:string }
const minor=(v:number,label:string)=>{if(!Number.isSafeInteger(v)||v<0)throw new Error(label+" must be a non-negative safe integer in minor units");return v};
export function reconcileCost(i:ReconciliationInput):ReconciliationVariance|null {
 if(!i.tenantId||!i.sourceId||!i.sourceType)throw new Error("Tenant and source identity are required");
 if(!/^[A-Z]{3}$/.test(i.currency))throw new Error("Currency must be a three-letter uppercase code");
 if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(i.periodStart)||(Number.isNaN(Date.parse(i.periodStart))||new Date(i.periodStart).toISOString().slice(0,10)!==i.periodStart))throw new Error("Period start must be a valid ISO date");
 const expected=minor(i.expectedMinor,"Expected amount"),actual=minor(i.actualMinor,"Actual amount"),threshold=minor(i.thresholdMinor??0,"Threshold");
 const delta=actual-expected,magnitude=Math.abs(delta);if(delta===0||magnitude<=threshold)return null;
 const severity:Severity=magnitude>=10000000?"critical":magnitude>=1000000?"high":magnitude>=100000?"medium":magnitude>=10000?"low":"info";
 return {...i,expectedMinor:expected,actualMinor:actual,varianceMinor:delta,severity,explanation:delta>0?"Actual cost exceeds expected cost by "+magnitude+" minor units.":"Actual cost is below expected cost by "+magnitude+" minor units."};
}
export function reconcileAllocation(sourceMinor:number,allocatedMinor:number,unallocatedMinor:number){minor(sourceMinor,"Source");minor(allocatedMinor,"Allocated");minor(unallocatedMinor,"Unallocated");if(allocatedMinor+unallocatedMinor!==sourceMinor)throw new Error("Allocation does not reconcile to the source amount");return{sourceMinor,allocatedMinor,unallocatedMinor,balanced:true as const}}
export function comparePurchasePrice(i:{expectedUnitMinor:number;actualUnitMinor:number;expectedUnit:string;actualUnit:string;expectedCurrency:string;actualCurrency:string}){if(i.expectedUnit!==i.actualUnit||i.expectedCurrency!==i.actualCurrency)return{comparable:false as const,varianceMinor:null};minor(i.expectedUnitMinor,"Expected unit price");minor(i.actualUnitMinor,"Actual unit price");return{comparable:true as const,varianceMinor:i.actualUnitMinor-i.expectedUnitMinor}}
export function assertUniqueSources(rows:Array<{tenantId:string;sourceType:string;sourceId:string}>){const seen=new Set<string>();for(const r of rows){const k=[r.tenantId,r.sourceType,r.sourceId].join(":");if(seen.has(k))throw new Error("Duplicate reconciliation source: "+k);seen.add(k)}}
