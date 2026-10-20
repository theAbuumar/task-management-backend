-- Drafts of new issues (7.B5): the create form saved as it is typed; personal.
-- CreateTable
CREATE TABLE "IssueDraft" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssueDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IssueDraft_workspace_id_user_id_updated_at_idx" ON "IssueDraft"("workspace_id", "user_id", "updated_at");

-- CreateIndex
CREATE INDEX "IssueDraft_project_id_idx" ON "IssueDraft"("project_id");

-- AddForeignKey
ALTER TABLE "IssueDraft" ADD CONSTRAINT "IssueDraft_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueDraft" ADD CONSTRAINT "IssueDraft_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueDraft" ADD CONSTRAINT "IssueDraft_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

