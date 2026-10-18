// Quick-login buttons on the demo stand (13.B2, fixed in 13.P5): the four story
// roles are tagged explicitly and come first, so «Декан» is always the dean of
// ФЭУ — the account that carries the presenter's Telegram — whatever order the
// seed happened to create the accounts in.

import { describe, expect, it } from 'vitest';
import { withDemoRoles } from '../src/modules/auth/demo-routes.js';
import { DEMO_ROLE_EMAILS } from '../src/prisma/demo/university.js';

describe('demo quick-login accounts', () => {
  it('maps the story roles to the seeded accounts', () => {
    expect(DEMO_ROLE_EMAILS).toEqual({
      rector: 'rector@demo.local',
      prorector: 'pr.edu@demo.local',
      dean: 'dean.econ@demo.local',
      employee: 'umu.spec@demo.local',
    });
  });

  it('tags the four roles and lists them first, in story order', () => {
    const accounts = withDemoRoles([
      { email: 'dean.it@demo.local', position: 'Декан ФИТ' },
      { email: 'umu.spec@demo.local', position: 'Методист УМУ' },
      { email: 'dean.econ@demo.local', position: 'Декан ФЭУ' },
      { email: null, position: null },
      { email: 'pr.edu@demo.local', position: 'Проректор по учебной работе' },
      { email: 'rector@demo.local', position: 'Ректор' },
    ]);
    expect(accounts.map((a) => [a.email, a.demo_role])).toEqual([
      ['rector@demo.local', 'rector'],
      ['pr.edu@demo.local', 'prorector'],
      ['dean.econ@demo.local', 'dean'],
      ['umu.spec@demo.local', 'employee'],
      ['dean.it@demo.local', null],
      [null, null],
    ]);
  });
});
