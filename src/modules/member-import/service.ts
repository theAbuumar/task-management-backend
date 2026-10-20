// Staff import (4.B1, ADR-031): a list of people → invitations to the workspace,
// each with its place in the org structure. First a check (`dry_run`) that changes
// nothing and says what each row will do; then the run: rows with errors are
// skipped, the rest are done one by one, and one failing row (a mail server
// hiccup) does not stop the others.
//
// What a row does:
//   - a registered person not in the workspace — an invitation to their inbox,
//     email and Telegram (the same as «Пригласить», member-invites);
//   - an unknown email — an email with a sign-up link (workspaces.inviteMember),
//     which also carries the full name for the new account;
//   - someone already in the workspace — their department and position are set,
//     the role stays as it is.
// A department is given as a path «Факультет / Кафедра»; missing parts are created.

import type { PrismaClient, WorkspaceRole } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { inviteExistingUser, type InviteChannel } from '../member-invites/service.js';
import { inviteMember } from '../workspaces/service.js';
import { normalize, type RawRow } from './parse.js';

type AssignableRole = Exclude<WorkspaceRole, 'owner'>;

export type RowStatus = 'invite_existing' | 'invite_new' | 'update' | 'unchanged' | 'error';
export type RowResult = 'invited' | 'updated' | 'unchanged' | 'skipped' | 'failed';

/** Codes of a row's problems; the client words them. */
export type RowErrorCode =
  | 'NAME_REQUIRED'
  | 'NAME_INCOMPLETE'
  | 'NAME_TOO_LONG'
  | 'EMAIL_REQUIRED'
  | 'EMAIL_INVALID'
  | 'EMAIL_DUPLICATE'
  | 'ROLE_INVALID'
  | 'DEPARTMENT_TOO_LONG'
  | 'POSITION_TOO_LONG'
  | 'ACCOUNT_INACTIVE';

export interface ImportRow {
  row: number;
  full_name: string;
  email: string;
  /** The path as written, «Экономический факультет / Кафедра финансов». */
  department: string | null;
  position: string | null;
  role: AssignableRole;
  status: RowStatus;
  errors: { field: keyof RawRow; code: RowErrorCode }[];
  /** Departments this row will create (their full paths). */
  new_departments: string[];
  // After the run:
  result?: RowResult;
  delivered_to?: InviteChannel[];
  failure?: { code: string; message: string };
}

export interface ImportReport {
  dry_run: boolean;
  summary: {
    total: number;
    errors: number;
    invite_existing: number;
    invite_new: number;
    update: number;
    unchanged: number;
    /** Full paths of the departments that will be (or were) created. */
    departments_to_create: string[];
    /** After the run. */
    invited?: number;
    updated?: number;
    failed?: number;
  };
  rows: ImportRow[];
}

const ROLE_WORDS: Record<string, AssignableRole> = {
  '': 'member',
  участник: 'member',
  сотрудник: 'member',
  member: 'member',
  администратор: 'admin',
  админ: 'admin',
  admin: 'admin',
  гость: 'guest',
  наблюдатель: 'guest',
  guest: 'guest',
};

const email = z.string().email();

interface Checked extends ImportRow {
  last_name: string;
  first_name: string;
  middle_name: string | null;
  path: string[];
}

function check(raw: RawRow): Checked {
  const errors: Checked['errors'] = [];
  const words = raw.full_name.split(' ').filter(Boolean);
  if (words.length === 0) errors.push({ field: 'full_name', code: 'NAME_REQUIRED' });
  else if (words.length === 1) errors.push({ field: 'full_name', code: 'NAME_INCOMPLETE' });
  const [last = '', first = '', ...rest] = words;
  const middle = rest.join(' ');
  if ([last, first, middle].some((p) => p.length > 60)) {
    errors.push({ field: 'full_name', code: 'NAME_TOO_LONG' });
  }

  const address = raw.email.toLowerCase();
  if (!address) errors.push({ field: 'email', code: 'EMAIL_REQUIRED' });
  else if (!email.safeParse(address).success)
    errors.push({ field: 'email', code: 'EMAIL_INVALID' });

  const role = ROLE_WORDS[normalize(raw.role)];
  if (!role) errors.push({ field: 'role', code: 'ROLE_INVALID' });

  const path = raw.department
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  if (path.some((p) => p.length > 200))
    errors.push({ field: 'department', code: 'DEPARTMENT_TOO_LONG' });
  if (raw.position.length > 150) errors.push({ field: 'position', code: 'POSITION_TOO_LONG' });

  return {
    row: raw.row,
    full_name: words.join(' '),
    email: address,
    department: path.length ? path.join(' / ') : null,
    position: raw.position || null,
    role: role ?? 'member',
    status: errors.length ? 'error' : 'invite_new',
    errors,
    new_departments: [],
    last_name: last,
    first_name: first,
    middle_name: middle || null,
    path,
  };
}

