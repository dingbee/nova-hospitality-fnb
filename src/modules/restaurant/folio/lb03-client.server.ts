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

export async function postStayNasRoomCharge(sb:Db,input:RoomChargeInput):Promise<Result>{
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
  await admin.from("lb03_pos_room_charge_outbox").update({state:"delivered",delivered_at:new Date().toISOString()})
   .eq("operation_id",operationId).eq("event_type","authorize").eq("idempotency_key",input.idempotencyKey);
  const authorization=await authResponse.json() as {status:string;authorizationReference:string;expiresAt?:string;postingId?:string;postingReference?:string;folioReference?:string;amount?:number;currency?:string;duplicate?:boolean};
  if(authorization.status==="POSTED"&&authorization.postingReference){
   await admin.from("lb03_pos_room_charge_operations").update({state:"POSTED",staynas_posting_id:authorization.postingId??null,
    staynas_posting_reference:authorization.postingReference,updated_at:new Date().toISOString()}).eq("id",operationId);
   return {status:"posted",duplicate:true,postingId:authorization.postingId??null,
    postingReference:authorization.postingReference,folioReference:authorization.folioReference??null,
    amount:Number(authorization.amount??amount),currency:String(authorization.currency??currency)};
  }
  if(["REJECTED","EXPIRED"].includes(authorization.status)){
   await admin.from("lb03_pos_room_charge_operations").update({state:authorization.status,last_error_code:authorization.status.toLowerCase(),updated_at:new Date().toISOString()}).eq("id",operationId);
   return {status:"failed",duplicate:false,failureCode:"posting_rejected",failureMessage:authorization.status==="EXPIRED"?"StayNas authorization expired before posting.":"StayNas rejected the room-charge authorization."};
  }
  if(authorization.status!=="AUTHORIZED"||!authorization.authorizationReference)
   return {status:"unknown",duplicate:false,failureCode:"unknown",failureMessage:"StayNas did not return a confirmed authorization decision."};
  await admin.from("lb03_pos_room_charge_operations").update({
   state:"POSTING_PENDING",authorization_reference:authorization.authorizationReference,
   authorization_expires_at:authorization.expiresAt??null,updated_at:new Date().toISOString()
  }).eq("id",operationId);

  await admin.from("lb03_pos_room_charge_outbox").insert({operation_id:operationId,event_type:"post",
   idempotency_key:input.idempotencyKey,payload:{authorizationReference:authorization.authorizationReference,
    posTransactionId:order.id,amount,currency},state:"pending",available_at:new Date().toISOString()});
  const postUrl=new URL("/api/integrations/lb03/post",base);
  const postResponse=await signedPost(postUrl,token,{
   authorizationReference:authorization.authorizationReference,idempotencyKey:input.idempotencyKey,
   description:input.description
  });
  if(!postResponse.ok)
   return {status:"unknown",duplicate:false,failureCode:"unknown",failureMessage:"Posting outcome is uncertain. Recover using the same idempotency key; do not take another tender until verified."};
  const posted=await postResponse.json() as {status:string;postingId:string;postingReference:string;folioReference:string;amount:number;currency:string;duplicate?:boolean};
  if(posted.status==="POSTING_FAILED"||posted.status==="EXPIRED"){
   await admin.from("lb03_pos_room_charge_operations").update({state:posted.status,last_error_code:posted.status.toLowerCase(),updated_at:new Date().toISOString()}).eq("id",operationId);
   return {status:"failed",duplicate:false,failureCode:"posting_rejected",failureMessage:"StayNas did not accept the folio posting."};
  }
  if(posted.status!=="POSTED"||!posted.postingReference)
   return {status:"unknown",duplicate:false,failureCode:"unknown",failureMessage:"StayNas did not confirm a durable folio posting."};
  await admin.from("lb03_pos_room_charge_outbox").update({state:"delivered",delivered_at:new Date().toISOString()})
   .eq("operation_id",operationId).eq("event_type","post").eq("idempotency_key",input.idempotencyKey);
  await admin.from("lb03_pos_room_charge_operations").update({
   state:"POSTED",staynas_posting_id:posted.postingId,staynas_posting_reference:posted.postingReference,
   updated_at:new Date().toISOString()
  }).eq("id",operationId);
  return {status:"posted",duplicate:Boolean(posted.duplicate),postingId:posted.postingId,
   postingReference:posted.postingReference,folioReference:posted.folioReference,
   amount:Number(posted.amount),currency:String(posted.currency)};
 }catch{
  // Resolve uncertain delivery against StayNas' durable operation and actual folio posting.
  try{
   const base=validateLb01PeerBaseUrl();
   const statusResponse=await signedPost(new URL("/api/integrations/lb03/status",base),token,{
    idempotencyKey:input.idempotencyKey,posTransactionId:order.id
   });
   if(statusResponse.ok){
    const truth=await statusResponse.json() as {status:string;authorizationReference?:string;posting?:{id:string;status:string;posting_reference:string;folio_reference:string;amount:number;currency:string}|null};
    if(truth.status==="POSTED"&&truth.posting?.status==="posted"){
     await admin.from("lb03_pos_room_charge_operations").update({
      state:"POSTED",staynas_posting_id:truth.posting.id,staynas_posting_reference:truth.posting.posting_reference,
      updated_at:new Date().toISOString()
     }).eq("id",operationId);
     return {status:"posted",duplicate:true,postingId:truth.posting.id,
      postingReference:truth.posting.posting_reference,folioReference:truth.posting.folio_reference,
      amount:Number(truth.posting.amount),currency:truth.posting.currency};
    }
    if(truth.status==="AUTHORIZED"&&truth.authorizationReference){
     const retry=await signedPost(new URL("/api/integrations/lb03/post",base),token,{
      authorizationReference:truth.authorizationReference,idempotencyKey:input.idempotencyKey,description:input.description
     });
     if(retry.ok){
      const posted=await retry.json() as {status:string;postingId:string;postingReference:string;folioReference:string;amount:number;currency:string};
      if(posted.status==="POSTED"&&posted.postingReference){
       await admin.from("lb03_pos_room_charge_operations").update({
        state:"POSTED",staynas_posting_id:posted.postingId,staynas_posting_reference:posted.postingReference,
        updated_at:new Date().toISOString()
       }).eq("id",operationId);
       return {status:"posted",duplicate:true,postingId:posted.postingId,
        postingReference:posted.postingReference,folioReference:posted.folioReference,
        amount:Number(posted.amount),currency:posted.currency};
      }
     }
    }
   }
  }catch{/* Preserve unknown; never infer success from a failed recovery request. */}
  await admin.from("lb03_pos_room_charge_operations").update({
   state:"RECONCILIATION_REQUIRED",last_error_code:"peer_delivery_unknown",
   attempt_count:Number(existing?.attempt_count??0)+1,next_attempt_at:new Date(Date.now()+30000).toISOString(),
   updated_at:new Date().toISOString()
  }).eq("id",operationId);
  return {status:"unknown",duplicate:false,failureCode:"unknown",failureMessage:"StayNas delivery remains uncertain. The POS request is retained; do not take another tender until authoritative status is recovered."};
 }
}

