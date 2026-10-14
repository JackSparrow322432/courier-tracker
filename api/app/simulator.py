"""Демо-режим: курьеры по Алматы, история доставок и живое движение.

Нужен, чтобы диспетчерская и аналитика работали без запущенного Flutter-приложения.
Симулятор управляет только курьерами с simulated=True; реальные курьеры
(созданные через API и шлющие координаты из приложения) им не трогаются.
Отключается переменной окружения SIMULATE=0.
"""

from __future__ import annotations

import asyncio
import math
import random
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from . import services as svc
from .analytics import haversine_m
from .db import SessionLocal
from .models import Courier, CourierStatus, LocationPoint, Order, OrderStatus

rnd = random.Random(42)

# Точки Алматы для адресов
PLACES = [
    ("ТРЦ Mega Alma-Ata, Розыбакиева 247а", 43.2027, 76.8925),
    ("Dostyk Plaza, Самал-2 111", 43.2330, 76.9566),
    ("Esentai Mall, Аль-Фараби 77/8", 43.2185, 76.9280),
    ("Зелёный базар, Жибек Жолы 53", 43.2627, 76.9536),
    ("Арбат, Жибек Жолы / Панфилова", 43.2611, 76.9440),
    ("Парк 28 панфиловцев", 43.2587, 76.9563),
    ("AlmaU, Розыбакиева 227", 43.2087, 76.8898),
    ("КБТУ, Толе би 59", 43.2555, 76.9441),
    ("Аэропорт Алматы, Майлина 2", 43.3521, 77.0405),
    ("Медеу", 43.1573, 77.0590),
    ("ТРЦ Forum, Сейфуллина 617", 43.2342, 76.9356),
    ("Абая / Байтурсынова", 43.2402, 76.9258),
    ("Сайран, Толе би 300", 43.2420, 76.8636),
    ("Алатауский район, мкр Шанырак", 43.2900, 76.8400),
    ("Ауэзовский район, мкр Аксай-4", 43.2245, 76.8432),
    ("Бостандыкский район, Жандосова 58", 43.2245, 76.8930),
    ("Кок-Тобе", 43.2307, 76.9765),
    ("Ботанический сад, Тимирязева 36", 43.2235, 76.9150),
]
# Места, где курьеры «залипают» — из них вырастут проблемные зоны
JAMS = [(43.2389, 76.9455), (43.2540, 76.9300), (43.2150, 76.8870)]
NAMES = ["Ерлан Сапаров", "Айгерим Нурланова", "Тимур Ахметов",
         "Дана Жумабаева", "Арман Кенжебеков", "Мадина Оспанова"]
CUSTOMERS = ["Асель", "Нурсултан", "Камила", "Даурен", "Алия", "Бекзат", "Жанель", "Руслан"]

TICK_SEC = 2.0
SPEED_MPS = 9.0  # ~32 км/ч для живой демки (ускорено, чтобы было видно движение)


def _rand_place():
    name, lat, lng = rnd.choice(PLACES)
    return name, lat + rnd.uniform(-0.002, 0.002), lng + rnd.uniform(-0.002, 0.002)


def _new_order(created_at: datetime | None = None) -> Order:
    (pa, plat, plng), (da, dlat, dlng) = _rand_place(), _rand_place()
    while haversine_m(plat, plng, dlat, dlng) < 1500:
        da, dlat, dlng = _rand_place()
    return Order(
        customer_name=rnd.choice(CUSTOMERS),
        customer_phone=f"+7 70{rnd.randint(0, 9)} {rnd.randint(100, 999)} {rnd.randint(10, 99)} {rnd.randint(10, 99)}",
        pickup_address=pa, pickup_lat=plat, pickup_lng=plng,
        dropoff_address=da, dropoff_lat=dlat, dropoff_lng=dlng,
        created_at=created_at or datetime.now(timezone.utc),
    )


def _synthetic_track(o: Order, start: datetime, peak: bool, slow: bool):
    """Трек забор → доставка через промежуточную точку; иногда она — перекрёсток-пробка."""
    jam = rnd.random() < (0.6 if peak else 0.3)
    if jam:
        mid_lat, mid_lng = rnd.choice(JAMS)
    else:
        mid_lat = (o.pickup_lat + o.dropoff_lat) / 2 + rnd.uniform(-0.008, 0.008)
        mid_lng = (o.pickup_lng + o.dropoff_lng) / 2 + rnd.uniform(-0.008, 0.008)
    speed = rnd.uniform(5.0, 7.0) * (0.7 if peak else 1.0) * (0.45 if slow else 1.0)
    pts, t = [], start

    def leg(a_lat, a_lng, b_lat, b_lng):
        nonlocal t
        d = haversine_m(a_lat, a_lng, b_lat, b_lng)
        steps = max(2, int(d / (speed * 20)))
        for i in range(steps):
            f = i / steps
            pts.append((a_lat + (b_lat - a_lat) * f + rnd.gauss(0, 0.00003),
                        a_lng + (b_lng - a_lng) * f + rnd.gauss(0, 0.00003), speed, t))
            t += timedelta(seconds=20)

    leg(o.pickup_lat, o.pickup_lng, mid_lat, mid_lng)
    if jam:  # стоим в пробке
        for _ in range(rnd.randint(4, 14 if slow else 8)):
            pts.append((mid_lat + rnd.gauss(0, 0.00006), mid_lng + rnd.gauss(0, 0.00006), 0.3, t))
            t += timedelta(seconds=20)
    leg(mid_lat, mid_lng, o.dropoff_lat, o.dropoff_lng)
    pts.append((o.dropoff_lat, o.dropoff_lng, 0.0, t))
    return pts, t


