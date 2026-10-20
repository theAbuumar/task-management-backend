import type { PrismaClient, IssueLinkType, Prisma } from '@prisma/client';
import { AppError } from '../../../lib/errors.js';
import type { CreateRelationBody } from './schema.js';

type LinkWithRelated = Prisma.IssueLinkGetPayload<{
  include: {
    related_issue: {
      select: {
        id: true;
        sequence_id: true;
        title: true;
        priority: true;
        state_id: true;
        project_id: true;
      };
    };
  };
}>;

const INCLUDE_RELATED = {
  related_issue: {
    select: {
      id: true,
      sequence_id: true,
      title: true,
      priority: true,
      state_id: true,
      project_id: true,
    },
  },
} as const;

/** The mirror relation to create when one side is created or deleted. */
function mirrorType(type: IssueLinkType): IssueLinkType {
  if (type === 'blocks') return 'blocked_by';
  if (type === 'blocked_by') return 'blocks';
  return type; // relates_to and duplicates are symmetric
}

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

export interface GroupedRelations {
  blocks: LinkWithRelated[];
  blocked_by: LinkWithRelated[];
  relates_to: LinkWithRelated[];
  duplicates: LinkWithRelated[];
}

export async function listRelations(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  issueId: string,
): Promise<GroupedRelations> {
  await resolveIssue(prisma, workspaceId, projectId, issueId);

  const links = await prisma.issueLink.findMany({
    where: { issue_id: issueId },
    include: INCLUDE_RELATED,
    orderBy: { created_at: 'asc' },
  });

  return {
    blocks: links.filter((l) => l.relation_type === 'blocks'),
    blocked_by: links.filter((l) => l.relation_type === 'blocked_by'),
    relates_to: links.filter((l) => l.relation_type === 'relates_to'),
    duplicates: links.filter((l) => l.relation_type === 'duplicates'),
  };
}

export async function createRelation(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  issueId: string,
  body: CreateRelationBody,
): Promise<LinkWithRelated> {
  await resolveIssue(prisma, workspaceId, projectId, issueId);

  if (body.related_issue_id === issueId) {
    throw AppError.badRequest('An issue cannot be related to itself');
  }

  // Related issue must exist in the same workspace (cross-project relations are allowed).
  const relatedIssue = await prisma.issue.findFirst({
    where: { id: body.related_issue_id, workspace_id: workspaceId, deleted_at: null },
    select: { id: true },
  });
  if (!relatedIssue) throw AppError.notFound('Related issue not found in this workspace');

  const relType = body.relation_type as IssueLinkType;
  const mirror = mirrorType(relType);

  // Check for duplicate — same pair + same type already exists.
  const existing = await prisma.issueLink.findUnique({
    where: {
      issue_id_related_issue_id_relation_type: {
        issue_id: issueId,
        related_issue_id: body.related_issue_id,
        relation_type: relType,
      },
    },
  });
  if (existing) throw AppError.conflict('This relation already exists');

  return prisma.$transaction(async (tx) => {
    const link = await tx.issueLink.create({
      data: {
        issue_id: issueId,
        related_issue_id: body.related_issue_id,
        relation_type: relType,
      },
      include: INCLUDE_RELATED,
    });

    // Create the mirror (upsert so re-runs are safe).
    await tx.issueLink.upsert({
      where: {
        issue_id_related_issue_id_relation_type: {
          issue_id: body.related_issue_id,
          related_issue_id: issueId,
          relation_type: mirror,
        },
      },
      create: {
        issue_id: body.related_issue_id,
        related_issue_id: issueId,
        relation_type: mirror,
      },
      update: {},
    });

    return link;
  });
}

export async function deleteRelation(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  issueId: string,
  linkId: string,
): Promise<void> {
  await resolveIssue(prisma, workspaceId, projectId, issueId);

  const link = await prisma.issueLink.findFirst({
    where: { id: linkId, issue_id: issueId },
  });
  if (!link) throw AppError.notFound('Relation not found');

  const mirror = mirrorType(link.relation_type);

  await prisma.$transaction(async (tx) => {
    await tx.issueLink.delete({ where: { id: linkId } });

    // Delete the mirror if it exists.
    await tx.issueLink.deleteMany({
      where: {
        issue_id: link.related_issue_id,
        related_issue_id: issueId,
        relation_type: mirror,
      },
    });
  });
}

export interface ProjectLink {
  id: string;
  issue_id: string;
  related_issue_id: string;
  relation_type: IssueLinkType;
  created_at: Date;
}

/**
 * Relations between issues of one project, each pair once (7.F4: the timeline
 * draws «блокирует» arrows from one request instead of one per issue). Mirrors
 * are dropped: `blocked_by` is the other side of `blocks`, and a symmetric pair
 * (`relates_to`, `duplicates`) keeps the row whose issue id sorts first. Deleted
 * issues and links to other projects are left out.
 */
export async function listProjectRelations(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  type?: Exclude<IssueLinkType, 'blocked_by'>,
): Promise<{ data: ProjectLink[] }> {
  const inProject = { project_id: projectId, workspace_id: workspaceId, deleted_at: null };
  const links = await prisma.issueLink.findMany({
    where: {
      relation_type: type ?? { not: 'blocked_by' },
      issue: inProject,
      related_issue: inProject,
    },
    select: {
      id: true,
      issue_id: true,
      related_issue_id: true,
      relation_type: true,
      created_at: true,
    },
    orderBy: { created_at: 'asc' },
  });
  return {
    data: links.filter((l) => l.relation_type === 'blocks' || l.issue_id < l.related_issue_id),
  };
}
