-- CreateEnum
CREATE TYPE "MemberInviteStatus" AS ENUM ('pending', 'accepted', 'declined', 'expired');

-- CreateTable
CREATE TABLE "WorkspaceMemberInvite" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "inviter_id" TEXT NOT NULL,
    "target_user_id" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'member',
    "status" "MemberInviteStatus" NOT NULL DEFAULT 'pending',
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "responded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMemberInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMemberInvite_token_key" ON "WorkspaceMemberInvite"("token");

-- CreateIndex
CREATE INDEX "WorkspaceMemberInvite_target_user_id_status_idx" ON "WorkspaceMemberInvite"("target_user_id", "status");

-- CreateIndex
CREATE INDEX "WorkspaceMemberInvite_workspace_id_idx" ON "WorkspaceMemberInvite"("workspace_id");

-- AddForeignKey
ALTER TABLE "WorkspaceMemberInvite" ADD CONSTRAINT "WorkspaceMemberInvite_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMemberInvite" ADD CONSTRAINT "WorkspaceMemberInvite_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMemberInvite" ADD CONSTRAINT "WorkspaceMemberInvite_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
