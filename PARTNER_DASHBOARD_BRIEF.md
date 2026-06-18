# Партнёрский дашборд — бриф для новой сессии

> Читать в самом начале работы над `partner-dashboard.html`.
> Всё согласовано с Антоном в сессии 2026-06-18.

---

## Что строим

Дашборд для франчайзи-партнёров Кашалота. У каждого партнёра — одна или несколько компаний в системе. Нужны те же графики что в основном `dashboard.html`, но:

- данные фильтруются только по компаниям этого партнёра
- можно смотреть компании по отдельности и суммарно
- вход — через Google-аккаунт
- Антон управляет доступами (email → company_id[]) из своего дашборда

**Главная проблема бизнеса — простои техники.** Устройства с нулевой выручкой за период обязательно показывать, не скрывать.

---

## Где живёт проект

- Репо: `tantaklo/kashalot-monitor` (уже клонирован в `Projects/monitor/`)
- Новый файл: `partner-dashboard.html` (рядом с `dashboard.html`)
- Тот же Cloudflare Worker: `kashalot-proxy.vegano-argentino-ru.workers.dev`
- Worker файл: `Projects/monitor/worker.js`
- Deploy worker: `cd Projects/monitor && npx wrangler deploy` (git push НЕ деплоит worker!)
- Deploy dashboard: `git push` → GitHub Actions → GitHub Pages (автоматически)

---

## API — доступ к данным

```
POST https://kashalot-proxy.vegano-argentino-ru.workers.dev/grafana
Headers:
  Content-Type: application/json
  X-Token: 8c76e677dcdedad18ee2a79eab8bfeff
Body: { "sql": "SELECT ..." }
```

Ответ — Grafana dataframes:
```json
{
  "results": { "A": { "frames": [{
    "schema": { "fields": [{"name": "col1"}, ...] },
    "data":   { "values": [[row1val, row2val, ...], ...] }
  }]}}
}
```

Парсинг в dashboard.html уже есть — функция `grafanaQuery(sql)` возвращает массив объектов.
В worker.js — функция `grafanaSQL(sql, env)` делает то же самое на серверной стороне.

---

## Схема базы данных

### cars — устройства (~3000 болванок трекеров, все Кашалот)
| Поле | Описание |
|---|---|
| id | ID устройства (отображается как КШ-{id}) |
| gosnomer | Госномер |
| fuel | Заряд % (0 = выключен/на хранении) |
| online | 1 = онлайн сейчас |
| company_id | FK → companies |

### companies — компании/партнёры
| Поле | Описание |
|---|---|
| id | ID компании |
| name | Название, например: `Красногорск [ИП Баранова Агент АО КШ]` |

### orders — заказы
| Поле | Описание |
|---|---|
| id | ID заказа |
| car_id | FK → cars |
| company_id | FK → companies |
| start_time | Начало поездки (datetime) |
| finish_time | Конец (NULL = активен сейчас) |

### bills — платежи
| Поле | Описание |
|---|---|
| order_id | FK → orders |
| sum_card | Сумма в **копейках** (делить на 100 для рублей!) |
| status | `PAID` / `CANCELLED` / `CANCELED` |

### order_events — события заказа
| Поле | Описание |
|---|---|
| order_id | FK → orders |
| reason | Тип: `GEO` = выезд за зону |
| geo_id | 1 = за зоной |
| time | Время события |

**Парк (фактический)** = уникальные car_id, у которых хотя бы один день суммарная выручка ≥ 10 000 руб. Это единственный правильный способ считать запущенные устройства.

---

## Архитектура авторизации

### Google OAuth 2.0 через Cloudflare Worker

Нужны новые секреты в Worker (добавить через `wrangler secret put`):
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

Поток авторизации:
1. Партнёр открывает `partner-dashboard.html` → кнопка «Войти через Google»
2. Редирект на Worker `/auth/google` → Worker редиректит на Google OAuth
3. Google возвращает `?code=...` на `/auth/callback`
4. Worker меняет code на access_token, получает email партнёра
5. Worker проверяет KV: `partner_access:{email}` → `{ companies: [id1, id2], name: "ФИО" }`
6. Если есть доступ: создаёт сессию в KV (`session:{random_token}` → данные, TTL 24h)
7. Ставит cookie `ks_partner_session={token}`, редиректит в дашборд

