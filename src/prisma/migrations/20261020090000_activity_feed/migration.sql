-- Workspace activity feed (7.B3): the newest rows of a workspace, in order.
CREATE INDEX "ActivityLog_workspace_id_created_at_idx" ON "ActivityLog"("workspace_id", "created_at");
