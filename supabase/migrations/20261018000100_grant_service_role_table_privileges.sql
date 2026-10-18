-- This project has no default table privileges, so the server (service_role) could not read or write.
-- Give service_role the data privileges it needs; take everything away from the public API roles.
revoke all on table public.customers, public.purchases, public.trips, public.access_keys, public.stripe_events
  from anon, authenticated;
grant select, insert, update, delete on table
  public.customers, public.purchases, public.trips, public.access_keys, public.stripe_events
  to service_role;
