-- Guest dining session <-> orders linkage.
--
-- O12 (migration 0018) gave the guest portal a real, server-authoritative
-- dining-session primitive (restaurant_guest_sessions: one active session
-- per table, token-bound, time-boxed) but nothing ever recorded WHICH
-- order(s) a session produced. submitGuestOrder placed each new order with
-- no link back to the session that authorized it, so a second order at the
-- same table had no server-derivable relationship to the first — the guest
-- portal could only ever track one order at a time via a client-side
-- storedOrderId.
--
-- This is the smallest correct fix: a single nullable, server-set foreign
-- key. It is purely additive — every existing restaurant_orders row keeps
-- guest_session_id = null (no historical order is retroactively assigned to
-- a session; O12's own doc comments are explicit that session membership is
-- never fabricated for pre-existing data). Going forward, createGuestOrder
-- sets it once, at insert time, from the session resolveOrStartGuestSession
-- already validated server-side for that exact submission — never from a
-- client-supplied value, so a guest can never attach their order to another
-- session by any means.
alter table public.restaurant_orders
  add column if not exists guest_session_id uuid
    references public.restaurant_guest_sessions(id) on delete set null;

create index if not exists restaurant_orders_guest_session_idx
  on public.restaurant_orders (guest_session_id)
  where guest_session_id is not null;
