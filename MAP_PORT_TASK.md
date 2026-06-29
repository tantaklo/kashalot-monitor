# Задача: портировать карту из partner-dashboard в dashboard.html

## Что нужно сделать

Заменить карту в `Projects/monitor/dashboard.html`:
- **Было:** Leaflet + CartoDB dark tiles + только маркеры
- **Стать:** 2GIS MapGL JS + маркеры + полигоны зон катания

Всё это уже работает в `partner-dashboard.html` — нужно перенести.

---

## Файл для изменения

`Projects/monitor/dashboard.html`

### Где находится карта в HTML

Строка ~1238:
```html
<!-- Карта КШ -->
<div class="chart-header collapsible" onclick="toggleSection('mapBody','mapArrow'); initMapSection()">
  ...
  <div id="kashalotMap" style="height:500px;border-radius:10px;overflow:hidden;margin-top:4px"></div>
```

Контейнер карты: `id="kashalotMap"` (500px высота)  
Статус: `id="mapStatus"`

### Где находится JavaScript карты

Строки ~4482–4577:
- `initMapSection()` — ленивая инициализация (вызывается при клике на заголовок секции)
- `refreshMapData()` — загружает данные, 5-мин кэш
- `renderMapMarkers(rows)` — рендерит маркеры

---

## 2GIS API ключ

```
f31683b5-5c11-4df6-9ec8-e3155d0b05d7
```

---

## Важные отличия dashboard.html от partner-dashboard.html

1. **Нет Worker** — главный дашборд обращается к Grafana напрямую через `grafanaQuery(sql)`
2. **Нет фильтра по компаниям** — admin видит все, фильтр не нужен
3. **MapGL координаты** — `[longitude, latitude]` (не lat/lng как в Leaflet!)
4. **Функция запросов** — `grafanaQuery(sql)` возвращает массив строк

---

## Код для замены (строки ~4482–4577)

Заменить весь блок `// ─── Карта КШ ───` на следующее:

```javascript
// ─── Карта КШ (2GIS MapGL JS) ────────────────────────────────────────────
const _2GIS_KEY = 'f31683b5-5c11-4df6-9ec8-e3155d0b05d7';
let _mapInited = false, _mapInstance = null;
let _mapMarkers = [], _mapZoneLayers = [];
let _mapCacheTime = 0, _mapCacheData = null;

async function initMapSection() {
  if (_mapInited) return;
  _mapInited = true;
  document.getElementById('mapStatus').textContent = 'Загрузка карты…';
  if (!window.mapgl) {
    await new Promise(res => {
      const s = document.createElement('script');
      s.src = 'https://mapgl.2gis.com/api/js/v1';
      s.onload = res; document.body.appendChild(s);
    });
  }
  _mapInstance = new mapgl.Map('kashalotMap', {
    key: _2GIS_KEY,
    center: [37.615, 55.752],
    zoom: 5,
  });
  // Скролл внутри карты → зум, не скролл страницы
  document.getElementById('kashalotMap').addEventListener('wheel', e => e.preventDefault(), { passive: false });
  await refreshMapData();
}

async function refreshMapData() {
  if (!_mapInstance) return;
  const statusEl = document.getElementById('mapStatus');
  const now = Date.now();
  if (_mapCacheData && now - _mapCacheTime < 5 * 60 * 1000) {
    renderMapMarkers(_mapCacheData);
    return;
  }
  if (statusEl) statusEl.textContent = 'Загрузка данных…';
  try {
    // Найти колонку с полигоном динамически
    const colRows = await grafanaQuery(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'geozones'
    `);
    const polyCol = colRows.map(r => r.COLUMN_NAME || r.column_name || '')
      .find(n => /polygon|area|coords|points|geom|shape|boundary/i.test(n));

    const [rows, zoneRows] = await Promise.all([
      grafanaQuery(`
        SELECT id, gosnomer, fuel, lat, lon
        FROM cars
        WHERE online = 1
          AND cur_order_id IS NULL
          AND lat IS NOT NULL AND lat != 0
          AND lon IS NOT NULL AND lon != 0
          AND (hidden IS NULL OR hidden = 0)
          AND fuel > 5
        ORDER BY fuel DESC
        LIMIT 600
      `),
      polyCol ? grafanaQuery(`
        SELECT id, name, \`${polyCol}\` AS polygon
        FROM geozones
        WHERE id != 1
          AND \`${polyCol}\` IS NOT NULL AND \`${polyCol}\` != '' AND \`${polyCol}\` != '[]'
      `) : Promise.resolve([]),
    ]);

    _mapCacheData = rows;
    _mapCacheTime = now;
    renderMapZones(zoneRows || []);
    renderMapMarkers(rows);
  } catch(e) {
    if (statusEl) statusEl.textContent = 'Ошибка загрузки данных';
    console.error('Map error:', e);
  }
}

