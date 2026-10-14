from datetime import datetime, timezone
from typing import Annotated

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

from .models import CourierStatus, OrderStatus


def _aware(v):
    # SQLite не хранит таймзону: всё в БД — UTC
    if isinstance(v, datetime) and v.tzinfo is None:
        return v.replace(tzinfo=timezone.utc)
    return v


UTCDateTime = Annotated[datetime, BeforeValidator(_aware)]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class CourierCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    phone: str = ""


class CourierOut(ORM):
    id: int
    name: str
    phone: str
    status: CourierStatus
    lat: float | None
    lng: float | None
    speed: float | None
    last_seen: UTCDateTime | None


class OrderCreate(BaseModel):
    customer_name: str = Field(min_length=1)
    customer_phone: str = ""
    pickup_address: str
    pickup_lat: float
    pickup_lng: float
    dropoff_address: str
    dropoff_lat: float
    dropoff_lng: float


class OrderOut(ORM):
    id: int
    customer_name: str
    customer_phone: str
    pickup_address: str
    pickup_lat: float
    pickup_lng: float
    dropoff_address: str
    dropoff_lat: float
    dropoff_lng: float
    status: OrderStatus
    courier_id: int | None
    created_at: UTCDateTime
    assigned_at: UTCDateTime | None
    picked_up_at: UTCDateTime | None
    delivered_at: UTCDateTime | None
    eta_minutes: float | None = None


class AssignIn(BaseModel):
    courier_id: int


class StatusIn(BaseModel):
    status: OrderStatus


class LocationIn(BaseModel):
    """То, что шлёт Flutter-приложение курьера каждые N секунд."""

    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    speed: float | None = Field(default=None, ge=0, description="м/с")
    order_id: int | None = None
    ts: datetime | None = None


class TrackPoint(ORM):
    lat: float
    lng: float
    speed: float | None
    ts: UTCDateTime


class Stop(BaseModel):
    lat: float
    lng: float
    duration_sec: float
    started_at: UTCDateTime


class RouteAnalysis(BaseModel):
    order_id: int
    points: int
    distance_km: float
    straight_line_km: float
    detour_ratio: float           # фактический путь / по прямой
    duration_min: float | None
    avg_speed_kmh: float | None
    stops: list[Stop]
    total_stop_min: float
    anomaly_score: float | None   # z-score времени доставки относительно модели
    is_anomaly: bool


class ProblemZone(BaseModel):
    lat: float
    lng: float
    stops: int
    total_stop_min: float


class CourierStats(BaseModel):
    courier_id: int
    name: str
    delivered: int
    avg_delivery_min: float | None
    avg_speed_kmh: float | None


class AnalyticsSummary(BaseModel):
    orders_total: int
    orders_active: int
    delivered: int
    avg_delivery_min: float | None
    avg_detour_ratio: float | None
    anomalies: int
    eta_model: dict
    problem_zones: list[ProblemZone]
    couriers: list[CourierStats]
    deliveries_by_hour: list[int]
