-- An itinerary becomes final when the buyer presses "SAVE MY ITINERARY" and confirms.
-- Until then it can be rebuilt as often as they like (each build overwrites the draft); once finalized_at is set,
-- save-trip refuses any further change for that purchase.
alter table public.trips add column if not exists finalized_at timestamptz;
