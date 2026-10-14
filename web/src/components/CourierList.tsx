import { COURIER_LABEL, initials, minutesSince, type Courier, type Order } from '../api'

interface Props {
  couriers: Courier[]
  orders: Order[]
  onSelectOrder: (id: number) => void
}

const ORDER: Record<Courier['status'], number> = { busy: 0, idle: 1, offline: 2 }

export function CourierList({ couriers, orders, onSelectOrder }: Props) {
  const current = new Map(
    orders
      .filter((o) => o.status === 'assigned' || o.status === 'picked_up')
      .map((o) => [o.courier_id, o] as const),
  )
  const sorted = [...couriers].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name))
  const free = couriers.filter((c) => c.status === 'idle').length

  return (
    <aside className="detail" aria-label="Курьеры">
      <div className="detail__head">
        <h2>Курьеры</h2>
        <p className="muted">
          {free} свободно из {couriers.filter((c) => c.status !== 'offline').length} на линии
        </p>
      </div>
      <ul className="clist">
        {sorted.map((c) => {
          const o = current.get(c.id)
          const stale = c.last_seen ? minutesSince(c.last_seen) : null
          return (
            <li key={c.id} className={`crow crow--${c.status}`}>
              <span className={`cm cm--${c.status} cm--inline`} aria-hidden>
                {initials(c.name)}
              </span>
              <div className="crow__body">
                <strong>{c.name}</strong>
                <span className="muted">
                  {COURIER_LABEL[c.status]}
                  {c.speed != null && c.status !== 'offline' && c.speed > 0.5 && `, ${Math.round(c.speed * 3.6)} км/ч`}
                  {stale != null && stale >= 2 && c.status !== 'offline' && `, нет сигнала ${stale} мин`}
                </span>
              </div>
              {o && (
                <button className="btn btn--line btn--sm" onClick={() => onSelectOrder(o.id)}>
                  №{o.id}
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
