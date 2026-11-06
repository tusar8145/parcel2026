-- "Received at first hub" (notify.received_at_hub): a parcel message goes only when it is in the package's
-- services and the parcel's stored list. Plans that already message recipients get it, and so do parcels on
-- their way to their first hub. Plans without recipient messages, and products with messages off, stay as they are.
UPDATE "service_package_versions"
SET "services" = array_append("services", 'notify.received_at_hub')
WHERE 'notify.out_for_delivery' = ANY("services") AND NOT 'notify.received_at_hub' = ANY("services");

UPDATE "parcels"
SET "notifications" = array_append("notifications", 'notify.received_at_hub')
WHERE "status" IN ('PENDING_CONFIRMATION', 'PICKUP_ASSIGNED', 'PICKUP_CONFIRMED', 'PICKED_UP')
  AND 'notify.out_for_delivery' = ANY("notifications")
  AND NOT 'notify.received_at_hub' = ANY("notifications");
