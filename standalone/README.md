# Restaurant & Bar OS — standalone local runtime

Runs the F&B product on this machine only. Nothing here reads or writes the
hosted NOVA environment.

## Prerequisites (WSL2 / Ubuntu)
Docker Desktop with WSL integration, Bun, `psql` client.

## Start
```bash
cp standalone/.env.example standalone/.env   # edit the two passwords
./nova up
```
Then open `https://localhost:8443` and trust the generated local CA.
First run asks you to create the administrator; re-run `./nova seed` afterwards
so that user is attached as owner of the demo tenant.

Other commands: `./nova status`, `./nova logs`, `./nova down`, `./nova reset`.

## What it installs
- PostgreSQL 17 in Docker (`127.0.0.1:55432`, volume `nova_fnb_pgdata`)
- PostgREST on `53000`, gateway on `8443` (TLS)
- `db/migrations/0000_prereq.sql` — roles, `app_role`, shared triggers
- `db/migrations/0001_fnb_core.sql` — 79 `restaurant_*` tables, functions, RLS
  (statement order machine-verified against an empty PostgreSQL 17 database)
- `db/migrations/0002_hospitality_bridge.sql` — outlet-owned `guests`,
  `guest_preferences`, inert `bookings` and `pms_folio_postings`
- `db/seed/demo/0100_demo_restaurant_bar.sql` — synthetic **Demo Restaurant &
  Bar**: 1 tenant, 1 property, 3 locations, 24 stock items, 15 menu items,
  15 POS products, 12 tables, 3 stations, 4 service periods, 4 suppliers

## Hospitality bridge
`VITE_FNB_PMS_FOLIO=off` makes room charge unavailable (`PmsFolioPort` returns a
no-op implementation). Inside NOVA the flag is unset, so the real folio adapter
loads exactly as before.

## Safety
Runtime state lives in `~/.nova-fnb`. `./nova` refuses to start if any backend
target points at a hosted project. Repository `.env` is shadowed during the UI
build and the gateway starts with `bun --env-file=/dev/null`.
