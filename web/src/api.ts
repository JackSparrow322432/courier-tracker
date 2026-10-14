// Типы повторяют схемы FastAPI (api/app/schemas.py).
// Тот же контракт использует Flutter-приложение курьера.

export type CourierStatus = 'offline' | 'idle' | 'busy'
export type OrderStatus = 'created' | 'assigned' | 'picked_up' | 'delivered' | 'cancelled'

export interface Courier {
  id: number
  name: string
  phone: string
  status: CourierStatus
  lat: number | null
  lng: number | null
  speed: number | null
  last_seen: string | null
}

export interface Order {
  id: number
  customer_name: string
  customer_phone: string
  pickup_address: string
  pickup_lat: number
  pickup_lng: number
  dropoff_address: string
  dropoff_lat: number
  dropoff_lng: number
  status: OrderStatus
  courier_id: number | null
  created_at: string
  assigned_at: string | null
  picked_up_at: string | null
  delivered_at: string | null
  eta_minutes: number | null
}

export type NewOrder = Omit<
  Order,
  'id' | 'status' | 'courier_id' | 'created_at' | 'assigned_at' | 'picked_up_at' | 'delivered_at' | 'eta_minutes'
>

export interface TrackPoint {
  lat: number
  lng: number
  speed: number | null
  ts: string
}

export interface Stop {
  lat: number
  lng: number
  duration_sec: number
  started_at: string
}

export interface RouteAnalysis {
  order_id: number
  points: number
  distance_km: number
  straight_line_km: number
  detour_ratio: number
  duration_min: number | null
  avg_speed_kmh: number | null
  stops: Stop[]
  total_stop_min: number
  anomaly_score: number | null
  is_anomaly: boolean
}

export interface Suggestion {
  courier: Courier
  distance_km: number
}

export interface EtaModelInfo {
  type: 'heuristic' | 'linear_regression'
  trained_on: number
  intercept_min?: number
  min_per_km?: number
  peak_extra_min?: number
  resid_std_min?: number
  note?: string
}

export interface AnalyticsSummary {
  orders_total: number
  orders_active: number
  delivered: number
  avg_delivery_min: number | null
  avg_detour_ratio: number | null
  anomalies: number
  eta_model: EtaModelInfo
  problem_zones: { lat: number; lng: number; stops: number; total_stop_min: number }[]
  couriers: {
    courier_id: number
    name: string
    delivered: number
    avg_delivery_min: number | null
    avg_speed_kmh: number | null
  }[]
  deliveries_by_hour: number[]
}

const BASE = import.meta.env.VITE_API_URL ?? ''

export class ApiError extends Error {}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    let detail = `Ошибка ${res.status}`
    try {
      const body = await res.json()
      if (typeof body.detail === 'string') detail = body.detail
    } catch {
      /* тело не JSON */
    }
    throw new ApiError(detail)
  }
  return res.json() as Promise<T>
}

export const api = {
  couriers: () => req<Courier[]>('/api/couriers'),
  orders: () => req<Order[]>('/api/orders?limit=300'),
  createOrder: (body: NewOrder) => req<Order>('/api/orders', { method: 'POST', body: JSON.stringify(body) }),
  assign: (orderId: number, courierId: number) =>
    req<Order>(`/api/orders/${orderId}/assign`, { method: 'POST', body: JSON.stringify({ courier_id: courierId }) }),
  setStatus: (orderId: number, status: OrderStatus) =>
    req<Order>(`/api/orders/${orderId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  suggest: (orderId: number) => req<Suggestion[]>(`/api/orders/${orderId}/suggest`),
  track: (orderId: number) => req<TrackPoint[]>(`/api/orders/${orderId}/track`),
  analysis: (orderId: number) => req<RouteAnalysis>(`/api/orders/${orderId}/analysis`),
  summary: () => req<AnalyticsSummary>('/api/analytics/summary'),
}

export function wsUrl(): string {
  if (BASE) return BASE.replace(/^http/, 'ws') + '/ws'
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws`
}

// ---------- форматирование ----------

export const STATUS_LABEL: Record<OrderStatus, string> = {
  created: 'Ждёт курьера',
  assigned: 'Едет за заказом',
  picked_up: 'Везёт клиенту',
  delivered: 'Доставлен',
  cancelled: 'Отменён',
}

export const COURIER_LABEL: Record<CourierStatus, string> = {
  offline: 'Не в сети',
  idle: 'Свободен',
  busy: 'На заказе',
}

export const ACTIVE: OrderStatus[] = ['created', 'assigned', 'picked_up']

export function minutesSince(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
}

export function timeHM(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}
