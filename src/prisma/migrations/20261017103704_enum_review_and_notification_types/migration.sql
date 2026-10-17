-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'state_changed';
ALTER TYPE "NotificationType" ADD VALUE 'review_requested';
ALTER TYPE "NotificationType" ADD VALUE 'review_approved';
ALTER TYPE "NotificationType" ADD VALUE 'review_returned';
ALTER TYPE "NotificationType" ADD VALUE 'acknowledged';
ALTER TYPE "NotificationType" ADD VALUE 'due_soon';
ALTER TYPE "NotificationType" ADD VALUE 'overdue';
ALTER TYPE "NotificationType" ADD VALUE 'escalated';
ALTER TYPE "NotificationType" ADD VALUE 'deadline_change_requested';
ALTER TYPE "NotificationType" ADD VALUE 'deadline_change_decided';
ALTER TYPE "NotificationType" ADD VALUE 'invite_received';
ALTER TYPE "NotificationType" ADD VALUE 'report_ready';
ALTER TYPE "NotificationType" ADD VALUE 'digest';

-- AlterEnum
-- Keep the logical order (started → review → completed) for ORDER BY on the group.
ALTER TYPE "StateGroup" ADD VALUE 'review' BEFORE 'completed';
