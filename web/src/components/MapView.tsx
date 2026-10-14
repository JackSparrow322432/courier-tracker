import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useMemo, useState } from 'react'
import { CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import { COURIER_LABEL, initials, type Courier, type Order, type RouteAnalysis, type TrackPoint } from '../api'

const ALMATY: [number, number] = [43.238, 76.912]

// Стандартная подложка OpenStreetMap: без ключа. Тёмная тема — CSS-фильтром.
export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
export const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'

export function useDark() {
  const q = '(prefers-color-scheme: dark)'
  const [dark, setDark] = useState(() => matchMedia(q).matches)
  useEffect(() => {
    const m = matchMedia(q)
    const on = () => setDark(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return dark
}

const courierIcon = (c: Courier, highlighted: boolean) =>
  L.divIcon({
    className: '',
    html: `<div class="cm cm--${c.status}${highlighted ? ' cm--hl' : ''}">${initials(c.name)}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  })

const pointIcon = (kind: 'pickup' | 'dropoff', label: string, dim: boolean) =>
  L.divIcon({
    className: '',
    html: `<div class="pm pm--${kind}${dim ? ' pm--dim' : ''}">${label}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  })

function ClickCatcher({ onClick }: { onClick?: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onClick?.(e.latlng.lat, e.latlng.lng) })
  return null
}

/** Leaflet не видит изменения размера контейнера в CSS-гриде — подсказываем ему. */
export function AutoResize() {
  const map = useMap()
  useEffect(() => {
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(map.getContainer())
    return () => ro.disconnect()
  }, [map])
  return null
}

function FitTo({ bounds }: { bounds: L.LatLngBoundsExpression | null }) {
  const map = useMap()
  useEffect(() => {
    if (bounds) map.flyToBounds(bounds, { padding: [60, 60], duration: 0.6, maxZoom: 15 })
  }, [bounds, map])
  return null
}

interface Props {
  couriers: Courier[]
  orders: Order[]
  selected: Order | null
  track?: TrackPoint[]
  analysis?: RouteAnalysis
  onSelectOrder: (id: number) => void
  picking?: boolean
  draftPoints?: { pickup?: [number, number]; dropoff?: [number, number] }
  onMapClick?: (lat: number, lng: number) => void
}

export function MapView({ couriers, orders, selected, track, analysis, onSelectOrder, picking, draftPoints, onMapClick }: Props) {
  const dark = useDark()
  const byId = useMemo(() => new Map(couriers.map((c) => [c.id, c])), [couriers])

  const bounds = useMemo<L.LatLngBoundsExpression | null>(() => {
    if (!selected) return null
    const pts: [number, number][] = [
      [selected.pickup_lat, selected.pickup_lng],
      [selected.dropoff_lat, selected.dropoff_lng],
    ]
    const c = selected.courier_id ? byId.get(selected.courier_id) : undefined
    if (c?.lat != null && c.lng != null && selected.status !== 'delivered') pts.push([c.lat, c.lng])
    return pts
    // перелетаем только при смене выбранного заказа, а не на каждое движение курьера
  }, [selected?.id])


  return (
    <MapContainer center={ALMATY} zoom={12} className={`map${picking ? ' map--picking' : ''}`} zoomControl={false}>
      <TileLayer url={TILE_URL} attribution={TILE_ATTR} className={dark ? 'tiles--dark' : ''} />
      <AutoResize />
      <ClickCatcher onClick={onMapClick} />
      <FitTo bounds={bounds} />

      {/* Линии «курьер → цель» для всех активных назначенных заказов */}
      {orders.map((o) => {
        const c = o.courier_id ? byId.get(o.courier_id) : undefined
        if (!c || c.lat == null || c.lng == null) return null
        if (o.status !== 'assigned' && o.status !== 'picked_up') return null
        const target: [number, number] =
          o.status === 'assigned' ? [o.pickup_lat, o.pickup_lng] : [o.dropoff_lat, o.dropoff_lng]
        return (
          <Polyline
            key={`line-${o.id}`}
            positions={[[c.lat, c.lng], target]}
            pathOptions={{
              className: `route route--${o.status}${selected?.id === o.id ? ' route--sel' : ''}`,
              weight: selected?.id === o.id ? 3 : 2,
            }}
          />
        )
      })}

      {/* Фактический трек выбранного заказа */}
      {track && track.length > 1 && (
        <Polyline
          positions={track.map((p) => [p.lat, p.lng] as [number, number])}
          pathOptions={{ className: analysis?.is_anomaly ? 'track track--bad' : 'track', weight: 4 }}
        />
      )}
      {analysis?.stops.map((s, i) => (
        <CircleMarker
          key={`stop-${i}`}
          center={[s.lat, s.lng]}
          radius={6 + Math.min(10, s.duration_sec / 60)}
          pathOptions={{ className: 'stop' }}
        >
          <Tooltip>Остановка {Math.round(s.duration_sec / 60)} мин</Tooltip>
        </CircleMarker>
      ))}

      {/* Точки забора/доставки активных заказов */}
      {orders.map((o) => {
        const dim = !!selected && selected.id !== o.id
        if (o.status === 'delivered' && selected?.id !== o.id) return null
        return [
          <Marker
            key={`p-${o.id}`}
            position={[o.pickup_lat, o.pickup_lng]}
            icon={pointIcon('pickup', 'A', dim)}
            eventHandlers={{ click: () => onSelectOrder(o.id) }}
          >
            <Tooltip direction="top" offset={[0, -10]}>
              №{o.id}, забрать: {o.pickup_address}
            </Tooltip>
          </Marker>,
          <Marker
            key={`d-${o.id}`}
            position={[o.dropoff_lat, o.dropoff_lng]}
            icon={pointIcon('dropoff', 'Б', dim)}
            eventHandlers={{ click: () => onSelectOrder(o.id) }}
          >
            <Tooltip direction="top" offset={[0, -10]}>
              №{o.id}, доставить: {o.dropoff_address}
            </Tooltip>
          </Marker>,
        ]
      })}

      {couriers.map((c) =>
        c.lat == null || c.lng == null || c.status === 'offline' ? null : (
          <Marker
            key={`c-${c.id}`}
            position={[c.lat, c.lng]}
            icon={courierIcon(c, selected?.courier_id === c.id)}
            zIndexOffset={1000}
          >
            <Tooltip direction="top" offset={[0, -16]}>
              {c.name}, {COURIER_LABEL[c.status].toLowerCase()}
            </Tooltip>
          </Marker>
        ),
      )}

      {draftPoints?.pickup && <Marker position={draftPoints.pickup} icon={pointIcon('pickup', 'A', false)} />}
      {draftPoints?.dropoff && <Marker position={draftPoints.dropoff} icon={pointIcon('dropoff', 'Б', false)} />}
    </MapContainer>
  )
}
