# LB-01.04 — secure connection handoff and approval operations

Status: implementation branch only; production activation remains disabled until configuration and UAT acceptance.

## Product boundaries

StayNas and LexiBite continue to use separate Supabase projects, auth, tenant records and operational databases. The integration stores only reciprocal mapping metadata and encrypted peer credentials. It does not copy guests, reservations, POS orders, inventory, payments or folio records.

## Server environment

Configure these values independently in each product's server environment:

| Variable | StayNas deployment | LexiBite deployment |
|---|---|---|
| `LB01_PEER_BASE_URL` | Exact HTTPS origin of the LexiBite deployment | Exact HTTPS origin of the StayNas deployment |
| `LB01_PEER_CREDENTIAL_ENCRYPTION_KEY` | A unique 32-byte key encoded as 64 hex characters | A different unique 32-byte key encoded as 64 hex characters |

Generate each encryption key independently with:

```sh
openssl rand -hex 32
```

Do not share the encryption keys between products, environments, tenants, or deployments. Store them only as server-side environment variables; never use a `VITE_` prefix. Do not place values in source control, client-side settings, logs, or support tickets.

The peer URL must be the HTTPS origin only (scheme + host, no path, query or fragment). The application constructs the fixed LB-01 API paths itself. The URL is trusted deployment configuration, not tenant input.

Existing Supabase server configuration remains required: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and the server-only service-role key used by the existing admin client.

## Pairing procedure

1. An authorized owner/manager opens **LexiBite Connection** in StayNas or **StayNas Connection** in LexiBite.
2. The initiating administrator creates a mapping using their local property ID and the peer's native tenant/property IDs. The application generates canonical integration IDs and a correlation ID.
3. Share the returned pairing-invitation JSON with the peer administrator using an approved private channel. It contains identifiers only, not credentials.
4. The peer administrator pastes the invitation, selects their own local property ID, and creates the reciprocal mapping. The correlation ID and canonical integration IDs must match.
5. Each administrator selects **Issue handoff code** on their own mapping and shares the short-lived code with the peer administrator.
6. Each administrator imports the code received from the peer. The receiving server exchanges it directly with the peer server over HTTPS. The long-lived bearer credential is never returned to the browser and is encrypted with AES-256-GCM before storage.
7. Both administrators select **Approve and notify peer**. The signed approval request is delivered using HMAC-SHA256, timestamp and a durable nonce. A mapping becomes active only when both local approval and peer approval evidence exist.
8. If a delivery fails, use **Retry delivery**. The receiver's approval RPC is idempotent; a fresh nonce is used for each retry.

## Credential and recovery behavior

- Issued peer credentials have a 90-day expiry and are stored as SHA-256 hashes in the issuing product.
- Handoff codes contain 256 bits of random entropy, are stored only as SHA-256 hashes, and expire after 15 minutes.
- A consumed handoff can be retried for two minutes to recover from a lost HTTP response; it cannot be exchanged after that recovery window.
- Re-issuing a credential rotates and revokes the previous credential for that connection.
- Connection revocation immediately invalidates locally issued service credentials and unused handoff codes.
- Peer credentials are encrypted with AES-256-GCM using connection/product-bound additional authenticated data.
- Missing keys, malformed origins, invalid credentials, expired codes, mismatched correlation IDs and cross-property authorization failures are fail-closed.
- The API returns only safe outcome codes. It does not return stored tokens or encrypted material to the browser.

## Operational restrictions

The migration is additive and must first pass the isolated PostgreSQL workflow. It is not applied to either production Supabase project by this implementation commit. No production tenant, property, membership or role records are changed. No live credentials are issued by CI. No Vercel deployment is initiated by this work.

Before production activation, configure the two product environments with the peer origins and independently generated keys, run the approved migration in each product's normal migration process, then complete a two-property UAT pairing, approval, replay, expiry, rotation and revocation test. Production promotion requires a separate explicit approval.
