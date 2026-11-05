-- Existing parcels: the time they entered their current status, from the tracking history. Notes and
-- "Details updated" events repeat the current status, so this takes the start of the last run of events
-- in that status (after the last event in any other status). No matching event: the booking time.
UPDATE "parcels" p
SET "statusChangedAt" = COALESCE(
  (
    SELECT min(e."createdAt")
    FROM "tracking_events" e
    WHERE e."parcelId" = p."id"
      AND e."status" = p."status"
      AND e."createdAt" > COALESCE(
        (SELECT max(o."createdAt") FROM "tracking_events" o WHERE o."parcelId" = p."id" AND o."status" <> p."status"),
        '-infinity'::timestamp
      )
  ),
  p."createdAt"
);
