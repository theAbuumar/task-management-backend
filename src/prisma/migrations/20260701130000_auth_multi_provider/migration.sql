-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('email', 'google', 'github', 'telegram');

-- CreateEnum
CREATE TYPE "EmailOtpPurpose" AS ENUM ('signup', 'login');

-- CreateEnum
CREATE TYPE "TelegramLoginStatus" AS ENUM ('pending', 'confirmed', 'expired', 'used');

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL,
ALTER COLUMN "password_hash" DROP NOT NULL,
ADD COLUMN "email_verified" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AuthIdentity" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" "AuthProvider" NOT NULL,
    "provider_user_id" TEXT,
    "provider_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailOtp" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "purpose" "EmailOtpPurpose" NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailOtp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramLoginToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "telegram_id" TEXT,
    "status" "TelegramLoginStatus" NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramLoginToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthIdentity_user_id_idx" ON "AuthIdentity"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "AuthIdentity_provider_provider_user_id_key" ON "AuthIdentity"("provider", "provider_user_id");

-- CreateIndex
CREATE INDEX "EmailOtp_email_idx" ON "EmailOtp"("email");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramLoginToken_token_key" ON "TelegramLoginToken"("token");

-- CreateIndex
CREATE INDEX "TelegramLoginToken_session_id_idx" ON "TelegramLoginToken"("session_id");

-- AddForeignKey
ALTER TABLE "AuthIdentity" ADD CONSTRAINT "AuthIdentity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
