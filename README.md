# Courier Tracker: диспетчерская + API

Веб-панель диспетчера (React + TypeScript) и бэкенд (FastAPI) для курсового Flutter-проекта Courier Tracker.
Flutter-приложение курьера шлёт координаты и меняет статусы заказов, диспетчер видит всё на карте
в реальном времени, а сервер анализирует маршруты по GPS-трекам.

```
courier-tracker/
├── api/        FastAPI, SQLAlchemy, WebSocket, анализ маршрутов, демо-симулятор
├── web/        Vite + React + TS, TanStack Query, Leaflet
├── mobile/     ← сюда кладётся твой Flutter-проект
└── docker-compose.yml   Postgres + API + веб (nginx)
```

## Запуск

Локально, без Docker (SQLite):

```bash
# терминал 1
cd api
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload            # http://localhost:8000/docs — Swagger

# терминал 2
cd web
npm install
npm run dev                               # http://localhost:5173
```

Через Docker (Postgres):

```bash
docker compose up --build                 # веб: http://localhost:8080, API: http://localhost:8000/docs
```

По умолчанию включён **демо-режим** (`SIMULATE=1`): 6 курьеров ездят по Алматы, раз в ~30 секунд
появляется заказ, а в базе уже есть 60 доставок за 3 дня, чтобы аналитике было на чём учиться.
Если заказ ждёт больше минуты, симулятор сам назначает ближайшего демо-курьера. Реальных курьеров,
созданных через API, симулятор не трогает. Выключить: `SIMULATE=0`.

## Что умеет диспетчерская

**Карта.** Слева очередь заказов: «Ждут курьера» (янтарная полоса, предупреждение после 5 минут ожидания),
«В пути», последние доставки. В центре карта: курьеры кружками с инициалами (зелёный — свободен,
синий — на заказе), точки A (забрать) и Б (доставить), пунктир «курьер → цель». Справа список курьеров
или карточка выбранного заказа.

**Карточка заказа.** Хронология статусов, три ближайших свободных курьера с расстоянием до точки A
(назначение в один клик), прогноз ETA, снятие с курьера и отмена. Для начатых и доставленных заказов
на карте рисуется фактический трек, остановки и «Разбор маршрута».

**Новый заказ.** Адреса вводятся в форму, а точки ставятся двумя кликами по карте.

**Аналитика маршрутов.** Доставки по часам, формула ETA-модели, карта проблемных зон, таблица по курьерам.

Всё обновляется через WebSocket без перезагрузки; при обрыве связи клиент переподключается сам.

## ML-часть: анализ маршрутов (`api/app/analytics.py`)

| Что | Как |
|---|---|
| Остановки | Точки трека, которые держатся в радиусе 40 м дольше 60 секунд |
| Крюк | Длина трека / расстояние по прямой (haversine) |
| ETA | Линейная регрессия `минуты = b₀ + b₁·км_по_прямой + b₂·час_пик` (numpy lstsq). Переобучается при каждой новой доставке; пока доставок меньше 5, работает эвристика |
| Аномалии | z-score остатка модели: доставка дольше прогноза больше чем на 2σ |
| Проблемные зоны | Жадная кластеризация всех остановок в радиусе 250 м, сортировка по потерянным минутам |

Куда расти: добавить в ETA признаки погоды, дня недели и загрузки курьера; заменить регрессию на
градиентный бустинг (scikit-learn / LightGBM); привязывать трек к дорогам через OSRM map-matching,
чтобы крюк считался относительно реального кратчайшего пути, а не прямой.

## Подключение Flutter-приложения

Полная схема в Swagger: `http://<host>:8000/docs` (эндпоинты курьера помечены тегом `mobile`).

| Действие курьера | Запрос |
|---|---|
| Зарегистрироваться | `POST /api/couriers` `{"name": "...", "phone": "..."}` |
| Выйти на линию / уйти | `POST /api/couriers/{id}/online?online=true` |
| Отправить геопозицию (каждые 5–10 с) | `POST /api/couriers/{id}/location` `{"lat", "lng", "speed"}` |
| Получить свои заказы | `GET /api/couriers/{id}/orders` |
| Забрал / доставил | `PATCH /api/orders/{id}/status` `{"status": "picked_up"}` или `"delivered"` |

Для клиентского режима (следить за курьером): `GET /api/orders/{id}` плюс WebSocket `/ws`,
событие `courier_location` с `id` курьера из заказа.

Отправка геопозиции (пакеты `geolocator` и `dio`):

```dart
final dio = Dio(BaseOptions(baseUrl: 'http://10.0.2.2:8000')); // 10.0.2.2 — localhost из Android-эмулятора

StreamSubscription<Position> startTracking(int courierId) {
  return Geolocator.getPositionStream(
    locationSettings: const LocationSettings(
      accuracy: LocationAccuracy.high,
      distanceFilter: 15, // метров между точками
    ),
  ).listen((p) {
    dio.post('/api/couriers/$courierId/location', data: {
      'lat': p.latitude,
      'lng': p.longitude,
      'speed': p.speed < 0 ? null : p.speed, // м/с
    });
  });
}

Future<void> markDelivered(int orderId) =>
    dio.patch('/api/orders/$orderId/status', data: {'status': 'delivered'});
```

Подписка на события (пакет `web_socket_channel`):

```dart
final ch = WebSocketChannel.connect(Uri.parse('ws://10.0.2.2:8000/ws'));
ch.stream.listen((raw) {
  final msg = jsonDecode(raw as String);
  switch (msg['event']) {
    case 'courier_location': // {id, lat, lng, speed, status, ts}
    case 'order_updated':    // полный объект заказа
    case 'courier_updated':  // полный объект курьера
  }
});
```

Сервер сам привязывает точки к активному заказу курьера, поэтому `order_id` в запросе геопозиции
передавать не обязательно. Переходы статусов проверяются на сервере (`created → assigned → picked_up → delivered`,
отмена из любого активного), недопустимый переход вернёт `409` с описанием.

## Чего пока нет

- Авторизации (для курса можно добавить JWT: роли `dispatcher`, `courier`, `client`).
- Миграций: таблицы создаются при старте; для продакшена подключить Alembic.
- Генерации Dart-моделей из OpenAPI: `openapi-generator-cli generate -i http://localhost:8000/openapi.json -g dart-dio -o mobile/api_client`.
