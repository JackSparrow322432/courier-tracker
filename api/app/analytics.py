"""Анализ маршрутов курьеров.

Что здесь есть:
- детекция остановок по GPS-треку (кластер точек в радиусе R дольше T секунд);
- коэффициент «петляния» (фактический путь / расстояние по прямой);
- ETA-модель: линейная регрессия времени доставки по признакам
  [расстояние по прямой, час пик], обучается на уже доставленных заказах;
- аномалии: z-score остатка модели (доставка заметно дольше прогноза);
- проблемные зоны: сетка ~300 м, где курьеры чаще всего стоят.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone

import numpy as np

EARTH_R = 6_371_000.0
STOP_RADIUS_M = 40.0
STOP_MIN_SEC = 60.0
ANOMALY_Z = 2.0
PEAK_HOURS = {8, 9, 12, 13, 18, 19}


def aware(dt: datetime | None) -> datetime | None:
    """SQLite теряет таймзону — считаем такие даты UTC."""
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


@dataclass
class P:
    lat: float
    lng: float
    ts: datetime


def path_length_m(points: list[P]) -> float:
    return sum(
        haversine_m(a.lat, a.lng, b.lat, b.lng) for a, b in zip(points, points[1:])
    )


def detect_stops(points: list[P]) -> list[dict]:
    stops: list[dict] = []
    i, n = 0, len(points)
    while i < n:
        j = i + 1
        while j < n and haversine_m(points[i].lat, points[i].lng, points[j].lat, points[j].lng) <= STOP_RADIUS_M:
            j += 1
        dur = (aware(points[j - 1].ts) - aware(points[i].ts)).total_seconds()
        if dur >= STOP_MIN_SEC:
            seg = points[i:j]
            stops.append(
                {
                    "lat": sum(p.lat for p in seg) / len(seg),
                    "lng": sum(p.lng for p in seg) / len(seg),
                    "duration_sec": dur,
                    "started_at": aware(points[i].ts),
                }
            )
            i = j
        else:
            i += 1
    return stops


def features(straight_km: float, created_at: datetime) -> list[float]:
    hour = aware(created_at).astimezone(timezone.utc).hour + 5  # Алматы UTC+5
    return [1.0, straight_km, 1.0 if (hour % 24) in PEAK_HOURS else 0.0]


class EtaModel:
    """Линейная регрессия минут доставки. Падает обратно на эвристику, пока данных мало."""

    def __init__(self) -> None:
        self.coef: np.ndarray | None = None
        self.resid_std: float | None = None
        self.n = 0

    def fit(self, X: list[list[float]], y: list[float]) -> "EtaModel":
        self.n = len(y)
        if self.n < 5:
            return self
        Xa, ya = np.array(X), np.array(y)
        coef, *_ = np.linalg.lstsq(Xa, ya, rcond=None)
        resid = ya - Xa @ coef
        self.coef = coef
        self.resid_std = float(np.std(resid)) or 1.0
        return self

    def predict(self, x: list[float]) -> float:
        if self.coef is None:
            # эвристика: 5 мин на сборы + 18 км/ч, +30% в час пик
            base = 5 + x[1] / 18 * 60
            return base * (1.3 if x[2] else 1.0)
        return max(1.0, float(np.dot(self.coef, x)))

    def zscore(self, x: list[float], actual_min: float) -> float | None:
        if self.coef is None or not self.resid_std:
            return None
        return (actual_min - self.predict(x)) / self.resid_std

    def describe(self) -> dict:
        if self.coef is None:
            return {"type": "heuristic", "trained_on": self.n,
                    "note": "нужно ≥5 доставленных заказов для обучения"}
        b0, b_km, b_peak = (round(float(c), 2) for c in self.coef)
        return {"type": "linear_regression", "trained_on": self.n,
                "intercept_min": b0, "min_per_km": b_km, "peak_extra_min": b_peak,
                "resid_std_min": round(self.resid_std or 0, 2)}


def problem_zones(all_stops: list[dict], top: int = 8, radius_m: float = 250.0) -> list[dict]:
    """Жадная кластеризация остановок: точка присоединяется к ближайшему кластеру в радиусе."""
    clusters: list[dict] = []
    for s in sorted(all_stops, key=lambda s: -s["duration_sec"]):
        best = None
        for c in clusters:
            d = haversine_m(c["lat"], c["lng"], s["lat"], s["lng"])
            if d <= radius_m and (best is None or d < best[0]):
                best = (d, c)
        if best:
            c = best[1]
            n = c["stops"]
            c["lat"] = (c["lat"] * n + s["lat"]) / (n + 1)
            c["lng"] = (c["lng"] * n + s["lng"]) / (n + 1)
            c["stops"] += 1
            c["sec"] += s["duration_sec"]
        else:
            clusters.append({"lat": s["lat"], "lng": s["lng"], "stops": 1, "sec": s["duration_sec"]})
    zones = [{"lat": c["lat"], "lng": c["lng"], "stops": c["stops"],
              "total_stop_min": round(c["sec"] / 60, 1)} for c in clusters]
    zones.sort(key=lambda z: z["total_stop_min"], reverse=True)
    return zones[:top]