export async function requestStayNasRoomChargeReversal(input:{
 tenantId:string;orderId:string;amount:number;reasonCode:"pos_void"|"incorrect_amount"|"duplicate_charge"|"guest_dispute"|"service_recovery"|"other";
 reason:string;idempotencyKey:string;
}):Promise<{status:string;requestId?:string;duplicate?:boolean}>{
 const {supabaseAdmin}=await import("@/integrations/supabase/client.server");
 const admin=supabaseAdmin as unknown as Db;
 const {data:operation,error}=await admin.from("lb03_pos_room_charge_operations")
  .select("id,integration_connection_id,state,staynas_posting_reference,amount,currency,reversed_amount")
  .eq("tenant_id",input.tenantId).eq("order_id",input.orderId).maybeSingle();
 if(error||!operation||!operation.staynas_posting_reference||!["POSTED","PARTIALLY_REVERSED","RECONCILED","RECONCILIATION_REQUIRED"].includes(operation.state))
  throw new Error("The POS transaction has no confirmed StayNas posting eligible for reversal.");
 if(input.amount<=0||input.amount>Number(operation.amount)-Number(operation.reversed_amount??0))
  throw new Error("The requested reversal exceeds the original room charge.");
 const {data:connection,error:connectionError}=await admin.from("staynas_product_connections")
  .select("id,status,local_approved_at,remote_approved_at,correlation_id")
  .eq("id",operation.integration_connection_id).maybeSingle();
 if(connectionError||!connection||connection.status!=="active"||!connection.local_approved_at||!connection.remote_approved_at)
  throw new Error("The StayNas connection is not active.");
 const {data:peer,error:peerError}=await admin.from("lb01_peer_credentials")
  .select("peer_product,encrypted_token,encryption_iv,encryption_tag,status")
  .eq("connection_id",connection.id).maybeSingle();
 if(peerError||!peer||peer.status!=="active")throw new Error("StayNas service credential unavailable.");
 const token=decryptLb01PeerCredential({ciphertext:peer.encrypted_token,iv:peer.encryption_iv,
  tag:peer.encryption_tag,connectionId:connection.id,peerProduct:"staynas"});
 const base=validateLb01PeerBaseUrl();
 const response=await signedPost(new URL("/api/integrations/lb03/reversal-request",base),token,{
  postingReference:operation.staynas_posting_reference,idempotencyKey:input.idempotencyKey,
  amount:input.amount,reasonCode:input.reasonCode,reason:input.reason
 });
 if(!response.ok)throw new Error("StayNas did not accept the reversal request.");
 const result=await response.json() as {status:string;requestId?:string;duplicate?:boolean};
 if(result.status!=="PENDING_APPROVAL"&&result.status!=="POSTED")
  throw new Error("StayNas returned an unexpected reversal state.");
 await admin.from("lb03_pos_room_charge_operations").update({
  state:"REVERSAL_PENDING",updated_at:new Date().toISOString()
 }).eq("id",operation.id);
 return result;
}