interface DeptNode {
  id: string | null; // null — still to be created
  name: string;
  short_name: string | null;
  parent: DeptNode | null;
  children: DeptNode[];
  order: number;
}

/** The workspace's department tree, to find paths in and to add new parts to. */
async function loadTree(prisma: PrismaClient, workspaceId: string) {
  const rows = await prisma.department.findMany({
    where: { workspace_id: workspaceId },
    orderBy: [{ order: 'asc' }, { created_at: 'asc' }],
    select: { id: true, name: true, short_name: true, parent_id: true, order: true },
  });
  const root: DeptNode = {
    id: null,
    name: '',
    short_name: null,
    parent: null,
    children: [],
    order: 0,
  };
  const byId = new Map<string, DeptNode>();
  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      name: r.name,
      short_name: r.short_name,
      parent: null,
      children: [],
      order: r.order,
    });
  }
  for (const r of rows) {
    const node = byId.get(r.id)!;
    const parent = (r.parent_id && byId.get(r.parent_id)) || root;
    node.parent = parent;
    parent.children.push(node);
  }
  return root;
}

const pathOf = (node: DeptNode): string => {
  const parts: string[] = [];
  for (let n: DeptNode | null = node; n && n.parent; n = n.parent) parts.unshift(n.name);
  return parts.join(' / ');
};

/** Walk a path by name or short name; missing parts become new nodes (id null). */
function resolvePath(root: DeptNode, path: string[], created: DeptNode[]): DeptNode | null {
  let node = root;
  for (const part of path) {
    const key = normalize(part);
    let next = node.children.find(
      (c) => normalize(c.name) === key || (c.short_name && normalize(c.short_name) === key),
    );
    if (!next) {
      next = {
        id: null,
        name: part,
        short_name: null,
        parent: node,
        children: [],
        order: node.children.length,
      };
      node.children.push(next);
      created.push(next);
    }
    node = next;
  }
  return node === root ? null : node;
}

