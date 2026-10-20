import { existsSync, mkdirSync, symlinkSync, rmSync, lstatSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const askdbDir = resolve(root, 'node_modules', '@askdb');
mkdirSync(askdbDir, { recursive: true });

const mappings = [
  ['shared', resolve(root, 'packages', 'shared')],
  ['agent', resolve(root, 'packages', 'agent')],
  ['evals', resolve(root, 'packages', 'evals')],
  ['sql-guard', resolve(root, 'packages', 'sql-guard')],
  ['api', resolve(root, 'apps', 'api')],
  ['mcp', resolve(root, 'apps', 'mcp')],
  ['web', resolve(root, 'apps', 'web')],
];

for (const [name, target] of mappings) {
  const dest = resolve(askdbDir, name);
  let isLinked = false;
  try {
    if (existsSync(dest) || lstatSync(dest).isSymbolicLink()) {
      isLinked = true;
    }
  } catch {}

  if (!isLinked) {
    try {
      symlinkSync(target, dest, 'junction');
      console.log(`[link-workspaces] Linked @askdb/${name} -> ${target}`);
    } catch (e) {
      console.warn(`[link-workspaces] Could not link @askdb/${name}:`, e.message);
    }
  }
}
