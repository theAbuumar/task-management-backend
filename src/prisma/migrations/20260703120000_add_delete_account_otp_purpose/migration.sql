-- AlterEnum
-- Adds the `delete_account` purpose used by the code-confirmed account-deletion flow
-- (POST /auth/account/delete/request → /auth/account/delete/confirm). PostgreSQL 12+
-- allows ADD VALUE inside Prisma's migration transaction as long as the new value is
-- not used in the same transaction (it isn't here).
ALTER TYPE "EmailOtpPurpose" ADD VALUE 'delete_account';
