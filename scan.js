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

  // --- history.json: максимум доступных и пик аренды за день ---
  const history = loadJson('./data/history.json', []);
  const idx = history.findIndex(r => r.date === today);
  const prev = history[idx];

  // max_available — пиковое число доступных (лучший момент дня)
  // peak_rented  — пик одновременных аренд = total − min_available
  const prevMax    = prev?.max_available ?? 0;
  const prevMin    = prev?.min_available ?? up;
  const maxAvail   = Math.max(up, prevMax);
  const minAvail   = Math.min(up, prevMin);
  const peakRented = total > 0 ? total - minAvail : (prev?.peak_rented ?? 0);
  const scans      = (prev?.scans ?? 0) + 1;

  const entry = { date: today, max_available: maxAvail, min_available: minAvail, peak_rented: peakRented, offline, total, scans };
  if (idx >= 0) history[idx] = entry; else history.push(entry);
  history.sort((a, b) => a.date.localeCompare(b.date));
  saveJson('./data/history.json', history.slice(-365));
  console.log(`history [скан ${scans}]: max_available=${maxAvail}, peak_rented=${peakRented}`);

  // --- tariff-history.json: тарифы сохраняем только если слотов больше, чем раньше ---
  const tariffHistory = loadJson('./data/tariff-history.json', []);
  const ti = tariffHistory.findIndex(r => r.date === today);
  const prevTariff = tariffHistory[ti];
  const prevSlots  = Object.keys(prevTariff?.slots ?? {}).reduce((s, k) => s + Object.values(prevTariff.slots[k]).reduce((a, b) => a + b, 0), 0);
  const curSlots   = Object.keys(slotMap).reduce((s, k) => s + Object.values(slotMap[k]).reduce((a, b) => a + b, 0), 0);
  if (!prevTariff || curSlots >= prevSlots) {
    const tariffEntry = { date: today, available: up, slots: slotMap };
    if (ti >= 0) tariffHistory[ti] = tariffEntry; else tariffHistory.push(tariffEntry);
    tariffHistory.sort((a, b) => a.date.localeCompare(b.date));
    saveJson('./data/tariff-history.json', tariffHistory.slice(-365));
    console.log(`tariff-history: обновлено (${curSlots} устройств с тарифами)`);
  } else {
    console.log(`tariff-history: пропущено (${curSlots} < ${prevSlots} устройств, оставляем лучший замер)`);
  }
}

scan();
