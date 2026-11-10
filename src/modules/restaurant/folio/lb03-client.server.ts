import { createHash, randomBytes } from "node:crypto";
import { decryptLb01PeerCredential, validateLb01PeerBaseUrl } from "@/modules/api-platform/lb01.handoff.server";
import { signLb01Request } from "@/modules/api-platform/lb01.service-auth";

type Db = {
 from(table:string):any;
};
type RoomChargeInput = {
 bookingId:string; amount:number; currency:string; description:string; idempotencyKey:string;
 source?:{tenantId?:string;propertyId?:string;locationId?:string;orderId?:string;correlationId?:string};
};
type Result = {status:"posted"|"failed"|"unknown";duplicate:boolean;postingId?:string|null;postingReference?:string|null;folioReference?:string|null;amount?:number;currency?:string;failureCode?:any;failureMessage?:string};

function uuid(){return crypto.randomUUID();}
function stableFingerprint(value:unknown){return createHash("sha256").update(JSON.stringify(value)).digest("hex");}

async function signedPost(url:URL,token:string,body:Record<string,unknown>){
 const rawBody=JSON.stringify(body);
 const timestamp=String(Math.floor(Date.now()/1000));
 const nonce=randomBytes(24).toString("base64url");
 const signature=signLb01Request(token.split("_").slice(3).join("_"),{
  method:"POST",pathname:url.pathname+url.search,rawBody,timestamp,nonce
 });
 return fetch(url,{method:"POST",redirect:"manual",headers:{
  authorization:"Bearer "+token,"content-type":"application/json",
  "x-lb01-timestamp":timestamp,"x-lb01-nonce":nonce,"x-lb01-signature":signature
 },body:rawBody,signal:AbortSignal.timeout(10000)});
}