Redirect URI для Google Console: `https://kashalot-proxy.vegano-argentino-ru.workers.dev/auth/callback`

### Хранение доступов в KV (IGN_CACHE — уже есть)

```
KV key: partner_access:{email}
Value:  { "companies": [123, 456], "name": "Баранова И.П." }

KV key: session:{random_token}
Value:  { "email": "...", "companies": [123, 456], "name": "..." }
TTL:    86400 (24 часа)
```

### Новые Worker эндпоинты

```
GET  /auth/google          — редирект на Google OAuth
GET  /auth/callback        — обработка code, создание сессии
POST /partner/data         — данные (принимает cookie, возвращает JSON)
POST /admin/partner-access — управление доступами (X-Token, только Антон)
GET  /admin/partner-list   — список партнёров (X-Token)
```

### Управление доступами (в dashboard.html Антона)

Новый раздел в основном дашборде: список партнёров + редактирование.
Защищён существующим `GRAFANA_TOKEN = '8c76e677dcdedad18ee2a79eab8bfeff'`.

---

## Метрики партнёрского дашборда

Переключатель компаний: кнопки «Все» + по каждой компании партнёра.

Разделы (те же что в основном дашборде, с фильтром по company_id):

1. **KPI-карточки** — выручка, заказы, активных КШ, доля активных, выр/КШ
2. **График выручки по дням** — с периодами 7/30/90/365/всё
3. **Эффективность устройств** — таблица с устройствами, статусами, выручкой

---

## Ключевое требование: устройства с нулевой выручкой

Устройство без аренд за период — **главная проблема** (простой техники).
Оно ДОЛЖНО показываться в таблице, не выпадать.

### Правильный SQL (LEFT JOIN от cars, не от orders)

```sql
SELECT
  c.id AS car_id,
  COALESCE(d.orders, 0) AS orders,
  COALESCE(d.revenue, 0) AS revenue,
  COALESCE(d.avg_check, 0) AS avg_check
FROM cars c
LEFT JOIN (
  SELECT o.car_id,
    COUNT(*) AS orders,
    ROUND(SUM(b.sum_card)/100) AS revenue,
    ROUND(AVG(b.sum_card)/100) AS avg_check
  FROM orders o
  JOIN bills b ON b.order_id = o.id
  WHERE b.status='PAID'
    AND o.company_id IN (${companyIds.join(',')})
    AND o.start_time >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
  GROUP BY o.car_id
) d ON d.car_id = c.id
WHERE c.company_id IN (${companyIds.join(',')})
ORDER BY revenue DESC, orders DESC
```

### Визуальные статусы
| revenue | orders | Статус | Цвет |
|---|---|---|---|
| 0 | 0 | Простой | серый `#6b7280` |
| 0 | > 0 | Отказы | оранжевый `#fbbf24` |
| > 0, < 40% медианы | — | Аутсайдер | красный `#f87171` |
| > 0, < 70% медианы | — | Ниже нормы | жёлтый `#fbbf24` |
| > 0, < 130% медианы | — | В норме | зелёный `#4ade80` |
| > 0, ≥ 130% медианы | — | Лидер | синий `#60a5fa` |

Медиана считается только по устройствам с revenue > 0 (нули не искажают).

**Эту же логику уже реализовали в основном `dashboard.html`** (секция «Эффективность устройств», функция `loadDevEffTable`). Смотри как референс.

---

## Дизайн — брать из основного дашборда

Цветовая палитра, шрифты, карточки, таблицы — копировать из `dashboard.html`.
Фон: `#0d0d14`, карточки: `#1a1a24`, border: `#2d2d3d`.
Chart.js v4 уже подключен.

Не устанавливать npm-пакеты без необходимости — дашборд работает на чистом HTML/JS.

---

## Первые шаги

1. Создать Google OAuth Client в Google Cloud Console (тип: Web application)
2. Добавить секреты в Worker: `wrangler secret put GOOGLE_CLIENT_ID` и `GOOGLE_CLIENT_SECRET`
3. Добавить эндпоинты `/auth/google` и `/auth/callback` в `worker.js`, задеплоить
4. Создать `partner-dashboard.html` с экраном входа
5. Добавить раздел управления партнёрами в `dashboard.html`
