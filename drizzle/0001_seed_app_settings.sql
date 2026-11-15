-- app_settings holds exactly one row (id = 1); create it so readers never need an upsert.
INSERT INTO "app_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
