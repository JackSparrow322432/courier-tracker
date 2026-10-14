import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, STATUS_LABEL, timeHM, type Courier, type Order, type OrderStatus, type RouteAnalysis } from '../api'

interface Props {
  order: Order
  couriers: Courier[]
  analysis?: RouteAnalysis
  onClose: () => void
}

const STEPS: { status: OrderStatus; label: string; at: keyof Order }[] = [
  { status: 'created', label: 'Создан', at: 'created_at' },
  { status: 'assigned', label: 'Назначен курьеру', at: 'assigned_at' },
  { status: 'picked_up', label: 'Забран', at: 'picked_up_at' },
  { status: 'delivered', label: 'Доставлен', at: 'delivered_at' },
]

export function OrderDetail({ order, couriers, analysis, onClose }: Props) {
  const qc = useQueryClient()
  const courier = couriers.find((c) => c.id === order.courier_id)

  const suggestions = useQuery({
    queryKey: ['suggest', order.id, couriers.filter((c) => c.status === 'idle').length],
    queryFn: () => api.suggest(order.id),
    enabled: order.status === 'created',
  })

  const done = () => {
    qc.invalidateQueries({ queryKey: ['orders'] })
    qc.invalidateQueries({ queryKey: ['couriers'] })
  }
  const assign = useMutation({ mutationFn: (cid: number) => api.assign(order.id, cid), onSuccess: done })
  const status = useMutation({ mutationFn: (s: OrderStatus) => api.setStatus(order.id, s), onSuccess: done })
  const error = (assign.error ?? status.error) as Error | null
  const idle = couriers.filter((c) => c.status === 'idle')

  return (
    <aside className="detail" aria-label={`Заказ №${order.id}`}>
      <div className="detail__head">
        <div>
          <h2>Заказ №{order.id}</h2>
          <p className={`pill pill--${order.status}`}>{STATUS_LABEL[order.status]}</p>
        </div>
        <button className="btn btn--ghost" onClick={onClose} aria-label="Закрыть заказ">
          ✕
        </button>
      </div>

      <dl className="addr">
        <div>
          <dt>
            <span className="pm pm--pickup pm--inline">A</span> Забрать
          </dt>
          <dd>{order.pickup_address}</dd>
        </div>
        <div>
          <dt>
            <span className="pm pm--dropoff pm--inline">Б</span> Доставить
          </dt>
          <dd>{order.dropoff_address}</dd>
        </div>
        <div>
          <dt>Клиент</dt>
          <dd>
            {order.customer_name}
            {order.customer_phone && <a href={`tel:${order.customer_phone}`}>{order.customer_phone}</a>}
          </dd>
        </div>
      </dl>

      {order.status !== 'cancelled' && (
        <ol className="timeline">
          {STEPS.map((s) => {
            const at = order[s.at] as string | null
            return (
              <li key={s.status} className={at ? 'is-done' : ''}>
                <span>{s.label}</span>
                <time>{timeHM(at)}</time>
              </li>
            )
          })}
        </ol>
      )}

      {order.status === 'created' && (
        <section className="assign">
          <h3>Кого отправить</h3>
          {suggestions.data?.length ? (
            <ul>
              {suggestions.data.map((s, i) => (
                <li key={s.courier.id}>
                  <button
                    className={`btn ${i === 0 ? 'btn--primary' : 'btn--line'} btn--wide`}
                    disabled={assign.isPending}
                    onClick={() => assign.mutate(s.courier.id)}
                  >
                    <span>Назначить: {s.courier.name}</span>
                    <span className="muted">{s.distance_km} км до точки A</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">
              {idle.length ? 'Ищу ближайших свободных курьеров…' : 'Свободных курьеров нет. Заказ подождёт в очереди.'}
            </p>
          )}
        </section>
      )}

      {(order.status === 'assigned' || order.status === 'picked_up') && (
        <section className="assign">
          <h3>Курьер</h3>
          <p className="courier-line">
            <strong>{courier?.name}</strong> {courier?.phone && <a href={`tel:${courier.phone}`}>{courier.phone}</a>}
          </p>
          {order.eta_minutes != null && (
            <p className="eta">
              Прогноз доставки ≈ <strong>{Math.round(order.eta_minutes)} мин</strong> от назначения
            </p>
          )}
          <div className="row-actions">
            {order.status === 'assigned' && (
              <button className="btn btn--line" onClick={() => status.mutate('created')}>
                Снять с курьера
              </button>
            )}
            <button className="btn btn--danger" onClick={() => status.mutate('cancelled')}>
              Отменить заказ
            </button>
          </div>
        </section>
      )}

      {order.status === 'created' && (
        <div className="row-actions">
          <button className="btn btn--danger" onClick={() => status.mutate('cancelled')}>
            Отменить заказ
          </button>
        </div>
      )}

      {error && <p className="error">{error.message}</p>}

      {analysis && analysis.points > 1 && <RouteReport a={analysis} />}
    </aside>
  )
}

function RouteReport({ a }: { a: RouteAnalysis }) {
  return (
    <section className="report">
      <h3>Разбор маршрута</h3>
      {a.is_anomaly && (
        <p className="alert">
          Доставка заметно дольше прогноза модели (отклонение {a.anomaly_score}σ). Стоит выяснить причину.
        </p>
      )}
      <dl className="facts">
        <div>
          <dt>Проехал</dt>
          <dd>{a.distance_km} км</dd>
        </div>
        <div>
          <dt>По прямой</dt>
          <dd>{a.straight_line_km} км</dd>
        </div>
        <div>
          <dt>Крюк</dt>
          <dd className={a.detour_ratio > 1.6 ? 'warn' : ''}>×{a.detour_ratio.toFixed(2)}</dd>
        </div>
        {a.duration_min != null && (
          <div>
            <dt>Время</dt>
            <dd>{Math.round(a.duration_min)} мин</dd>
          </div>
        )}
        {a.avg_speed_kmh != null && (
          <div>
            <dt>Скорость в движении</dt>
            <dd>{a.avg_speed_kmh} км/ч</dd>
          </div>
        )}
        <div>
          <dt>Стоял</dt>
          <dd>
            {a.total_stop_min} мин, {a.stops.length} раз
          </dd>
        </div>
      </dl>
    </section>
  )
}
