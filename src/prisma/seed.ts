// Database seed (run via `npm run prisma:seed`).
//
// Creates a small, self-contained demo dataset: one demo workspace owned by a
// demo user, two projects (each with the default workflow states), and a handful
// of issues ("tasks") spread across states and priorities. Everything is clearly
// namespaced ("Demo") and the whole script is idempotent — re-running upserts the
// same rows rather than duplicating them, so it is safe to run repeatedly against
// a shared database.

import { PrismaClient, type StateGroup } from '@prisma/client';
import { hashSecret } from '../lib/password.js';
import { DEFAULT_STATES } from '../modules/projects/service.js';

const prisma = new PrismaClient();

// Login for the seeded demo account (email + password flow).
const DEMO_EMAIL = 'demo@taskflow.local';
const DEMO_PASSWORD = 'demo-password-123';

// Default workflow states — the same set every real project gets on creation
// (Russian names + the "На проверке" review step).


/** A day offset from now, as a Date (negative = past). */
function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function main(): Promise<void> {
  // ── Demo user (idempotent by email) ──────────────────────────────────────
  const passwordHash = await hashSecret(DEMO_PASSWORD);
  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: {
      email: DEMO_EMAIL,
      email_verified: true,
      is_active: true,
      password_hash: passwordHash,
      display_name: 'Demo User',
    },
  });

  // Email login identity, matching what a real signup writes.
  const emailIdentity = await prisma.authIdentity.findFirst({
    where: { user_id: user.id, provider: 'email' },
  });
  if (!emailIdentity) {
    await prisma.authIdentity.create({
      data: {
        user_id: user.id,
        provider: 'email',
        provider_user_id: null,
        provider_email: DEMO_EMAIL,
      },
    });
  }

  // ── Demo workspace (idempotent by slug) ──────────────────────────────────
  const workspace = await prisma.workspace.upsert({
    where: { slug: 'demo-workspace' },
    update: {},
    create: { name: 'Demo Workspace', slug: 'demo-workspace', owner_id: user.id },
  });

  await prisma.workspaceMember.upsert({
    where: { workspace_id_user_id: { workspace_id: workspace.id, user_id: user.id } },
    update: { role: 'owner' },
    create: { workspace_id: workspace.id, user_id: user.id, role: 'owner' },
  });

  // ── Projects + their tasks ───────────────────────────────────────────────
  const projects = [
    {
      name: 'Mobile App',
      identifier: 'MOB',
      description: 'iOS & Android client for the task manager.',
      issues: [
        {
          title: 'Set up push notifications',
          group: 'started' as StateGroup,
          priority: 'high' as const,
          due: 7,
          assign: true,
        },
        {
          title: 'Fix crash on login screen',
          group: 'unstarted' as StateGroup,
          priority: 'urgent' as const,
          due: 2,
          assign: true,
        },
        {
          title: 'Add dark mode support',
          group: 'backlog' as StateGroup,
          priority: 'medium' as const,
          due: null,
          assign: false,
        },
        {
          title: 'Release v1.0 to the App Store',
          group: 'completed' as StateGroup,
          priority: 'high' as const,
          due: -3,
          assign: true,
        },
      ],
    },
    {
      name: 'Website Redesign',
      identifier: 'WEB',
      description: 'Marketing site refresh and performance work.',
      issues: [
        {
          title: 'Redesign the landing page',
          group: 'started' as StateGroup,
          priority: 'high' as const,
          due: 10,
          assign: true,
        },
        {
          title: 'Improve Lighthouse performance score',
          group: 'unstarted' as StateGroup,
          priority: 'medium' as const,
          due: 14,
          assign: false,
        },
        {
          title: 'Migrate the blog to a headless CMS',
          group: 'backlog' as StateGroup,
          priority: 'low' as const,
          due: null,
          assign: false,
        },
      ],
    },
  ];

  for (const p of projects) {
    const project = await prisma.project.upsert({
      where: { workspace_id_identifier: { workspace_id: workspace.id, identifier: p.identifier } },
      update: { name: p.name, description: p.description, lead_id: user.id },
      create: {
        workspace_id: workspace.id,
        name: p.name,
        identifier: p.identifier,
        description: p.description,
        lead_id: user.id,
      },
    });

    // Ensure the default workflow states exist (only seed them once).
    const stateCount = await prisma.state.count({ where: { project_id: project.id } });
    if (stateCount === 0) {
      await prisma.state.createMany({
        data: DEFAULT_STATES.map((s) => ({ ...s, project_id: project.id })),
      });
    }

    // Demo user is an admin member of the project.
    await prisma.projectMember.upsert({
      where: { project_id_user_id: { project_id: project.id, user_id: user.id } },
      update: { role: 'admin' },
      create: { project_id: project.id, user_id: user.id, role: 'admin' },
    });

    // Map state group -> id so each task can pick a state.
    const states = await prisma.state.findMany({ where: { project_id: project.id } });
    const stateByGroup = new Map(states.map((s) => [s.group, s.id]));

    // Create tasks with stable sequence_ids (1..N) so re-runs upsert in place.
    let seq = 0;
    for (const t of p.issues) {
      seq += 1;
      const stateId = stateByGroup.get(t.group);
      if (!stateId) continue;
      const isCompleted = t.group === 'completed';

      const issue = await prisma.issue.upsert({
        where: { project_id_sequence_id: { project_id: project.id, sequence_id: seq } },
        update: {
          title: t.title,
          state_id: stateId,
          priority: t.priority,
          due_date: t.due === null ? null : daysFromNow(t.due),
          completed_at: isCompleted ? daysFromNow(-3) : null,
        },
        create: {
          workspace_id: workspace.id,
          project_id: project.id,
          sequence_id: seq,
          title: t.title,
          description: `Demo task: ${t.title.toLowerCase()}.`,
          state_id: stateId,
          priority: t.priority,
          due_date: t.due === null ? null : daysFromNow(t.due),
          completed_at: isCompleted ? daysFromNow(-3) : null,
          created_by_id: user.id,
          sort_order: seq,
        },
      });

      if (t.assign) {
        await prisma.issueAssignee.upsert({
          where: { issue_id_user_id: { issue_id: issue.id, user_id: user.id } },
          update: {},
          create: { issue_id: issue.id, user_id: user.id },
        });
      }
    }

    // eslint-disable-next-line no-console
    console.log(`Seeded project ${p.identifier} "${p.name}" with ${p.issues.length} tasks.`);
  }

  // eslint-disable-next-line no-console
  console.log(
    `\nDemo workspace ready: slug="demo-workspace", login ${DEMO_EMAIL} / ${DEMO_PASSWORD}`,
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err: unknown) => {
    await prisma.$disconnect();
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
