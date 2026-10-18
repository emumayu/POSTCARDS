-- Purchase confirmation e-mail: remember which site the buyer paid on (so the Stripe Webhook can build the
-- right link), and let receipt_sent_at be reset when sending fails (the guard no longer pins it).
alter table public.purchases add column if not exists site_origin text;

create or replace function public.purchases_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  rank_old int; rank_new int;
begin
  rank_old := case old.status when 'pending' then 1 when 'failed' then 2 when 'paid' then 2
              when 'partially_refunded' then 3 when 'refunded' then 4 else 0 end;
  rank_new := case new.status when 'pending' then 1 when 'failed' then 2 when 'paid' then 2
              when 'partially_refunded' then 3 when 'refunded' then 4 else 0 end;
  if rank_new < rank_old then
    new.status          := old.status;
    new.amount_refunded := greatest(coalesce(old.amount_refunded,0), coalesce(new.amount_refunded,0));
    new.refunded_at     := coalesce(old.refunded_at, new.refunded_at);
  end if;
  new.paid_at            := coalesce(old.paid_at, new.paid_at);
  new.email              := coalesce(new.email, old.email);
  new.customer_id        := coalesce(new.customer_id, old.customer_id);
  new.stripe_customer_id := coalesce(new.stripe_customer_id, old.stripe_customer_id);
  new.site_origin        := coalesce(new.site_origin, old.site_origin);
  return new;
end $$;
revoke all on function public.purchases_guard() from public, anon, authenticated;
