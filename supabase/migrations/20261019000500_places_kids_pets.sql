-- 子供OK / ペットOK from the sheet (filled from Google when it knows: ○ / × / empty). Not used by the site yet.
alter table public.places add column kids_ok text, add column pet_ok text;
