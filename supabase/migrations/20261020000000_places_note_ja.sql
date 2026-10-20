-- ひとこと（日本語）from the sheet: shown on the Japanese site instead of the English note when present.
alter table public.places add column if not exists note_ja text;
