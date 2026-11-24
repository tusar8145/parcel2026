-- A franchise is named after its hub.
UPDATE "franchises" f SET "name" = h."name" FROM "hubs" h WHERE h."id" = f."hubId";
