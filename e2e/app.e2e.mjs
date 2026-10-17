// Browser end-to-end checks. Needs the app running (npm run dev, or npm run build && npm start) with LLM_PROVIDER=mock.
//   npm run e2e                       (first time: npx playwright install chromium)
// Env: E2E_BASE (default http://localhost:4711), E2E_CHROMIUM (path to a Chromium binary, optional)
// Every run registers its own users, so it is safe to repeat. Admin-only checks run only when the first user
// of an empty database is the admin; otherwise they are reported as SKIP.
import { chromium } from 'playwright';

const base = process.env.E2E_BASE || 'http://localhost:4711';
const browser = await chromium.launch(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {});
const stamp = Date.now();
const out = [];
let failed = 0;
const T = async (name, fn) => {
  try { const r = await fn(); out.push(r === 'skip' ? `SKIP ${name}` : `PASS ${name}`); }
  catch (e) { failed++; out.push(`FAIL ${name} :: ${String(e.message).split('\n')[0]}`); }
};
const newPage = async (w = 1440, h = 900) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { failed++; out.push(`FAIL page error :: ${e.message}`); });
  return { ctx, p };
};
const nav = (p, label) => p.locator('nav a.nav-link', { hasText: label });
const register = async (p, email) => {
  await p.goto(base);
  await p.getByText('New here? Create an account').click();
  await p.getByLabel('Email').fill(email);
  await p.getByLabel('Password').fill('pass12345');
  await p.getByRole('button', { name: 'Create account' }).click();
  await p.waitForSelector('[role=dialog][aria-label="Welcome tour"]');
};
const skipTour = async (p) => { await p.getByRole('button', { name: 'Skip' }).click(); };
const ask = async (p, q) => { await p.getByPlaceholder('Ask a question about your data…').fill(q); await p.getByRole('button', { name: 'Send' }).click(); };
const newChat = (p) => p.getByRole('button', { name: 'New conversation' }).click();

const A = await newPage();
const p = A.p;
await register(p, `admin-${stamp}@example.com`);

await T('tour: opens, steps, finishes into Ask, never returns', async () => {
  await p.getByRole('button', { name: 'Next' }).click();
  await p.waitForSelector('text=It asks you back only when it matters');
  await p.getByRole('button', { name: 'Back' }).click();
  for (let i = 0; i < 3; i++) await p.getByRole('button', { name: 'Next' }).click();
  await p.getByRole('button', { name: /Ask my first question/ }).click();
  await p.waitForSelector('text=What do you want to know?');
  await p.reload();
  await p.waitForSelector('text=What do you want to know?');
  if (await p.locator('[role=dialog][aria-label="Welcome tour"]').count()) throw new Error('tour came back');
});
await T('empty Ask page shows the first-time hint and samples', () => p.waitForSelector('text=First time here?'));

await T('checklist starts at 0 of 4', async () => { await nav(p, 'Overview').click(); await p.waitForSelector('text=0 of 4'); });
await nav(p, 'Ask').click();

