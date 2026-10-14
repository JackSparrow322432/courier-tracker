import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { ACTIVE, api } from './api'
import { Analytics } from './components/Analytics'
import { CourierList } from './components/CourierList'
import { MapView } from './components/MapView'
import { NewOrderForm, type Draft } from './components/NewOrderForm'
import { OrderDetail } from './components/OrderDetail'
import { OrderQueue } from './components/OrderQueue'
import { useLive } from './useLive'

type Tab = 'map' | 'analytics'

export default function App() {
  const live = useLive()
  const [tab, setTab] = useState<Tab>('map')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<Draft>({})

  const couriers = useQuery({ queryKey: ['couriers'], queryFn: api.couriers })
  const orders = useQuery({ queryKey: ['orders'], queryFn: api.orders })

  const allOrders = orders.data ?? []
  const selected = allOrders.find((o) => o.id === selectedId) ?? null
  const visibleOrders = useMemo(
    () => allOrders.filter((o) => ACTIVE.includes(o.status) || o.id === selectedId),
    [allOrders, selectedId],
  )

  // Трек и разбор маршрута выбранного заказа; для активного — обновляем на лету
  const isMoving = selected?.status === 'assigned' || selected?.status === 'picked_up'
  const track = useQuery({
    queryKey: ['track', selectedId],
    queryFn: () => api.track(selectedId!),
    enabled: !!selected && selected.status !== 'created',
    refetchInterval: isMoving ? 5000 : false,
  })
  const analysis = useQuery({
    queryKey: ['analysis', selectedId, selected?.status],
    queryFn: () => api.analysis(selectedId!),
    enabled: !!selected && selected.status !== 'created',
    refetchInterval: isMoving ? 10_000 : false,
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedId(null)
        setCreating(false)
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  const waiting = allOrders.filter((o) => o.status === 'created').length
  const loadError = couriers.error ?? orders.error

  const onMapClick = (lat: number, lng: number) => {
    if (!creating) return
    setDraft((d) => (!d.pickup ? { pickup: [lat, lng] } : !d.dropoff ? { ...d, dropoff: [lat, lng] } : d))
  }

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="brand__mark" aria-hidden />
          <span>Диспетчерская</span>
        </div>
        <nav className="tabs" aria-label="Разделы">
          <button className={tab === 'map' ? 'is-on' : ''} onClick={() => setTab('map')} aria-current={tab === 'map'}>
            Карта
            {waiting > 0 && <span className="badge" aria-label={`${waiting} ждут курьера`}>{waiting}</span>}
          </button>
          <button
            className={tab === 'analytics' ? 'is-on' : ''}
            onClick={() => setTab('analytics')}
            aria-current={tab === 'analytics'}
          >
            Аналитика маршрутов
          </button>
        </nav>
        <p className={`live live--${live}`} role="status">
          {live === 'live' ? 'Онлайн' : live === 'connecting' ? 'Подключаюсь…' : 'Связь потеряна, переподключаюсь'}
        </p>
      </header>

      {loadError && (
        <p className="banner">
          Нет связи с сервером: {(loadError as Error).message}. Запустите API (uvicorn app.main:app) и обновите
          страницу.
        </p>
      )}

      {tab === 'map' ? (
        <main className="desk">
          {creating ? (
            <NewOrderForm
              draft={draft}
              onReset={() => setDraft({})}
              onCancel={() => {
                setCreating(false)
                setDraft({})
              }}
              onCreated={(o) => {
                setCreating(false)
                setDraft({})
                setSelectedId(o.id)
              }}
            />
          ) : (
            <OrderQueue
              orders={allOrders}
              couriers={couriers.data ?? []}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onNew={() => {
                setSelectedId(null)
                setCreating(true)
              }}
            />
          )}

          <div className="stage">
            <MapView
              couriers={couriers.data ?? []}
              orders={creating ? [] : visibleOrders}
              selected={creating ? null : selected}
              track={track.data}
              analysis={analysis.data}
              onSelectOrder={setSelectedId}
              picking={creating}
              draftPoints={creating ? draft : undefined}
              onMapClick={onMapClick}
            />
            <ul className="legend" aria-label="Обозначения на карте">
              <li><span className="cm cm--idle cm--dot" />свободен</li>
              <li><span className="cm cm--busy cm--dot" />на заказе</li>
              <li><span className="pm pm--pickup pm--dot">A</span>забрать</li>
              <li><span className="pm pm--dropoff pm--dot">Б</span>доставить</li>
            </ul>
          </div>

          {selected && !creating ? (
            <OrderDetail
              order={selected}
              couriers={couriers.data ?? []}
              analysis={analysis.data}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <CourierList couriers={couriers.data ?? []} orders={allOrders} onSelectOrder={setSelectedId} />
          )}
        </main>
      ) : (
        <Analytics />
      )}
    </div>
  )
}
