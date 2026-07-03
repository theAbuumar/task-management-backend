-- Generalize EmailOtp so a confirmation code can target either an email address or a
-- user id. `user_id` carries the delete-account code for accounts with no email
-- (Telegram-only), delivered through the bot; `email` is nullable because those rows
-- have no address. Existing rows keep their (non-null) email untouched.
ALTER TABLE "EmailOtp" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "EmailOtp" ADD COLUMN "user_id" TEXT;

-- CreateIndex
CREATE INDEX "EmailOtp_user_id_idx" ON "EmailOtp"("user_id");