await T('clear question: table, sort, CSV', async () => {
  await ask(p, 'What is the order status breakdown?');
  await p.waitForSelector('.answer');
  await p.locator('.dt th').first().click();
  const [d] = await Promise.all([p.waitForEvent('download'), p.getByText('Download CSV').click()]);
  if (!d.suggestedFilename().endsWith('.csv')) throw new Error('bad csv name');
});
await T('chart, SQL and explanation tabs', async () => {
  await p.getByRole('tab', { name: 'Chart' }).click();
  await p.waitForSelector('.recharts-bar-rectangle, .recharts-rectangle');
  await p.getByRole('tab', { name: 'SQL' }).click(); await p.waitForSelector('pre.sql');
  await p.getByRole('tab', { name: 'Explanation' }).click(); await p.waitForSelector('.explain-text');
});
await T('feedback: thumbs up, thumbs down with correction', async () => {
  await p.getByLabel('Good answer').click();
  await p.waitForSelector('[aria-label="Good answer"][aria-pressed="true"]');
  await p.getByLabel('Wrong answer').click();
  await p.locator('.modal textarea').last().fill('SELECT order_status FROM orders');
  await p.getByRole('button', { name: 'Submit' }).click();
  await p.waitForSelector('text=Thanks, your correction was saved.');
});
await T('trace panel lists steps', () => p.waitForSelector('.trace .step'));
await T('line chart for a monthly question', async () => {
  await newChat(p); await ask(p, 'Show monthly revenue'); await p.waitForSelector('.answer');
  await p.getByRole('tab', { name: 'Chart' }).click(); await p.waitForSelector('.recharts-line');
});
await T('ambiguous question asks, explainer opens, option answers, survives reload', async () => {
  await newChat(p); await ask(p, 'Who is our best customer?');
  await p.waitForSelector('.clarify');
  await p.getByText('Why am I being asked this?').click();
  await p.waitForSelector('text=wrote a query for each possible meaning');
  await p.reload(); await p.waitForSelector('.clarify');
  await p.locator('.opt').first().click(); await p.waitForSelector('.answer', { timeout: 30000 });
});
await T('free-text clarification completes (no hang)', async () => {
  await newChat(p); await ask(p, 'Show the top 5 sellers'); await p.waitForSelector('.clarify');
  await p.getByLabel('Describe what you mean').fill('by number of items sold');
  await p.locator('.clarify .btn.indigo').click();
  await p.waitForSelector('.answer', { timeout: 30000 });
});
await T('classifier mode can ask; baseline never asks', async () => {
  await newChat(p); await p.getByRole('radio', { name: 'Classifier' }).click(); await ask(p, 'Who is our best customer?');
  await p.waitForSelector('.clarify, .answer', { timeout: 30000 });
  await newChat(p); await p.getByRole('radio', { name: 'Baseline' }).click(); await ask(p, 'Who is our best customer?');
  await p.waitForSelector('.answer, .clarify', { timeout: 30000 });
  if (await p.locator('.clarify').count()) throw new Error('baseline asked');
  await p.getByRole('radio', { name: 'Execution' }).click();
});
await T('unknown question ends in a card, short question is blocked', async () => {
  await newChat(p); await ask(p, 'zzzz qqqq wwww'); await p.waitForSelector('.answer, .card', { timeout: 30000 });
  await p.getByPlaceholder('Ask a question about your data…').fill('hi');
  if (!(await p.getByRole('button', { name: 'Send' }).isDisabled())) throw new Error('send enabled for 2 chars');
  await p.getByPlaceholder('Ask a question about your data…').fill('');
});
await T('conversations: reopen and delete', async () => {
  const n = await p.locator('.conv-item').count();
  await p.locator('.conv-item .title').nth(1).click(); await p.waitForSelector('.bubble-user');
  p.once('dialog', (d) => d.accept());
  await p.locator('.conv-item.active .x').click(); await p.waitForTimeout(600);
  if ((await p.locator('.conv-item').count()) !== n - 1) throw new Error('not deleted');
});

