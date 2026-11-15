-- Custom SQL migration file, put your code below! --
-- The single app_settings row (id = 1) with its column defaults. Its
-- updated_at is the migration time in epoch ms (whole seconds: strftime
-- works on any SQLite version, unlike unixepoch('subsec')).
INSERT INTO `app_settings` (`id`, `updated_at`) VALUES (1, CAST(strftime('%s', 'now') AS INTEGER) * 1000) ON CONFLICT DO NOTHING;