export async function getStayNasRoomChargeStatus(input:{tenantId:string;orderId?:string;idempotencyKey?:string;postingId?:string}){
 const {supabaseAdmin}=await import("@/integrations/supabase/client.server");
 const admin=supabaseAdmin as unknown as Db;
 let query=admin.from("lb03_pos_room_charge_operations").select("*").eq("tenant_id",input.tenantId);
 if(input.orderId)query=query.eq("order_id",input.orderId);
 if(input.idempotencyKey)query=query.eq("idempotency_key",input.idempotencyKey);
 if(input.postingId)query=query.eq("staynas_posting_id",input.postingId);
 const {data:operation,error}=await query.maybeSingle();
 if(error||!operation)return {operations:[],authoritative:false};
 const {data:peer}=await admin.from("lb01_peer_credentials")
  .select("peer_product,encrypted_token,encryption_iv,encryption_tag,status")
  .eq("connection_id",operation.integration_connection_id).maybeSingle();
 if(!peer||peer.status!=="active")return {operations:[operation],authoritative:false};
 try{
  const token=decryptLb01PeerCredential({ciphertext:peer.encrypted_token,iv:peer.encryption_iv,
   tag:peer.encryption_tag,connectionId:operation.integration_connection_id,peerProduct:"staynas"});
  const base=validateLb01PeerBaseUrl();
  const response=await signedPost(new URL("/api/integrations/lb03/status",base),token,{
   idempotencyKey:operation.idempotency_key,posTransactionId:operation.order_id
  });
  if(!response.ok)return {operations:[operation],authoritative:false};
  const truth=await response.json() as {status:string;authorizationReference?:string;posting?:{id:string;status?:string;posting_reference:string;folio_reference:string;amount:number;currency:string}|null;postings?:Array<{id:string;status:string;amount:number;currency:string}>;reversedAmount?:number;reversalReference?:string};
  const state=truth.status;
  const allowed=["AUTHORIZED","EXPIRED","POSTING_PENDING","POSTED","POSTING_FAILED","REVERSAL_PENDING","PARTIALLY_REVERSED","REVERSED","RECONCILIATION_REQUIRED","RECONCILED","DUPLICATE_POSTING","NOT_FOUND"];
  if(!allowed.includes(state))return {operations:[operation],authoritative:false};
  const patch:Record<string,unknown>={state,updated_at:new Date().toISOString()};
  if(truth.posting?.id)patch.staynas_posting_id=truth.posting.id;
  if(truth.posting?.posting_reference)patch.staynas_posting_reference=truth.posting.posting_reference;
  if(truth.reversedAmount!=null)patch.reversed_amount=truth.reversedAmount;
  if(truth.reversalReference)patch.reversal_reference=truth.reversalReference;

  let outcome:"MATCHED"|"MISSING_IN_STAYNAS"|"MISSING_IN_LEXIBITE"|"AMOUNT_MISMATCH"|"CURRENCY_MISMATCH"|"DUPLICATE_POSTING"|"STATUS_MISMATCH"|"REVERSAL_MISMATCH"|"PENDING_REVIEW"="PENDING_REVIEW";
  const posting=truth.posting??null;
  if(state==="DUPLICATE_POSTING")outcome="DUPLICATE_POSTING";
  else if(state==="NOT_FOUND"||(state==="RECONCILIATION_REQUIRED"&&!posting))outcome="MISSING_IN_STAYNAS";
  else if(posting&&Number(posting.amount)!==Number(operation.amount))outcome="AMOUNT_MISMATCH";
  else if(posting&&String(posting.currency).toUpperCase()!==String(operation.currency).toUpperCase())outcome="CURRENCY_MISMATCH";
  else if(posting&&posting.status!=="posted")outcome="STATUS_MISMATCH";
  else if(posting&&!operation.pos_payment_id)outcome="MISSING_IN_LEXIBITE";
  else if(posting&&Number(truth.reversedAmount??0)>0){
   const {data:refundRows}=await admin.from("restaurant_payments").select("amount")
    .eq("tenant_id",operation.tenant_id).eq("order_id",operation.order_id)
    .eq("refund_of",operation.pos_payment_id).eq("state","refunded");
   const posRefunded=((refundRows??[]) as Array<{amount:number}>).reduce((sum,row)=>sum+Math.abs(Number(row.amount)),0);
   if(Math.abs(posRefunded-Number(truth.reversedAmount))>0.001)outcome="REVERSAL_MISMATCH";
   else outcome="MATCHED";
  }else if(posting&&["POSTED","PARTIALLY_REVERSED","REVERSED"].includes(state))outcome="MATCHED";
  else if(["AUTHORIZED","POSTING_PENDING","REVERSAL_PENDING"].includes(state))outcome="PENDING_REVIEW";
  else outcome="STATUS_MISMATCH";

  const {error:reconcileError}=await admin.from("lb03_pos_room_charge_reconciliation").insert({
   operation_id:operation.id,outcome,pos_amount:operation.amount,staynas_amount:posting?.amount??null,
   pos_currency:operation.currency,staynas_currency:posting?.currency??null,
   evidence:{stayNasState:state,posting:posting??null,postings:truth.postings??null,
    reversedAmount:truth.reversedAmount??0,reversalReference:truth.reversalReference??null}
  });
  if(reconcileError)return {operations:[operation],authoritative:false,reconciliationError:true};
  if(outcome==="MATCHED")patch.state="RECONCILED";
  await admin.from("lb03_pos_room_charge_operations").update(patch).eq("id",operation.id);
  return {operations:[{...operation,...patch,authoritativePosting:posting}],authoritative:true,reconciliation:{outcome}};

 }catch{return {operations:[operation],authoritative:false};}
}
