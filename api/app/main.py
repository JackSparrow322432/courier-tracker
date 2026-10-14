import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import services as svc
from .db import Base, engine, get_db
from .models import Courier, CourierStatus, LocationPoint, Order, OrderStatus
from .schemas import (AnalyticsSummary, AssignIn, CourierCreate, CourierOut,
                      LocationIn, OrderCreate, OrderOut, RouteAnalysis,
                      StatusIn, TrackPoint)
from .ws import hub

SIMULATE = os.getenv("SIMULATE", "1") == "1"


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(engine)
    task = None
    if SIMULATE:
        from .simulator import run_simulator, seed
        seed()
        task = asyncio.create_task(run_simulator())
    yield
    if task:
        task.cancel()


app = FastAPI(title="Courier Tracker API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"ok": True, "simulator": SIMULATE}


# ---------------- курьеры ----------------

@app.get("/api/couriers", response_model=list[CourierOut], tags=["couriers"])
def list_couriers(db: Session = Depends(get_db)):
    return db.scalars(select(Courier).order_by(Courier.id)).all()


@app.post("/api/couriers", response_model=CourierOut, status_code=201, tags=["couriers"])
def create_courier(body: CourierCreate, db: Session = Depends(get_db)):
    c = Courier(name=body.name, phone=body.phone)
    db.add(c)
    db.commit()
    return c


@app.get("/api/couriers/{courier_id}", response_model=CourierOut, tags=["couriers"])
def get_courier(courier_id: int, db: Session = Depends(get_db)):
    c = db.get(Courier, courier_id)
    if not c:
        raise HTTPException(404, "Курьер не найден")
    return c


@app.post("/api/couriers/{courier_id}/location", response_model=CourierOut, tags=["mobile"],
          summary="Flutter: отправить текущую геопозицию курьера")
async def post_location(courier_id: int, body: LocationIn, db: Session = Depends(get_db)):
    return await svc.record_location(db, courier_id, body.lat, body.lng, body.speed, body.order_id, body.ts)


@app.post("/api/couriers/{courier_id}/online", response_model=CourierOut, tags=["mobile"],
          summary="Flutter: курьер вышел на линию / ушёл с линии")
async def set_online(courier_id: int, online: bool = Query(True), db: Session = Depends(get_db)):
    c = db.get(Courier, courier_id)
    if not c:
        raise HTTPException(404, "Курьер не найден")
    if not online:
        c.status = CourierStatus.offline
    elif c.status == CourierStatus.offline:
        c.status = CourierStatus.idle
    db.commit()
    out = CourierOut.model_validate(c)
    await hub.broadcast("courier_updated", out)
    return out


@app.get("/api/couriers/{courier_id}/orders", response_model=list[OrderOut], tags=["mobile"],
         summary="Flutter: активные заказы курьера")
def courier_orders(courier_id: int, db: Session = Depends(get_db)):
    rows = db.scalars(
        select(Order).where(Order.courier_id == courier_id, Order.status.in_(svc.ACTIVE)).order_by(Order.id)
    ).all()
    return [svc.order_out(db, o) for o in rows]


# ---------------- заказы ----------------

@app.get("/api/orders", response_model=list[OrderOut], tags=["orders"])
def list_orders(status: list[OrderStatus] | None = Query(None), limit: int = 200,
                db: Session = Depends(get_db)):
    q = select(Order).order_by(Order.id.desc()).limit(limit)
    if status:
        q = q.where(Order.status.in_(status))
    return [svc.order_out(db, o) for o in db.scalars(q).all()]


@app.post("/api/orders", response_model=OrderOut, status_code=201, tags=["orders"])
async def create_order(body: OrderCreate, db: Session = Depends(get_db)):
    o = Order(**body.model_dump())
    db.add(o)
    db.commit()
    out = svc.order_out(db, o)
    await hub.broadcast("order_updated", out)
    return out


@app.get("/api/orders/{order_id}", response_model=OrderOut, tags=["orders"])
def get_order(order_id: int, db: Session = Depends(get_db)):
    return svc.order_out(db, svc.get_order(db, order_id))


@app.post("/api/orders/{order_id}/assign", response_model=OrderOut, tags=["orders"])
async def assign_order(order_id: int, body: AssignIn, db: Session = Depends(get_db)):
    return svc.order_out(db, await svc.assign(db, order_id, body.courier_id))


@app.patch("/api/orders/{order_id}/status", response_model=OrderOut, tags=["orders", "mobile"],
           summary="Смена статуса (Flutter: picked_up / delivered)")
async def change_status(order_id: int, body: StatusIn, db: Session = Depends(get_db)):
    return svc.order_out(db, await svc.set_status(db, order_id, body.status))


@app.get("/api/orders/{order_id}/suggest", tags=["orders"],
         summary="Ближайшие свободные курьеры к точке забора")
def suggest(order_id: int, db: Session = Depends(get_db)):
    return svc.suggest_couriers(db, order_id)


@app.get("/api/orders/{order_id}/track", response_model=list[TrackPoint], tags=["analytics"])
def order_track(order_id: int, db: Session = Depends(get_db)):
    return db.scalars(
        select(LocationPoint).where(LocationPoint.order_id == order_id).order_by(LocationPoint.ts)
    ).all()


@app.get("/api/orders/{order_id}/analysis", response_model=RouteAnalysis, tags=["analytics"])
def order_analysis(order_id: int, db: Session = Depends(get_db)):
    return svc.analyze_order(db, svc.get_order(db, order_id))


@app.get("/api/analytics/summary", response_model=AnalyticsSummary, tags=["analytics"])
def analytics_summary(db: Session = Depends(get_db)):
    return svc.summary(db)


# ---------------- realtime ----------------

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    """События: courier_location, courier_updated, order_updated."""
    await hub.connect(ws)
    try:
        while True:
            await ws.receive_text()  # пинги от клиента; входящие команды не нужны
    except WebSocketDisconnect:
        hub.disconnect(ws)
