-- Places are edited in a Google Sheet and pushed here by the sync-places function.
--   key             stable id of the sheet row (the sheet's first column); upsert target
--   instagram       handle or URL (shown on the trip page)
--   website         official site
--   map_url         Google Maps link of the place (googleMapsUri from the Places API)
--   place_id        Google place id (set by the auto-fill)
--   business_status OPERATIONAL / CLOSED_TEMPORARILY / CLOSED_PERMANENTLY (set by the auto-fill)
--   matched_name    the name Google matched, to double-check the auto-fill by eye
alter table public.places
  add column key text,
  add column instagram text,
  add column website text,
  add column map_url text,
  add column place_id text,
  add column business_status text,
  add column matched_name text;
create unique index places_key_uidx on public.places (key);
