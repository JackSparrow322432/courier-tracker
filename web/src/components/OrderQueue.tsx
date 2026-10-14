import { useEffect, useState } from 'react'
import { minutesSince, STATUS_LABEL, timeHM, type Courier, type Order } from '../api'

const WAIT_WARN_MIN = 5

function useTick(ms: number) {
  const [, set] = useState(0)
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms)
    return () => clearInterval(t)
  }, [ms])
}

function short(addr: string) {
  return addr.split(',')[0]
}

interface Props {
  orders: Order[]
  couriers: Courier[]
  selectedId: number | null
  onSelect: (id: number) => void
  onNew: () => void
}

export function OrderQueue({ orders, couriers, selectedId, onSelect, onNew }: Props) {
  useTick(30_000) // обновляем «ждёт N мин»
  const names = new Map(couriers.map((c) => [c.id, c.name.split(' ')[0]]))
  const waiting = orders.filter((o) => o.status === 'created').sort((a, b) => a.id - b.id)
  const moving = orders.filter((o) => o.status === 'assigned' || o.status === 'picked_up')
  const done = orders.filter((o) => o.status === 'delivered').slice(0, 15)

  const row = (o: Order) => {
    const wait = o.status === 'created' ? minutesSince(o.created_at) : 0
    return (
      <li key={o.id}>
        <button
          className={`orow orow--${o.status}${selectedId === o.id ? ' is-sel' : ''}`}
          onClick={() => onSelect(o.id)}
          aria-current={selectedId === o.id}
        >
          <span className="orow__id">№{o.id}</span>
          <span className="orow__route">
            {short(o.pickup_address)}
            <span className="orow__arrow" aria-hidden>
              ⟶
            </span>
            {short(o.dropoff_address)}
          </span>
          <span className="orow__meta">
            {o.status === 'created' && (
              <span className={wait >= WAIT_WARN_MIN ? 'warn' : ''}>ждёт {wait} мин</span>
            )}
            {(o.status === 'assigned' || o.status === 'picked_up') && (
              <>
                <span>{names.get(o.courier_id ?? -1)}</span>
                <span className="orow__state">{STATUS_LABEL[o.status].toLowerCase()}</span>
                {o.eta_minutes != null && <span>≈{Math.round(o.eta_minutes)} мин</span>}
              </>
            )}
            {o.status === 'delivered' && (
              <>
                <span>{names.get(o.courier_id ?? -1)}</span>
                <span>в {timeHM(o.delivered_at)}</span>
              </>
            )}
          </span>
        </button>
      </li>
    )
  }

  return (
    <aside className="queue" aria-label="Заказы">
      <div className="queue__head">
        <h2>Заказы</h2>
        <button className="btn btn--primary" onClick={onNew}>
          Новый заказ
        </button>
      </div>

      <section>
        <h3>
          Ждут курьера <span className="count">{waiting.length}</span>
        </h3>
        {waiting.length ? (
          <ul>{waiting.map(row)}</ul>
        ) : (
          <p className="empty">Очередь пуста, все заказы распределены.</p>
        )}
      </section>

      <section>
        <h3>
          В пути <span className="count">{moving.length}</span>
        </h3>
        {moving.length ? <ul>{moving.map(row)}</ul> : <p className="empty">Сейчас никто не везёт заказ.</p>}
      </section>

      <section>
        <h3>Последние доставки</h3>
        <ul>{done.map(row)}</ul>
      </section>
    </aside>
  )
}
