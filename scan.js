// Daily fleet scan — runs in GitHub Actions, writes to data/history.json
import { readFileSync, writeFileSync } from 'fs';

const TOTAL = 2000;
const CONCURRENCY = 40;
const BASE_URL = 'https://k-s.app/qr/';

function parseStatus(html) {
  if (!html || html.includes('Нет Кашалота')) return 'notfound';
  if (html.includes('устал') || html.includes('вернется') || html.includes('погода')) return 'offline';
  if (html.includes('shadow-text')) return 'up';
  return 'notfound';
}

async function checkOne(num) {
  try {
    const res = await fetch(BASE_URL + num, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    });
    const html = await res.text();
    return parseStatus(html);
  } catch {
    return 'error';
  }
}

async function scan() {
  let up = 0, offline = 0, total = 0, done = 0;

  for (let i = 1; i <= TOTAL; i += CONCURRENCY) {
    const batch = Array.from({ length: Math.min(CONCURRENCY, TOTAL - i + 1) }, (_, j) => i + j);
    const results = await Promise.all(batch.map(n => checkOne(n)));

    results.forEach(status => {
      done++;
      if (status === 'up')      { up++;      total++; }
      if (status === 'offline') { offline++;  total++; }
    });

    process.stdout.write(`\r${done}/${TOTAL} — доступны: ${up}, не в сезоне: ${offline}`);
  }

  console.log('\nГотово.');

  const today = new Date().toISOString().slice(0, 10);
  const entry = { date: today, available: up, offline, total };

  const historyPath = './data/history.json';
  const history = JSON.parse(readFileSync(historyPath, 'utf8'));

  // Заменяем запись за сегодня если уже есть, иначе добавляем
  const idx = history.findIndex(r => r.date === today);
  if (idx >= 0) history[idx] = entry;
  else history.push(entry);

  // Сортируем по дате, храним последние 365 дней
  history.sort((a, b) => a.date.localeCompare(b.date));
  const trimmed = history.slice(-365);

  writeFileSync(historyPath, JSON.stringify(trimmed, null, 2));
  console.log(`Записано: ${JSON.stringify(entry)}`);
}

scan();
