"""Бизнес-логика, общая для REST-роутов и симулятора."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import analytics as an
from .models import Courier, CourierStatus, LocationPoint, Order, OrderStatus
from .schemas import (AnalyticsSummary, CourierOut, CourierStats, OrderOut,
                      ProblemZone, RouteAnalysis, Stop)
from .ws import hub

ACTIVE = (OrderStatus.created, OrderStatus.assigned, OrderStatus.picked_up)
ALLOWED = {
    OrderStatus.created: {OrderStatus.assigned, OrderStatus.cancelled},
    OrderStatus.assigned: {OrderStatus.picked_up, OrderStatus.cancelled, OrderStatus.created},
    OrderStatus.picked_up: {OrderStatus.delivered, OrderStatus.cancelled},
    OrderStatus.delivered: set(),
    OrderStatus.cancelled: set(),
}


def now() -> datetime:
    return datetime.now(timezone.utc)


def straight_km(o: Order) -> float:
    return an.haversine_m(o.pickup_lat, o.pickup_lng, o.dropoff_lat, o.dropoff_lng) / 1000


# ---------- ETA-модель (переобучается лениво) ----------

_model_cache: dict = {"n": -1, "model": an.EtaModel()}


def eta_model(db: Session) -> an.EtaModel:
    delivered = db.scalars(
        select(Order).where(Order.status == OrderStatus.delivered, Order.assigned_at.is_not(None))
    ).all()
    if len(delivered) != _model_cache["n"]:
        X, y = [], []
        for o in delivered:
            X.append(an.features(straight_km(o), o.created_at))
            y.append((an.aware(o.delivered_at) - an.aware(o.assigned_at)).total_seconds() / 60)
        _model_cache["model"] = an.EtaModel().fit(X, y)
        _model_cache["n"] = len(delivered)
    return _model_cache["model"]


def order_out(db: Session, o: Order) -> OrderOut:
    out = OrderOut.model_validate(o)
    if o.status in ACTIVE:
        out.eta_minutes = round(eta_model(db).predict(an.features(straight_km(o), o.created_at)), 1)
    return out


# ---------- заказы ----------

def get_order(db: Session, order_id: int) -> Order:
    o = db.get(Order, order_id)
    if not o:
        raise HTTPException(404, "Заказ не найден")
    return o


async def assign(db: Session, order_id: int, courier_id: int) -> Order:
    o = get_order(db, order_id)
    c = db.get(Courier, courier_id)
    if not c:
        raise HTTPException(404, "Курьер не найден")
    if o.status not in (OrderStatus.created, OrderStatus.assigned):
        raise HTTPException(409, f"Нельзя назначить заказ в статусе {o.status.value}")
    if c.status == CourierStatus.offline:
        raise HTTPException(409, "Курьер не в сети")
    o.courier_id, o.status, o.assigned_at = c.id, OrderStatus.assigned, now()
    c.status = CourierStatus.busy
    db.commit()
    await hub.broadcast("order_updated", order_out(db, o))
    await hub.broadcast("courier_updated", CourierOut.model_validate(c))
    return o


async def set_status(db: Session, order_id: int, status: OrderStatus) -> Order:
    o = get_order(db, order_id)
    if status not in ALLOWED[o.status]:
        raise HTTPException(409, f"Переход {o.status.value} → {status.value} запрещён")
    o.status = status
    if status == OrderStatus.picked_up:
        o.picked_up_at = now()
    elif status == OrderStatus.delivered:
        o.delivered_at = now()
    elif status == OrderStatus.created:  # снятие с курьера
        o.courier_id, o.assigned_at = None, None
    c = o.courier
    if status in (OrderStatus.delivered, OrderStatus.cancelled) and c:
        still_busy = db.scalar(
            select(Order.id).where(Order.courier_id == c.id, Order.status.in_(ACTIVE), Order.id != o.id)
        )
        if not still_busy and c.status == CourierStatus.busy:
            c.status = CourierStatus.idle
    db.commit()
    await hub.broadcast("order_updated", order_out(db, o))
    if c:
        await hub.broadcast("courier_updated", CourierOut.model_validate(c))
    return o


def suggest_couriers(db: Session, order_id: int, limit: int = 3) -> list[dict]:
    """Ближайшие свободные курьеры к точке забора."""
    o = get_order(db, order_id)
    cs = db.scalars(select(Courier).where(Courier.status == CourierStatus.idle, Courier.lat.is_not(None))).all()
    ranked = sorted(
        ({"courier": CourierOut.model_validate(c),
          "distance_km": round(an.haversine_m(c.lat, c.lng, o.pickup_lat, o.pickup_lng) / 1000, 2)}
         for c in cs),
        key=lambda r: r["distance_km"],
    )
    return ranked[:limit]


# ---------- геолокация ----------

async def record_location(db: Session, courier_id: int, lat: float, lng: float,
                          speed: float | None = None, order_id: int | None = None,
                          ts: datetime | None = None) -> Courier:
    c = db.get(Courier, courier_id)
    if not c:
        raise HTTPException(404, "Курьер не найден")
    ts = ts or now()
    if order_id is None:  # привязываем к активному заказу автоматически
        order_id = db.scalar(
            select(Order.id).where(Order.courier_id == c.id,
                                   Order.status.in_((OrderStatus.assigned, OrderStatus.picked_up)))
        )
    db.add(LocationPoint(courier_id=c.id, order_id=order_id, lat=lat, lng=lng, speed=speed, ts=ts))
    c.lat, c.lng, c.speed, c.last_seen = lat, lng, speed, ts
    if c.status == CourierStatus.offline:
        c.status = CourierStatus.idle
    db.commit()
    await hub.broadcast("courier_location", {"id": c.id, "lat": lat, "lng": lng, "speed": speed,
                                             "status": c.status.value, "ts": ts})
    return c


# ---------- анализ ----------

def _track(db: Session, order_id: int) -> list[an.P]:
    rows = db.scalars(
        select(LocationPoint).where(LocationPoint.order_id == order_id).order_by(LocationPoint.ts)
    ).all()
    return [an.P(r.lat, r.lng, r.ts) for r in rows]


def analyze_order(db: Session, o: Order, model: an.EtaModel | None = None) -> RouteAnalysis:
    pts = _track(db, o.id)
    dist = an.path_length_m(pts) / 1000
    sl = straight_km(o)
    stops = an.detect_stops(pts)
    duration = None
    if o.delivered_at and o.assigned_at:
        duration = (an.aware(o.delivered_at) - an.aware(o.assigned_at)).total_seconds() / 60
    z = None
    if duration is not None:
        z = (model or eta_model(db)).zscore(an.features(sl, o.created_at), duration)
    moving_min = (duration or 0) - sum(s["duration_sec"] for s in stops) / 60
    return RouteAnalysis(
        order_id=o.id,
        points=len(pts),
        distance_km=round(dist, 2),
        straight_line_km=round(sl, 2),
        detour_ratio=round(dist / sl, 2) if sl > 0.05 and dist else 1.0,
        duration_min=round(duration, 1) if duration is not None else None,
        avg_speed_kmh=round(dist / (moving_min / 60), 1) if moving_min > 0.5 and dist else None,
        stops=[Stop(**s) for s in stops],
        total_stop_min=round(sum(s["duration_sec"] for s in stops) / 60, 1),
        anomaly_score=round(z, 2) if z is not None else None,
        is_anomaly=bool(z is not None and z > an.ANOMALY_Z),
    )


def summary(db: Session) -> AnalyticsSummary:
    model = eta_model(db)
    orders = db.scalars(select(Order)).all()
    delivered = [o for o in orders if o.status == OrderStatus.delivered]
    analyses = [analyze_order(db, o, model) for o in delivered]

    all_stops = [s.model_dump() for a in analyses for s in a.stops]
    by_hour = [0] * 24
    for o in delivered:
        by_hour[(an.aware(o.delivered_at).hour + 5) % 24] += 1

    per_courier: dict[int, list[RouteAnalysis]] = {}
    for o, a in zip(delivered, analyses):
        per_courier.setdefault(o.courier_id, []).append(a)
    couriers = []
    for c in db.scalars(select(Courier)).all():
        aa = per_courier.get(c.id, [])
        durs = [a.duration_min for a in aa if a.duration_min is not None]
        spds = [a.avg_speed_kmh for a in aa if a.avg_speed_kmh]
        couriers.append(CourierStats(
            courier_id=c.id, name=c.name, delivered=len(aa),
            avg_delivery_min=round(sum(durs) / len(durs), 1) if durs else None,
            avg_speed_kmh=round(sum(spds) / len(spds), 1) if spds else None,
        ))
    couriers.sort(key=lambda s: s.delivered, reverse=True)

    durs = [a.duration_min for a in analyses if a.duration_min is not None]
    dets = [a.detour_ratio for a in analyses if a.distance_km > 0]
    return AnalyticsSummary(
        orders_total=len(orders),
        orders_active=sum(o.status in ACTIVE for o in orders),
        delivered=len(delivered),
        avg_delivery_min=round(sum(durs) / len(durs), 1) if durs else None,
        avg_detour_ratio=round(sum(dets) / len(dets), 2) if dets else None,
        anomalies=sum(a.is_anomaly for a in analyses),
        eta_model=model.describe(),
        problem_zones=[ProblemZone(**z) for z in an.problem_zones(all_stops)],
        couriers=couriers,
        deliveries_by_hour=by_hour,
    )