function renderMapZones(zones) {
  _mapZoneLayers.forEach(l => l.destroy());
  _mapZoneLayers = [];
  zones.forEach(gz => {
    try {
      const pts = JSON.parse(gz.polygon).map(p => [+p.lng, +p.lat]); // [lng, lat]!
      if (pts.length < 3) return;
      const ring = [...pts];
      if (ring[0][0] !== ring[ring.length-1][0] || ring[0][1] !== ring[ring.length-1][1]) ring.push(ring[0]);
      const poly = new mapgl.Polygon(_mapInstance, {
        coordinates: [ring],
        color: 'rgba(0,150,136,0.1)',
        strokeColor: 'rgba(0,150,136,0.6)',
        strokeWidth: 2,
      });
      _mapZoneLayers.push(poly);
    } catch(e) {}
  });
}

function renderMapMarkers(rows) {
  const statusEl = document.getElementById('mapStatus');
  _mapMarkers.forEach(m => m.destroy());
  _mapMarkers = [];
  rows.forEach(r => {
    const fuel = +r.fuel || 0;
    const color = fuel > 50 ? '#22c55e' : fuel > 20 ? '#f59e0b' : '#ef4444';
    const m = new mapgl.HtmlMarker(_mapInstance, {
      coordinates: [+r.lon, +r.lat], // [lng, lat]!
      html: `<div class="ksh-marker"><div class="ksh-dot" style="background:${color}"></div><div class="ksh-popup"><b>КШ-${r.id}</b><br>${r.gosnomer || '—'}<br>⚡ ${fuel}%</div></div>`,
      anchor: [7, 7],
    });
    _mapMarkers.push(m);
  });
  if (rows.length > 1) {
    const lngs = rows.map(r => +r.lon), lats = rows.map(r => +r.lat);
    try {
      _mapInstance.fitBounds(
        [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
        { padding: 50 }
      );
    } catch(e) {
      _mapInstance.setCenter([(Math.min(...lngs)+Math.max(...lngs))/2, (Math.min(...lats)+Math.max(...lats))/2]);
    }
  }
  const t = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (statusEl) statusEl.textContent = `${rows.length} КШ доступны к аренде · обновлено ${t}`;
}
// ─────────────────────────────────────────────────────────────────────────
```

---

## CSS для маркеров (добавить в `<style>`)

Найти в dashboard.html блок `<style>` и добавить:

```css
.ksh-marker { position: relative; cursor: pointer; }
.ksh-dot { width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(0,0,0,.35); box-shadow: 0 0 4px rgba(0,0,0,.4); }
.ksh-popup { display: none; position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); background: #1e2a3a; color: #e2e8f0; font-size: 12px; padding: 5px 9px; border-radius: 6px; border: 1px solid #2dd4bf55; white-space: nowrap; pointer-events: none; z-index: 999; }
.ksh-popup b { color: #2dd4bf; }
.ksh-marker:hover .ksh-popup { display: block; }
```

---

## Легенда карты (опционально)

В HTML секции карты есть легенда с Leaflet-кружками. После замены можно обновить цвета:
- Зелёный `#22c55e` = Заряд >50%
- Янтарный `#f59e0b` = Заряд 20–50%
- Красный `#ef4444` = Заряд <20%

---

## После изменений

Сделать `git add dashboard.html && git commit && git push` чтобы задеплоить на GitHub Pages.
