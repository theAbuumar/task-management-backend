---
description: Resume the auth build — read AUTH-ROADMAP, work the current phase, commit when the phase is done, then wait.
---

You are building the **authentication system** for the Task Management Backend, driven by
`AUTH-ROADMAP.md`. This command works **one phase per run**: pick up where the roadmap left
off, finish the current phase's tasks, commit, and stop. Do the following **in order**:

1. **Read `AUTH-ROADMAP.md`** (project root). Look at the **Current Status** block and find the
   **current phase** — the first phase that still has any unchecked `- [ ]` task. Also read the
   **Resolved Decisions** section and treat every item there as settled (do not re-open the OTP
   sizes, session TTLs, find-or-create rules, merge-by-verified-email rule, etc.).

2. **Read the spec as needed** — `auth_tz.md` is the authoritative requirement. Read the
   section(s) relevant to the tasks you're about to do; don't re-read the whole file if the work
   is narrow. Consult `CLAUDE.md` for architecture rules (routes → controller → service →
   Prisma; services own authorization and business logic; validate all input with Zod/Fastify
   schemas; each feature a self-contained module).

3. **Report to the user before writing code** — a short status:
   - Which phase you're on and its goal
   - What's already checked off (what previous runs finished)
   - The specific unchecked tasks in this phase you're about to implement

4. **Implement the current phase.** Work through the unchecked `- [ ]` tasks of the current
   phase **in order**. For every task you genuinely finish, tick it to `- [x]` in
   `AUTH-ROADMAP.md` immediately (mark after the change is done, not before). Keep code
   consistent with the existing `src/modules/auth/` module and the project's conventions. After
   schema changes run `npx prisma migrate dev` + `npx prisma generate`. Keep the build and tests
   green (`npm run build`, `npm run lint`, `npm run test`) before considering a task done.

5. **When the whole phase's tasks are checked**, checkpoint and commit:
   - Refresh the **Current Status** block in `AUTH-ROADMAP.md`: set **Last Session** to today,
     advance **Current Phase** to the next phase, and set **Next Task** to its first unchecked item.
   - `git add -A` and commit on the current branch (never `main`) with a concise one-line summary
     of the phase, e.g. `Auth Phase A1: email + password with OTP verification`, ending the
     message with:
     ```
     Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
     ```
   - **Do not open a pull request and do not push to `main`.** Stay on the auth branch.

6. **Stop and wait.** Tell the user: the phase is committed, one-line recap of what shipped, and
   the **Next Task** the next `/start-auth` will pick up. Then wait for the next `/start-auth`.

If a phase is large, it's fine to stop partway: tick the tasks you finished, report clearly what
remains in the phase, and commit the partial progress (mention in the recap that the phase is not
yet complete so the next run resumes it rather than advancing).

$ARGUMENTS
