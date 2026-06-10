// sync-contracts.js
// Читает папки ЭЦП партнёров → обновляет data/partners-status.json → git push

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const HOME  = homedir();

// Папка ЭЦП для каждого партнёра (ключ = id в dashboard)
const FOLDERS = {
  'Баранова':         `${HOME}/Downloads/12_Партнёры/Баранова/Договоры/ЭЦП`,
  'Котовщикова':      `${HOME}/Downloads/12_Партнёры/Котовщикова/Договоры/ЭЦП`,
  'Богатищев':        `${HOME}/Downloads/12_Партнёры/Богатищев/Договоры/ЭЦП`,
  'ГородскиеРешения': `${HOME}/Downloads/12_Партнёры/Городские Решения/Договоры/ЭЦП`,
};

// Партнёры без папки → всегда draft
const DRAFT_KEYS = new Set(['ГородскиеРешения']);

function checkSigned(folder) {
  if (!existsSync(folder)) return false;
  const files = readdirSync(folder);
  return files.some(f => f.includes('Договор') && f.endsWith('_ЭЦП.pdf'));
}

const statusPath = resolve(__dir, 'data/partners-status.json');
const prev = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, 'utf8')) : {};

const next = {};
for (const [key, folder] of Object.entries(FOLDERS)) {
  if (DRAFT_KEYS.has(key) && !existsSync(folder)) {
    next[key] = 'draft';
  } else {
    next[key] = checkSigned(folder) ? 'signed' : 'pending';
  }
}

const changed = JSON.stringify(prev) !== JSON.stringify(next);
if (!changed) {
  console.log('Статусы не изменились, пуш не нужен.');
  process.exit(0);
}

writeFileSync(statusPath, JSON.stringify(next, null, 2));
console.log('Обновлено:', next);

try {
  execSync('git add data/partners-status.json', { cwd: __dir, stdio: 'inherit' });
  execSync('git commit -m "sync: статусы ЭЦП партнёров"', { cwd: __dir, stdio: 'inherit' });
  execSync('git push', { cwd: __dir, stdio: 'inherit' });
  console.log('Запушено.');
} catch (e) {
  console.error('Git push failed:', e.message);
}
