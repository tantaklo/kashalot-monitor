// Daily fleet scan — runs in GitHub Actions, writes to data/history.json + data/tariff-history.json
import { readFileSync, writeFileSync } from 'fs';

const TOTAL = 2000;
const CONCURRENCY = 40;
const BASE_URL = 'https://k-s.app/qr/';

function parseDevice(html) {
  if (!html || html.includes('Нет Кашалота')) return { status: 'notfound', tariffs: [] };
  if (html.includes('устал') || html.includes('вернется') || html.includes('погода')) return { status: 'offline', tariffs: [] };
  if (!html.includes('shadow-text')) return { status: 'notfound', tariffs: [] };

  const types     = [...html.matchAll(/class="box"><h3 class="white">([\s\S]*?)<\/h3>/g)].map(m => m[1].trim());
  const durations = [...html.matchAll(/class="time"><h3 class="white">[\s\S]*?(\d+\s*мин)/g)].map(m => m[1].trim());
  const prices    = [...html.matchAll(/<h1 class="white shadow-text[\s\S]*?">[\s\S]*?(\d+)\s*₽<\/h1>/g)].map(m => m[1] + ' ₽');

  const tariffs = [];
  const count = Math.min(types.length, prices.length);
  for (let i = 0; i < count; i++) {
    tariffs.push({ type: types[i] || '', duration: durations[i] || '', price: prices[i] || '' });
  }
  return { status: 'up', tariffs };
}

async function checkOne(num) {
  try {
    const res = await fetch(BASE_URL + num, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    });
    return parseDevice(await res.text());
  } catch {
    return { status: 'error', tariffs: [] };
  }
}

function saveJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

async function scan() {
  let up = 0, offline = 0, total = 0, done = 0;
  const slotMap = {};  // "Тип|5 мин" → { "90 ₽": count, ... }

  for (let i = 1; i <= TOTAL; i += CONCURRENCY) {
    const batch = Array.from({ length: Math.min(CONCURRENCY, TOTAL - i + 1) }, (_, j) => i + j);
    const results = await Promise.all(batch.map(n => checkOne(n)));

    results.forEach(({ status, tariffs }) => {
      done++;
      if (status === 'up')      { up++;      total++; }
      if (status === 'offline') { offline++;  total++; }

      if (status === 'up') {
        tariffs.forEach(({ type, duration, price }) => {
          if (!type || !price) return;
          const key = `${type}|${duration}`;
          if (!slotMap[key]) slotMap[key] = {};
          slotMap[key][price] = (slotMap[key][price] || 0) + 1;
        });
      }
    });

    process.stdout.write(`\r${done}/${TOTAL} — доступны: ${up}, не в сезоне: ${offline}`);
  }

  console.log('\nГотово.');

  const today = new Date().toISOString().slice(0, 10);

  // --- history.json ---
  const entry = { date: today, available: up, offline, total };
  const history = loadJson('./data/history.json', []);
  const idx = history.findIndex(r => r.date === today);
  if (idx >= 0) history[idx] = entry; else history.push(entry);
  history.sort((a, b) => a.date.localeCompare(b.date));
  saveJson('./data/history.json', history.slice(-365));
  console.log(`history: ${JSON.stringify(entry)}`);

  // --- tariff-history.json ---
  const tariffEntry = { date: today, available: up, slots: slotMap };
  const tariffHistory = loadJson('./data/tariff-history.json', []);
  const ti = tariffHistory.findIndex(r => r.date === today);
  if (ti >= 0) tariffHistory[ti] = tariffEntry; else tariffHistory.push(tariffEntry);
  tariffHistory.sort((a, b) => a.date.localeCompare(b.date));
  saveJson('./data/tariff-history.json', tariffHistory.slice(-365));
  console.log(`tariff-history: ${Object.keys(slotMap).length} тарифных слотов`);
}

scan();
