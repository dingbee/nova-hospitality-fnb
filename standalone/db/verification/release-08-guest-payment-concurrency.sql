-- RELEASE-08 verification: guest payment concurrency claim schema.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'restaurant_orders'
  and column_name in (
    'guest_payment_session_reference',
    'guest_payment_session_redirect_url',
    'guest_payment_session_expires_at'
  )
order by column_name;

select version, name
from supabase_migrations.schema_migrations
where name = '0085_selfpay_guest_payment_session_claim';

select count(*) as active_guest_payment_session_rows
from public.restaurant_orders
where guest_payment_session_reference is not null;