await nav(p, 'Glossary').click();
await p.locator('table.tbl').waitFor();
const isAdmin = (await p.locator('text=admin only').count()) === 0;
const term = `e2e term ${stamp}`;
await T('glossary: add, edit, reject, delete (admin)', async () => {
  if (!isAdmin) return 'skip';
  await p.getByRole('button', { name: 'Add a term' }).click();
  await p.getByLabel('Term', { exact: true }).fill(term);
  await p.locator('.modal textarea').fill('customers with more than 1 order');
  await p.getByRole('button', { name: 'Save' }).click();
  await p.waitForSelector(`td:has-text("${term}")`);
  await p.locator(`tr:has-text("${term}") >> text=Edit`).click();
  await p.locator('.modal textarea').fill('customers with two or more orders');
  await p.getByRole('button', { name: 'Save' }).click(); await p.waitForSelector('text=two or more orders');
  await p.locator(`tr:has-text("${term}") >> button:text-is("Reject")`).click();
  await p.waitForSelector(`tr:has-text("${term}") .chip.bad`);
  p.once('dialog', (d) => d.accept());
  await p.locator(`tr:has-text("${term}") >> text=Delete`).click(); await p.waitForTimeout(600);
  if (await p.locator(`td:has-text("${term}")`).count()) throw new Error('still listed');
});
await T('schema page tags personal data and filters', async () => {
  await nav(p, 'Schema').click(); await p.waitForSelector('.schema-grid');
  if (!(await p.locator('text=personal data').count())) throw new Error('no personal-data tag');
  await p.getByLabel('Filter').fill('sellers');
});
await T('evaluation page renders (empty state or results)', async () => {
  await nav(p, 'Evaluation').click(); await p.getByText('No evaluation runs yet').or(p.locator('.stat-grid')).first().waitFor();
});
await T('checklist reaches 4 of 4 and can be hidden for good', async () => {
  await nav(p, 'Overview').click(); await p.waitForSelector('text=4 of 4');
  await p.getByRole('button', { name: 'Hide' }).click(); await p.reload(); await p.waitForSelector('.stat-grid');
  if (await p.locator('[aria-label="Getting started"]').count()) throw new Error('checklist came back');
});
await T('help page, FAQ and tour replay', async () => {
  await nav(p, 'Help').click(); await p.waitForSelector('text=Your first five minutes');
  await p.getByText('Why did it ask me a question?').click(); await p.waitForSelector('text=actual results were different');
  await p.getByRole('button', { name: 'Replay the welcome tour' }).click();
  await p.waitForSelector('[role=dialog][aria-label="Welcome tour"]'); await p.getByRole('button', { name: 'Skip' }).click();
});

// second user: isolation, permissions, expired session
const B = await newPage();
await T('second user: sees the tour, no conversations of others, no admin buttons', async () => {
  await register(B.p, `user-${stamp}@example.com`); await skipTour(B.p);
  await nav(B.p, 'Ask').click();
  if ((await B.p.locator('.conv-item').count()) !== 0) throw new Error('sees another user\'s conversations');
  await nav(B.p, 'Glossary').click();
  if (isAdmin) await B.p.waitForSelector('text=admin only');
});
await T('expired session returns to the sign-in screen', async () => {
  await B.ctx.clearCookies(); await B.p.reload(); await B.p.waitForSelector('button:has-text("Sign in")');
});
await T('sign out and sign in again', async () => {
  await p.getByLabel('Sign out').click(); await p.waitForSelector('button:has-text("Sign in")');
  await p.getByLabel('Email').fill(`admin-${stamp}@example.com`); await p.getByLabel('Password').fill('pass12345');
  await p.getByRole('button', { name: 'Sign in' }).click(); await p.waitForSelector('nav a.nav-link');
});
await T('wrong password shows an error', async () => {
  const C = await newPage(); await C.p.goto(base);
  await C.p.getByLabel('Email').fill(`admin-${stamp}@example.com`); await C.p.getByLabel('Password').fill('wrong-password');
  await C.p.getByRole('button', { name: 'Sign in' }).click(); await C.p.waitForSelector('.error-box'); await C.ctx.close();
});
await T('phone width: no horizontal scroll on any page', async () => {
  await p.setViewportSize({ width: 390, height: 800 });
  for (const href of ['/', '/ask', '/glossary', '/schema', '/evals', '/help']) {
    await p.locator(`nav a.nav-link[href="${href}"]`).click(); await p.waitForTimeout(300);
    const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (over > 2) throw new Error(`${href} overflows by ${over}px`);
  }
});

await browser.close();
console.log(out.join('\n'));
console.log(failed ? `\n${failed} failing` : '\nall passed');
process.exit(failed ? 1 : 0);
