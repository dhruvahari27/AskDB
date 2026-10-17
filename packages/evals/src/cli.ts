import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createProvider } from '@askdb/agent';
import { getConfig, repoRoot } from '@askdb/shared';
import { createReadOnlyPool } from '@askdb/sql-guard';
import { loadCases } from './dataset';
import { Harness } from './harness';
import { summarizeByMode, type CaseResult, type Mode } from './metrics';

const { values } = parseArgs({
  options: {
    modes: { type: 'string', default: 'baseline,classifier,execution' },
    split: { type: 'string', default: 'dev' },
    limit: { type: 'string' },
    defaults: { type: 'boolean', default: false },
    smoke: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`npm run evals -- [options]
  --modes baseline,classifier,execution   which modes to run
  --split dev|test|all                    which part of the dataset (default dev)
  --limit N                               first N cases only (quick checks)
  --defaults                              start with the app's default approved glossary terms (default: empty glossary)
  --smoke                                 allow the offline mock model; prints a table but saves nothing`);
  process.exit(0);
}

const cfg = getConfig();
if (cfg.LLM_PROVIDER === 'mock' && !values.smoke) {
  console.error(
    'LLM_PROVIDER=mock. The offline demo model is built around the sample questions, so its scores say nothing about the method.\n' +
      'Set LLM_PROVIDER=groq (GROQ_API_KEY) or gemini (GEMINI_API_KEY) in .env, or pass --smoke to check the harness itself (nothing is saved).',
  );
  process.exit(2);
}

const modes = (values.modes ?? '').split(',').map((m) => m.trim()).filter(Boolean) as Mode[];
for (const m of modes) if (!['baseline', 'classifier', 'execution'].includes(m)) throw new Error(`Unknown mode "${m}"`);

let cases = loadCases();
if (values.split !== 'all') cases = cases.filter((c) => c.split === values.split);
if (values.limit) cases = cases.slice(0, Number(values.limit));
if (cases.length === 0) throw new Error('No cases selected.');

const llm = await createProvider(cfg, { cache: 'file' });
const pool = createReadOnlyPool(cfg.WAREHOUSE_READONLY_URL, 4);
const harness = new Harness({
  llm,
  warehouse: pool,
  limits: { timeoutMs: cfg.STATEMENT_TIMEOUT_MS, maxRows: cfg.MAX_RESULT_ROWS, maxPlanCost: cfg.MAX_PLAN_COST },
  useDefaultGlossary: Boolean(values.defaults),
});

const startedAt = new Date().toISOString();
const results: CaseResult[] = [];
console.log(`Evaluating ${cases.length} questions x ${modes.length} modes with ${llm.name}/${llm.model} (glossary: ${values.defaults ? 'defaults' : 'empty'})\n`);

for (const c of cases) {
  const gold = await harness.goldRows(c);
  for (const mode of modes) {
    const r = await harness.runCase(c, mode, gold);
    results.push(r);
    console.log(`${r.correct ? 'ok  ' : 'FAIL'} ${c.id.padEnd(4)} ${mode.padEnd(10)} ${r.asked ? 'asked' : '     '} ${String(r.ms).padStart(6)}ms  ${c.question}${r.error ? `   [${r.error}]` : ''}`);
  }
}

const summary = summarizeByMode(results);
const pct = (v: number | null) => (v === null ? '  -' : `${Math.round(v * 100)}%`.padStart(4));
console.log('\nmode        acc   amb   clear  over-ask  recall  turns  p50     p95     tok/q');
for (const m of modes) {
  const s = summary[m]!;
  console.log(
    `${m.padEnd(10)}  ${pct(s.executionAccuracy)}  ${pct(s.accuracyAmbiguous)}  ${pct(s.accuracyClear)}   ${pct(s.overAskRate)}      ${pct(s.ambiguityRecall)}   ${s.avgTurns.toFixed(2)}   ${(s.p50Ms / 1000).toFixed(1)}s   ${(s.p95Ms / 1000).toFixed(1)}s   ${Math.round(s.tokensPerQuestion)}`,
  );
}

if (llm.name === 'mock') {
  console.log('\n--smoke run with the mock model: results were NOT saved.');
} else {
  let commit: string | undefined;
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    /* not a git checkout */
  }
  const dir = resolve(repoRoot, 'packages/evals/results');
  mkdirSync(dir, { recursive: true });
  const id = `${startedAt.replace(/[:.]/g, '-')}_${llm.model.replace(/[^\w.-]/g, '_')}`;
  const file = resolve(dir, `${id}.json`);
  writeFileSync(file, JSON.stringify({ startedAt, provider: llm.name, model: llm.model, commit, split: values.split, glossary: values.defaults ? 'defaults' : 'empty', cases: cases.length, summary, results }, null, 2));
  console.log(`\nSaved ${file}\nOpen the Evaluation page in the app to see it.`);
}
await pool.end();
