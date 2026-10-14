import { useQuery } from '@tanstack/react-query'
import 'leaflet/dist/leaflet.css'
import { useState } from 'react'
import { CircleMarker, MapContainer, TileLayer, Tooltip } from 'react-leaflet'
import { api, type AnalyticsSummary } from '../api'
import { AutoResize, TILE_ATTR, TILE_URL, useDark } from './MapView'

export function Analytics() {
  const { data, isLoading, error } = useQuery({ queryKey: ['summary'], queryFn: api.summary, refetchInterval: 30_000 })

  if (isLoading) return <div className="analytics"><p className="empty">Считаю статистику…</p></div>
  if (error || !data)
    return (
      <div className="analytics">
        <p className="error">Не удалось загрузить аналитику: {(error as Error)?.message}. Проверьте, что API запущен.</p>
      </div>
    )

  return (
    <div className="analytics">
      <section className="kpis" aria-label="Ключевые показатели">
        <Kpi value={data.delivered} label="доставлено" />
        <Kpi value={data.avg_delivery_min != null ? `${Math.round(data.avg_delivery_min)} мин` : '—'} label="в среднем от назначения до клиента" />
        <Kpi value={data.avg_detour_ratio != null ? `×${data.avg_detour_ratio}` : '—'} label="крюк: путь по треку против прямой" />
        <Kpi value={data.anomalies} label="аномально долгих доставок" tone={data.anomalies ? 'bad' : undefined} />
      </section>

      <div className="agrid">
        <section className="block">
          <h2>Доставки по часам</h2>
          <p className="muted">Время Алматы, все доставленные заказы</p>
          <HourChart values={data.deliveries_by_hour} />
        </section>

        <section className="block">
          <h2>Как модель считает ETA</h2>
          <EtaExplain m={data.eta_model} />
        </section>

        <section className="block block--wide">
          <h2>Где курьеры теряют время</h2>
          <p className="muted">
            Места, где по трекам чаще всего стоят дольше минуты. Чем больше круг, тем больше минут потеряно.
          </p>
          <ZonesMap zones={data.problem_zones} />
          <ol className="zones">
            {data.problem_zones.slice(0, 5).map((z, i) => (
              <li key={i}>
                <span>
                  {z.lat.toFixed(4)}, {z.lng.toFixed(4)}
                </span>
                <span>
                  {z.total_stop_min} мин за {z.stops} остановок
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className="block block--wide">
          <h2>Курьеры</h2>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Курьер</th>
                <th scope="col" className="num">Доставок</th>
                <th scope="col" className="num">Среднее время</th>
                <th scope="col" className="num">Скорость в движении</th>
              </tr>
            </thead>
            <tbody>
              {data.couriers.map((c) => (
                <tr key={c.courier_id}>
                  <th scope="row">{c.name}</th>
                  <td className="num">{c.delivered}</td>
                  <td className="num">{c.avg_delivery_min != null ? `${c.avg_delivery_min} мин` : '—'}</td>
                  <td className="num">{c.avg_speed_kmh != null ? `${c.avg_speed_kmh} км/ч` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  )
}

function Kpi({ value, label, tone }: { value: string | number; label: string; tone?: 'bad' }) {
  return (
    <div className={`kpi${tone ? ` kpi--${tone}` : ''}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}

function HourChart({ values }: { values: number[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...values)
  const W = 480, H = 180, padL = 28, padB = 22, padT = 10
  const bw = (W - padL) / 24
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max)
  const ticks = [0, Math.round(max / 2), max]

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Количество доставок по часам суток">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W} y1={y(t)} y2={y(t)} className="grid" />
            <text x={padL - 6} y={y(t) + 4} className="axis" textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {values.map((v, h) => {
          const x = padL + h * bw
          const top = y(v)
          const bh = H - padB - top
          const r = Math.min(4, bh)
          return (
            <g key={h} onMouseEnter={() => setHover(h)} onMouseLeave={() => setHover(null)}>
              <rect x={x} y={padT} width={bw} height={H - padT - padB} fill="transparent" />
              {v > 0 && (
                <path
                  className={`bar${hover === h ? ' is-hover' : ''}`}
                  d={`M${x + 2},${H - padB} V${top + r} Q${x + 2},${top} ${x + 2 + r},${top} H${x + bw - 2 - r} Q${x + bw - 2},${top} ${x + bw - 2},${top + r} V${H - padB} Z`}
                />
              )}
              {h % 3 === 0 && (
                <text x={x + bw / 2} y={H - 6} className="axis" textAnchor="middle">
                  {h}
                </text>
              )}
            </g>
          )
        })}
        <line x1={padL} x2={W} y1={H - padB} y2={H - padB} className="baseline" />
      </svg>
      {hover != null && (
        <div className="tip" style={{ left: `${((padL + hover * bw + bw / 2) / W) * 100}%` }}>
          {String(hover).padStart(2, '0')}:00–{String((hover + 1) % 24).padStart(2, '0')}:00, <strong>{values[hover]}</strong>
        </div>
      )}
    </div>
  )
}

function EtaExplain({ m }: { m: AnalyticsSummary['eta_model'] }) {
  if (m.type === 'heuristic')
    return (
      <p>
        Пока доставок мало ({m.trained_on}), прогноз строится по правилу: 5 минут на сборы плюс 18 км/ч, в час пик на
        30% дольше. Модель обучится автоматически после пяти доставок.
      </p>
    )
  return (
    <>
      <p>
        Линейная регрессия, обучена на <strong>{m.trained_on}</strong> доставках. Переобучается после каждой новой.
      </p>
      <p className="formula">
        минуты = {m.intercept_min} + {m.min_per_km} × км по прямой + {m.peak_extra_min} в час пик
      </p>
      <p className="muted">
        Типичная ошибка прогноза ±{m.resid_std_min} мин. Доставка, которая дольше прогноза больше чем на две таких
        ошибки, помечается как аномалия.
      </p>
    </>
  )
}

function ZonesMap({ zones }: { zones: AnalyticsSummary['problem_zones'] }) {
  const max = Math.max(1, ...zones.map((z) => z.total_stop_min))
  const dark = useDark()
  return (
    <MapContainer center={[43.238, 76.912]} zoom={12} className="zones-map" scrollWheelZoom={false}>
      <AutoResize />
      <TileLayer url={TILE_URL} attribution={TILE_ATTR} className={dark ? 'tiles--dark' : ''} />
      {zones.map((z, i) => (
        <CircleMarker
          key={i}
          center={[z.lat, z.lng]}
          radius={8 + 22 * (z.total_stop_min / max)}
          pathOptions={{ className: 'zone' }}
        >
          <Tooltip>
            {z.total_stop_min} мин простоя, {z.stops} остановок
          </Tooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  )
}
