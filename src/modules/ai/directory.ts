// The org directory as the model sees it (Ф11 11.B2, 11.B5, ADR-028).
//
// People and departments of ONE workspace — the same lists any member sees on the
// members and structure pages. The model gets short labels (`P12`, `D3`) instead
// of ids: fewer tokens, and the backend maps a label back to an id and checks it,
// so the model cannot invent an assignee or reach another workspace.
// Guests and members whose access is off are left out: they cannot be assigned.

import type { PrismaClient } from '@prisma/client';
import { fullName } from './prompts.js';

/** A large university still fits; beyond that the model would not use the list well. */
const MAX_PEOPLE = 3000;

export interface DirectoryPerson {
  ref: string;
  id: string;
  name: string;
  display_name: string;
  position: string | null;
  department_id: string | null;
  avatar_url: string | null;
}

export interface DirectoryDepartment {
  ref: string;
  id: string;
  name: string;
  short_name: string | null;
  parent_id: string | null;
  head_id: string | null;
}

export interface Directory {
  people: DirectoryPerson[];
  departments: DirectoryDepartment[];
  personByRef: Map<string, DirectoryPerson>;
  personById: Map<string, DirectoryPerson>;
  departmentByRef: Map<string, DirectoryDepartment>;
  departmentById: Map<string, DirectoryDepartment>;
}

export async function loadDirectory(prisma: PrismaClient, workspaceId: string): Promise<Directory> {
  const [members, departments] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { workspace_id: workspaceId, deactivated_at: null, role: { not: 'guest' } },
      select: {
        user_id: true,
        position: true,
        department_id: true,
        user: {
          select: {
            display_name: true,
            last_name: true,
            first_name: true,
            middle_name: true,
            avatar_url: true,
            is_active: true,
          },
        },
      },
      orderBy: { created_at: 'asc' },
      take: MAX_PEOPLE,
    }),
    prisma.department.findMany({
      where: { workspace_id: workspaceId },
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, short_name: true, parent_id: true, head_id: true },
    }),
  ]);

  const people = members
    .filter((m) => m.user.is_active)
    .map<DirectoryPerson>((m, i) => ({
      ref: `P${i + 1}`,
      id: m.user_id,
      name: fullName(m.user),
      display_name: m.user.display_name,
      position: m.position,
      department_id: m.department_id,
      avatar_url: m.user.avatar_url,
    }));
  const depts = departments.map<DirectoryDepartment>((d, i) => ({ ref: `D${i + 1}`, ...d }));
  return {
    people,
    departments: depts,
    personByRef: new Map(people.map((p) => [p.ref, p])),
    personById: new Map(people.map((p) => [p.id, p])),
    departmentByRef: new Map(depts.map((d) => [d.ref, d])),
    departmentById: new Map(depts.map((d) => [d.id, d])),
  };
}

/** «D3 | Экономический факультет (ФЭУ) | входит в D1 | руководитель P5». */
export function departmentLines(dir: Directory): string {
  return dir.departments
    .map((d) => {
      const parent = d.parent_id ? dir.departmentById.get(d.parent_id) : undefined;
      const head = d.head_id ? dir.personById.get(d.head_id) : undefined;
      return [
        d.ref,
        d.short_name ? `${d.name} (${d.short_name})` : d.name,
        parent ? `входит в ${parent.ref}` : 'верхний уровень',
        head ? `руководитель ${head.ref}` : 'руководитель не назначен',
      ].join(' | ');
    })
    .join('\n');
}

/** «P5 | Петров Пётр Петрович | Декан | D3». */
export function personLines(dir: Directory, people = dir.people): string {
  return people
    .map((p) => {
      const dept = p.department_id ? dir.departmentById.get(p.department_id) : undefined;
      return [
        p.ref,
        p.name,
        p.position ?? 'должность не указана',
        dept?.ref ?? 'без подразделения',
      ].join(' | ');
    })
    .join('\n');
}

/** A person as the API returns it next to a draft. */
export function personBrief(dir: Directory, person: DirectoryPerson | undefined) {
  if (!person) return null;
  const dept = person.department_id ? dir.departmentById.get(person.department_id) : undefined;
  return {
    id: person.id,
    display_name: person.display_name,
    full_name: person.name,
    position: person.position,
    avatar_url: person.avatar_url,
    department: dept ? { id: dept.id, name: dept.name, short_name: dept.short_name } : null,
  };
}

export function departmentBrief(dept: DirectoryDepartment | undefined) {
  return dept ? { id: dept.id, name: dept.name, short_name: dept.short_name } : null;
}

/** The active head of a department, if it has one in the directory. */
export function headOf(dir: Directory, dept: DirectoryDepartment): DirectoryPerson | undefined {
  return dept.head_id ? dir.personById.get(dept.head_id) : undefined;
}
