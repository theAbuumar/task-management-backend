import type { PrismaClient, Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { recordActivity, ACTIVITY_ACTIONS } from '../../lib/activity.js';
import { buildStorageKey, type PresignedUpload, type StorageDriver } from '../../lib/storage.js';
import { config } from '../../config/index.js';
import { assertAllowedFileName, assertFileContent, SNIFF_BYTES } from '../../lib/file-policy.js';
import type { CreateAttachmentBody } from './schema.js';

const INCLUDE_UPLOADER = {
  uploaded_by: {
    select: {
      id: true,
      display_name: true,
      last_name: true,
      first_name: true,
      middle_name: true,
      avatar_url: true,
    },
  },
} satisfies Prisma.AttachmentInclude;

type AttachmentWithUploader = Prisma.AttachmentGetPayload<{ include: typeof INCLUDE_UPLOADER }>;

async function resolveIssue(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  issueId: string,
): Promise<void> {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, project_id: projectId, workspace_id: workspaceId, deleted_at: null },
    select: { id: true },
  });
  if (!issue) throw AppError.notFound('Issue not found');
}

export async function listAttachments(
  prisma: PrismaClient,
  storage: StorageDriver,
  workspaceId: string,
  projectId: string,
  issueId: string,
): Promise<(AttachmentWithUploader & { download_url: string })[]> {
  await resolveIssue(prisma, workspaceId, projectId, issueId);

  const attachments = await prisma.attachment.findMany({
    where: { issue_id: issueId },
    include: INCLUDE_UPLOADER,
    orderBy: { created_at: 'desc' },
  });

  return Promise.all(
    attachments.map(async (a) => ({
      ...a,
      download_url: await storage.presignDownload(a.storage_key, a.file_name),
    })),
  );
}

export async function createAttachment(
  prisma: PrismaClient,
  storage: StorageDriver,
  workspaceId: string,
  projectId: string,
  issueId: string,
  uploaderId: string,
  body: CreateAttachmentBody,
): Promise<{ attachment: AttachmentWithUploader; upload: PresignedUpload }> {
  await resolveIssue(prisma, workspaceId, projectId, issueId);
  // No programs or scripts; the bytes themselves are checked by the upload route (ADR-027).
  assertAllowedFileName(body.file_name);

  if (body.file_size > config.ATTACHMENT_MAX_BYTES) {
    throw AppError.badRequest(
      `file_size exceeds the maximum allowed (${config.ATTACHMENT_MAX_BYTES} bytes)`,
    );
  }

  const storageKey = buildStorageKey(workspaceId, issueId, body.file_name);
  const attachment = await insertAttachment(prisma, {
    workspaceId,
    issueId,
    uploaderId,
    storageKey,
    ...body,
  });
  const upload = await storage.presignUpload(storageKey, body.mime_type, body.file_size);
  return { attachment, upload };
}

/** The metadata row and its «file added» history entry. */
function insertAttachment(
  prisma: PrismaClient,
  a: CreateAttachmentBody & {
    workspaceId: string;
    issueId: string;
    uploaderId: string;
    storageKey: string;
  },
): Promise<AttachmentWithUploader> {
  return prisma.$transaction(async (tx) => {
    const created = await tx.attachment.create({
      data: {
        workspace_id: a.workspaceId,
        issue_id: a.issueId,
        uploaded_by_id: a.uploaderId,
        file_name: a.file_name,
        file_size: a.file_size,
        mime_type: a.mime_type,
        storage_key: a.storageKey,
      },
      include: INCLUDE_UPLOADER,
    });
    await recordActivity(tx, {
      workspace_id: a.workspaceId,
      issue_id: a.issueId,
      actor_id: a.uploaderId,
      action: ACTIVITY_ACTIONS.ATTACHMENT_ADDED,
      new_value: created.file_name,
    });
    return created;
  });
}

/**
 * Store bytes the server already holds — a file sent to the Telegram bot — as an
 * attachment of an issue the caller has already checked access to.
 */
export async function storeAttachment(
  prisma: PrismaClient,
  storage: StorageDriver,
  a: {
    workspaceId: string;
    issueId: string;
    uploaderId: string;
    fileName: string;
    mimeType: string;
    data: Buffer;
  },
): Promise<AttachmentWithUploader> {
  if (a.data.length > config.ATTACHMENT_MAX_BYTES) {
    throw AppError.badRequest(
      `file_size exceeds the maximum allowed (${config.ATTACHMENT_MAX_BYTES} bytes)`,
    );
  }
  assertFileContent(a.fileName, a.data.subarray(0, SNIFF_BYTES));
  const storageKey = buildStorageKey(a.workspaceId, a.issueId, a.fileName);
  await storage.put(storageKey, a.data, a.mimeType);
  try {
    return await insertAttachment(prisma, {
      workspaceId: a.workspaceId,
      issueId: a.issueId,
      uploaderId: a.uploaderId,
      storageKey,
      file_name: a.fileName,
      file_size: a.data.length,
      mime_type: a.mimeType,
    });
  } catch (err) {
    await storage.delete(storageKey).catch(() => undefined);
    throw err;
  }
}

export async function deleteAttachment(
  prisma: PrismaClient,
  storage: StorageDriver,
  workspaceId: string,
  projectId: string,
  attachmentId: string,
  requesterId: string,
  requesterRole: string,
): Promise<void> {
  // Scope the lookup to the workspace + project via the parent issue.
  const attachment = await prisma.attachment.findFirst({
    where: {
      id: attachmentId,
      workspace_id: workspaceId,
      issue: { project_id: projectId },
    },
  });
  if (!attachment) throw AppError.notFound('Attachment not found');

  const isUploader = attachment.uploaded_by_id === requesterId;
  const isAdmin = requesterRole === 'admin' || requesterRole === 'owner';
  if (!isUploader && !isAdmin) {
    throw AppError.forbidden('Only the uploader or an admin can delete this attachment');
  }

  await prisma.$transaction(async (tx) => {
    await tx.attachment.delete({ where: { id: attachmentId } });
    await recordActivity(tx, {
      workspace_id: workspaceId,
      issue_id: attachment.issue_id,
      actor_id: requesterId,
      action: ACTIVITY_ACTIONS.ATTACHMENT_REMOVED,
      old_value: attachment.file_name,
    });
  });

  // Best-effort object removal — the metadata row is already gone, so a storage
  // failure must not surface as a request error or orphan the DB state.
  await storage.delete(attachment.storage_key).catch(() => undefined);
}