def seed() -> None:
    with SessionLocal() as db:
        if db.scalar(select(func.count(Courier.id))):
            return
        couriers = []
        for name in NAMES:
            _, lat, lng = _rand_place()
            c = Courier(name=name, phone=f"+7 777 {rnd.randint(100, 999)} {rnd.randint(1000, 9999)}",
                        status=CourierStatus.idle, lat=lat, lng=lng, simulated=True,
                        last_seen=datetime.now(timezone.utc))
            db.add(c)
            couriers.append(c)
        db.flush()

        # ~60 доставок за последние 3 дня — материал для ETA-модели и аналитики
        base = datetime.now(timezone.utc) - timedelta(days=3)
        for k in range(60):
            created = base + timedelta(minutes=k * 70 + rnd.randint(0, 40))
            local_hour = (created.hour + 5) % 24
            peak = local_hour in {8, 9, 12, 13, 18, 19}
            o = _new_order(created)
            c = rnd.choice(couriers)
            o.courier_id, o.status = c.id, OrderStatus.delivered
            o.assigned_at = created + timedelta(minutes=rnd.uniform(1, 4))
            o.picked_up_at = o.assigned_at + timedelta(minutes=rnd.uniform(4, 10))
            db.add(o)
            db.flush()
            pts, end = _synthetic_track(o, o.picked_up_at, peak, slow=rnd.random() < 0.07)
            o.delivered_at = end
            db.add_all(LocationPoint(courier_id=c.id, order_id=o.id, lat=a, lng=b, speed=s, ts=t)
                       for a, b, s, t in pts)

        for _ in range(3):  # пара заказов ждёт диспетчера
            db.add(_new_order())
        db.commit()


def _step_towards(c: Courier, lat: float, lng: float) -> bool:
    """Сдвигает курьера к цели. True — если дошёл."""
    d = haversine_m(c.lat, c.lng, lat, lng)
    step = SPEED_MPS * TICK_SEC * rnd.uniform(0.6, 1.3)
    if d <= step:
        c.lat, c.lng = lat, lng
        return True
    f = step / d
    c.lat += (lat - c.lat) * f + rnd.gauss(0, 0.00002)
    c.lng += (lng - c.lng) * f + rnd.gauss(0, 0.00002)
    return False


async def run_simulator() -> None:
    tick = 0
    while True:
        await asyncio.sleep(TICK_SEC)
        tick += 1
        try:
            await _tick(tick)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # демо не должна падать целиком
            print("simulator error:", e)


async def _tick(tick: int) -> None:
    with SessionLocal() as db:
        now = datetime.now(timezone.utc)

        # новый заказ примерно раз в 30 секунд
        if tick % 15 == 0:
            o = _new_order()
            db.add(o)
            db.commit()
            await svc.hub.broadcast("order_updated", svc.order_out(db, o))

        # заказ висит без курьера > 60 с — назначаем ближайшего (имитация диспетчера)
        stale = db.scalars(select(Order).where(Order.status == OrderStatus.created)).all()
        for o in stale:
            if (now - svc.an.aware(o.created_at)).total_seconds() > 60:
                cand = [s for s in svc.suggest_couriers(db, o.id, 6)
                        if db.get(Courier, s["courier"].id).simulated]
                if cand:
                    await svc.assign(db, o.id, cand[0]["courier"].id)

        for c in db.scalars(select(Courier).where(Courier.simulated.is_(True))).all():
            o = db.scalar(select(Order).where(
                Order.courier_id == c.id,
                Order.status.in_((OrderStatus.assigned, OrderStatus.picked_up))).order_by(Order.id))
            if o is None:
                if rnd.random() < 0.3:  # свободный курьер немного «гуляет»
                    c.lat += rnd.gauss(0, 0.0002)
                    c.lng += rnd.gauss(0, 0.0002)
                    await svc.record_location(db, c.id, c.lat, c.lng, 1.0)
                continue
            if o.status == OrderStatus.assigned:
                if _step_towards(c, o.pickup_lat, o.pickup_lng):
                    await svc.set_status(db, o.id, OrderStatus.picked_up)
            else:
                if _step_towards(c, o.dropoff_lat, o.dropoff_lng):
                    await svc.record_location(db, c.id, c.lat, c.lng, 0.0, o.id)
                    await svc.set_status(db, o.id, OrderStatus.delivered)
                    continue
            await svc.record_location(db, c.id, c.lat, c.lng, SPEED_MPS, o.id)
