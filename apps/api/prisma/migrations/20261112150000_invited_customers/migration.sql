-- Accounts made by a merchant invitation with a password (1.37.0) had no role: they are customers like a website
-- sign-up (an account with no role had no page to open). Only accounts with no role whose mobile was invited.
INSERT INTO "user_roles" ("id", "userId", "role", "createdAt")
SELECT gen_random_uuid(), u."id", 'CUSTOMER', CURRENT_TIMESTAMP
FROM "users" u
WHERE NOT EXISTS (SELECT 1 FROM "user_roles" r WHERE r."userId" = u."id")
  AND EXISTS (SELECT 1 FROM "merchant_invites" i WHERE i."phone" = u."phone");