export async function postStayNasRoomCharge(sb:Db,userId:string,input:RoomChargeInput):Promise<Result>{
 const source=input.source??{};
 if(!source.tenantId||!source.propertyId||!source.locationId||!source.orderId)
  return {status:"failed",duplicate:false,failureCode:"invalid_amount",failureMessage:"The POS transaction is missing its property or outlet mapping."};

 const {supabaseAdmin}=await import("@/integrations/supabase/client.server");
 const admin=supabaseAdmin as unknown as Db;
 const {data:order,error:orderError}=await sb.from("restaurant_orders")
  .select("id,tenant_id,property_id,location_id,total,currency,tax_total,service_charge,discount_total")
  .eq("id",source.orderId).eq("tenant_id",source.tenantId).single();
 if(orderError||!order||order.property_id!==source.propertyId||order.location_id!==source.locationId)
  return {status:"failed",duplicate:false,failureCode:"posting_rejected",failureMessage:"The originating POS order could not be verified."};

 const {data:connection,error:connectionError}=await admin.from("staynas_product_connections")
  .select("id,local_tenant_id,local_property_id,remote_tenant_id,remote_property_id,integration_property_id,correlation_id,remote_product,status,local_approved_at,remote_approved_at")
  .eq("local_tenant_id",source.tenantId).eq("local_property_id",source.propertyId)
  .eq("remote_product","staynas").eq("status","active").maybeSingle();
 if(connectionError||!connection||!connection.local_approved_at||!connection.remote_approved_at)
  return {status:"failed",duplicate:false,failureCode:"folio_unavailable",failureMessage:"No mutually approved StayNas property connection is available."};

 const {data:mapping,error:mappingError}=await admin.from("lb02_outlet_property_mappings")
  .select("local_outlet_id,integration_property_id,approval_status,guest_visible_status")
  .eq("connection_id",connection.id).eq("local_outlet_id",source.locationId).maybeSingle();
 if(mappingError||!mapping||mapping.approval_status!=="approved"||mapping.guest_visible_status!=="open")
  return {status:"failed",duplicate:false,failureCode:"room_not_eligible",failureMessage:"This outlet is not approved for room charging."};

 const {data:stay,error:stayError}=await admin.from("lb02_guest_stay_projections")
  .select("guest_reference,stay_reference,stay_status,integration_property_id,revoked_at")
  .eq("connection_id",connection.id).eq("integration_property_id",connection.integration_property_id)
  .eq("stay_reference",input.bookingId).maybeSingle();
 if(stayError||!stay||stay.revoked_at||stay.stay_status!=="checked_in")
  return {status:"failed",duplicate:false,failureCode:"stay_not_active",failureMessage:"The selected guest stay is not currently checked in."};

 const currency=String(order.currency??"").toUpperCase();
 if(!/^[A-Z]{3}$/.test(currency)||currency!==input.currency.toUpperCase())
  return {status:"failed",duplicate:false,failureCode:"currency_mismatch",failureMessage:"The POS order currency does not match the requested room charge."};
 const amount=Number(input.amount);
 if(!Number.isFinite(amount)||amount<=0||Math.round(amount*100)!==amount*100||amount>Number(order.total))
  return {status:"failed",duplicate:false,failureCode:"invalid_amount",failureMessage:"The requested amount is not a valid POS transaction amount."};

 const taxBreakdown=Number(order.tax_total)>0?[{component:"POS_TAX",amount:Number(order.tax_total)}]:[];
 const payload={
  posTransactionId:order.id,posTenantId:connection.remote_tenant_id,
  posPropertyId:connection.remote_property_id,integrationPropertyId:connection.integration_property_id,
  outletReference:source.locationId,guestReference:stay.guest_reference,stayReference:stay.stay_reference,
  currency,amount,taxBreakdown,serviceCharge:Number(order.service_charge??0),
  discountAmount:Number(order.discount_total??0),correlationId:connection.correlation_id
 };
 const fingerprint=stableFingerprint(payload);
 const {data:existing}=await admin.from("lb03_pos_room_charge_operations")
  .select("*").eq("tenant_id",source.tenantId).eq("order_id",order.id).maybeSingle();
 if(existing){
  if(existing.request_fingerprint!==fingerprint||existing.idempotency_key!==input.idempotencyKey)
   return {status:"failed",duplicate:false,failureCode:"posting_rejected",failureMessage:"The POS transaction is already bound to a different room-charge request."};
  if(existing.state==="POSTED") return {status:"posted",duplicate:true,postingId:existing.staynas_posting_id,
   postingReference:existing.staynas_posting_reference,amount:Number(existing.amount),currency:existing.currency};
 }

 const operationId=existing?.id??uuid();
 const requestId=existing?.request_id??uuid();
 if(!existing){
  const {error}=await admin.from("lb03_pos_room_charge_operations").insert({
   id:operationId,tenant_id:source.tenantId,property_id:source.propertyId,outlet_id:source.locationId,
   order_id:order.id,integration_connection_id:connection.id,integration_property_id:connection.integration_property_id,
   guest_reference:stay.guest_reference,stay_reference:stay.stay_reference,request_id:requestId,
   idempotency_key:input.idempotencyKey,request_fingerprint:fingerprint,amount,currency,
   tax_breakdown:taxBreakdown,service_charge:Number(order.service_charge??0),
   discount_amount:Number(order.discount_total??0),correlation_id:connection.correlation_id,
   state:"AUTHORIZATION_PENDING"
  });
  if(error) return {status:"unknown",duplicate:false,failureCode:"unknown",failureMessage:"Room-charge request persistence is uncertain; verify the integration record before retrying."};
 }

 const {data:peer,error:peerError}=await admin.from("lb01_peer_credentials")
  .select("peer_product,encrypted_token,encryption_iv,encryption_tag,status")
  .eq("connection_id",connection.id).maybeSingle();
 if(peerError||!peer||peer.status!=="active")
  return {status:"failed",duplicate:false,failureCode:"folio_unavailable",failureMessage:"The StayNas service credential is unavailable."};

 let token:string;
 try{token=decryptLb01PeerCredential({ciphertext:peer.encrypted_token,iv:peer.encryption_iv,
  tag:peer.encryption_tag,connectionId:connection.id,peerProduct:"staynas"});}
 catch{return {status:"failed",duplicate:false,failureCode:"folio_unavailable",failureMessage:"The StayNas service credential could not be validated."};}

 try{
  const base=validateLb01PeerBaseUrl();
  const authUrl=new URL("/api/integrations/lb03/authorize",base);
  const authResponse=await signedPost(authUrl,token,{
   requestId,idempotencyKey:input.idempotencyKey,...payload
  });
  if(!authResponse.ok){
   await admin.from("lb03_pos_room_charge_operations").update({state:"REJECTED",last_error_code:"authorization_rejected",updated_at:new Date().toISOString()}).eq("id",operationId);
   return {status:"failed",duplicate:false,failureCode:"posting_rejected",failureMessage:"StayNas rejected the room-charge authorization."};
  }
  const authorization=await authResponse.json() as {status:string;authorizationReference:string;expiresAt?:string};
  if(authorization.status!=="AUTHORIZED"||!authorization.authorizationReference)
   return {status:"unknown",duplicate:false,failureCode:"unknown",failureMessage:"StayNas did not return a confirmed authorization decision."};
  await admin.from("lb03_pos_room_charge_operations").update({
   state:"POSTING_PENDING",authorization_reference:authorization.authorizationReference,
   authorization_expires_at:authorization.expiresAt??null,updated_at:new Date().toISOString()
  }).eq("id",operationId);

  const postUrl=new URL("/api/integrations/lb03/post",base);
  const postResponse=await signedPost(postUrl,token,{
   authorizationReference:authorization.authorizationReference,idempotencyKey:input.idempotencyKey,
   description:input.description
  });
  if(!postResponse.ok)
   return {status:"unknown",duplicate:false,failureCode:"unknown",failureMessage:"Posting outcome is uncertain. Recover using the same idempotency key; do not take another tender until verified."};
  const posted=await postResponse.json() as {status:string;postingId:string;postingReference:string;folioReference:string;amount:number;currency:string;duplicate?:boolean};
  if(posted.status!=="POSTED"||!posted.postingReference)
   return {status:"unknown",duplicate:false,failureCode:"unknown",failureMessage:"StayNas did not confirm a durable folio posting."};
  await admin.from("lb03_pos_room_charge_operations").update({
   state:"POSTED",staynas_posting_id:posted.postingId,staynas_posting_reference:posted.postingReference,
   updated_at:new Date().toISOString()
  }).eq("id",operationId);
  return {status:"posted",duplicate:Boolean(posted.duplicate),postingId:posted.postingId,
   postingReference:posted.postingReference,folioReference:posted.folioReference,
   amount:Number(posted.amount),currency:String(posted.currency)};
 }catch{
  await admin.from("lb03_pos_room_charge_operations").update({
   state:"RECONCILIATION_REQUIRED",last_error_code:"peer_delivery_unknown",
   attempt_count:Number(existing?.attempt_count??0)+1,next_attempt_at:new Date(Date.now()+30000).toISOString(),
   updated_at:new Date().toISOString()
  }).eq("id",operationId);
  return {status:"unknown",duplicate:false,failureCode:"unknown",failureMessage:"StayNas delivery was interrupted. The POS request is retained for idempotent recovery."};
 }
}
