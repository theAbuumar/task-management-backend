-- Ф12: пароль как дополнительный способ входа (12.B12), передача владения
-- пространством (12.B3) и вход через каталог университета — LDAP / AD (12.B10).

-- AlterEnum: коды подтверждения для установки пароля и передачи владения.
ALTER TYPE "EmailOtpPurpose" ADD VALUE 'set_password';
ALTER TYPE "EmailOtpPurpose" ADD VALUE 'transfer_ownership';

-- AlterEnum: учётная запись университета (LDAP / Active Directory).
ALTER TYPE "AuthProvider" ADD VALUE 'ldap';

-- AlterTable: когда задан пароль и блокировка после серии неверных паролей.
ALTER TABLE "User" ADD COLUMN "password_changed_at" TIMESTAMP(3),
ADD COLUMN "password_failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "password_locked_until" TIMESTAMP(3);
