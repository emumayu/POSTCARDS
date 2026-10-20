-- Brings a project created from v1_base in line with the first project:
--   * the ON DELETE rules of the original foreign keys, and
--   * no direct EXECUTE on the two trigger functions (they only run as triggers).
-- Safe to run on a database that already has them.
alter table public.purchases drop constraint if exists purchases_user_id_fkey,
  add constraint purchases_user_id_fkey foreign key (user_id) references auth.users(id) on delete set null;
alter table public.trips drop constraint if exists trips_user_id_fkey,
  add constraint trips_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.trips drop constraint if exists trips_purchase_id_fkey,
  add constraint trips_purchase_id_fkey foreign key (purchase_id) references public.purchases(id) on delete set null;
revoke all on function public.purchases_guard() from service_role;
revoke all on function public.set_updated_at()  from service_role;
