-- 0100 — retire legacy self-service tenant bootstrap
-- Commercial Centre provisioning + invitation activation is now the only
-- customer onboarding path. Keep the historical function definition in the
-- migration ledger, but remove its runtime RPC capability.
revoke all on function public.restaurant_bootstrap_tenant(
  text, text, text, text, text, text
) from public, anon, authenticated;