export async function importMembers(
  prisma: PrismaClient,
  workspaceId: string,
  actorId: string,
  rawRows: RawRow[],
  dryRun: boolean,
): Promise<ImportReport> {
  const rows = rawRows.map(check);

  // The same address twice: the later rows are errors.
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.email || r.errors.some((e) => e.field === 'email')) continue;
    if (seen.has(r.email)) {
      r.errors.push({ field: 'email', code: 'EMAIL_DUPLICATE' });
      r.status = 'error';
    }
    seen.add(r.email);
  }

  const valid = rows.filter((r) => r.status !== 'error');
  const users = valid.length
    ? await prisma.user.findMany({
        where: { email: { in: valid.map((r) => r.email), mode: 'insensitive' } },
        select: { id: true, email: true, is_active: true },
      })
    : [];
  const userByEmail = new Map(users.map((u) => [u.email!.toLowerCase(), u]));
  const members = await prisma.workspaceMember.findMany({
    where: { workspace_id: workspaceId, user_id: { in: users.map((u) => u.id) } },
    select: { user_id: true, department_id: true, position: true },
  });
  const memberOf = new Map(members.map((m) => [m.user_id, m]));

  const root = await loadTree(prisma, workspaceId);
  const created: DeptNode[] = [];
  const target = new Map<number, DeptNode | null>();

  for (const r of valid) {
    const node = resolvePath(root, r.path, created);
    target.set(r.row, node);

    const user = userByEmail.get(r.email);
    if (user && !user.is_active) {
      r.errors.push({ field: 'email', code: 'ACCOUNT_INACTIVE' });
      r.status = 'error';
      continue;
    }
    const member = user ? memberOf.get(user.id) : undefined;
    if (member) {
      const moves = Boolean(node) && (node!.id === null || node!.id !== member.department_id);
      const renames = r.position !== null && r.position !== member.position;
      r.status = moves || renames ? 'update' : 'unchanged';
    } else {
      r.status = user ? 'invite_existing' : 'invite_new';
    }
  }

  // Departments only rows that will run need (an error row creates nothing); a
  // row lists every part of its path still to be created, shared or not.
  const needed = new Set<DeptNode>();
  for (const r of rows) {
    if (r.status === 'error') continue;
    const missing: DeptNode[] = [];
    for (let n = target.get(r.row) ?? null; n && n.id === null; n = n.parent) missing.unshift(n);
    missing.forEach((n) => needed.add(n));
    r.new_departments = missing.map(pathOf);
  }
  const toCreate = created.filter((n) => needed.has(n));

  const count = (s: RowStatus) => rows.filter((r) => r.status === s).length;
  const report: ImportReport = {
    dry_run: dryRun,
    summary: {
      total: rows.length,
      errors: count('error'),
      invite_existing: count('invite_existing'),
      invite_new: count('invite_new'),
      update: count('update'),
      unchanged: count('unchanged'),
      departments_to_create: toCreate.map(pathOf),
    },
    rows: rows.map(publicRow),
  };
  if (dryRun) return report;

  // ─── The run ──────────────────────────────────────────────────────────────
  // Parents before children: `created` is in the order the paths were walked.
  for (const node of toCreate) {
    const made = await prisma.department.create({
      data: {
        workspace_id: workspaceId,
        name: node.name,
        parent_id: node.parent?.id ?? null,
        order: node.parent ? node.parent.children.filter((c) => c.id !== null).length : 0,
      },
      select: { id: true },
    });
    node.id = made.id;
  }

  for (const r of rows) {
    if (r.status === 'error') {
      r.result = 'skipped';
      continue;
    }
    if (r.status === 'unchanged') {
      r.result = 'unchanged';
      continue;
    }
    const departmentId = target.get(r.row)?.id ?? undefined;
    try {
      if (r.status === 'update') {
        const user = userByEmail.get(r.email)!;
        await prisma.workspaceMember.update({
          where: { workspace_id_user_id: { workspace_id: workspaceId, user_id: user.id } },
          data: {
            ...(departmentId && { department_id: departmentId }),
            ...(r.position !== null && { position: r.position }),
          },
        });
        r.result = 'updated';
      } else if (r.status === 'invite_existing') {
        const { delivered_to } = await inviteExistingUser(prisma, workspaceId, actorId, {
          user_id: userByEmail.get(r.email)!.id,
          role: r.role,
          department_id: departmentId ?? null,
          position: r.position,
        });
        r.result = 'invited';
        r.delivered_to = delivered_to;
      } else {
        await inviteMember(prisma, workspaceId, actorId, {
          email: r.email,
          role: r.role,
          department_id: departmentId ?? null,
          position: r.position,
          last_name: r.last_name,
          first_name: r.first_name,
          middle_name: r.middle_name,
        });
        r.result = 'invited';
        r.delivered_to = ['email'];
      }
    } catch (err) {
      r.result = 'failed';
      r.failure =
        err instanceof AppError
          ? { code: err.code, message: err.message }
          : { code: 'INTERNAL_ERROR', message: 'The row could not be processed' };
    }
  }

  const done = (result: RowResult) => rows.filter((r) => r.result === result).length;
  report.summary.invited = done('invited');
  report.summary.updated = done('updated');
  report.summary.failed = done('failed');
  report.rows = rows.map(publicRow);

  await writeAudit(prisma, {
    workspace_id: workspaceId,
    actor_id: actorId,
    action: 'member.imported',
    target_type: 'workspace',
    target_id: workspaceId,
    meta: {
      rows: rows.length,
      invited: report.summary.invited,
      updated: report.summary.updated,
      failed: report.summary.failed,
      skipped: report.summary.errors,
      departments: report.summary.departments_to_create.slice(0, 50),
    },
  });
  return report;
}

function publicRow(r: Checked): ImportRow {
  return {
    row: r.row,
    full_name: r.full_name,
    email: r.email,
    department: r.department,
    position: r.position,
    role: r.role,
    status: r.status,
    errors: r.errors,
    new_departments: r.new_departments,
    ...(r.result && { result: r.result }),
    ...(r.delivered_to && { delivered_to: r.delivered_to }),
    ...(r.failure && { failure: r.failure }),
  };
}
