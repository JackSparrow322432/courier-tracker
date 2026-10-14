import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { api, type Order } from '../api'

export interface Draft {
  pickup?: [number, number]
  dropoff?: [number, number]
}

interface Props {
  draft: Draft
  onReset: () => void
  onCancel: () => void
  onCreated: (o: Order) => void
}

export function NewOrderForm({ draft, onReset, onCancel, onCreated }: Props) {
  const qc = useQueryClient()
  const [f, setF] = useState({ customer_name: '', customer_phone: '', pickup_address: '', dropoff_address: '' })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })

  const create = useMutation({
    mutationFn: () =>
      api.createOrder({
        ...f,
        pickup_lat: draft.pickup![0],
        pickup_lng: draft.pickup![1],
        dropoff_lat: draft.dropoff![0],
        dropoff_lng: draft.dropoff![1],
      }),
    onSuccess: (o) => {
      qc.invalidateQueries({ queryKey: ['orders'] })
      onCreated(o)
    },
  })

  const hint = !draft.pickup
    ? 'Нажмите на карту, где курьер заберёт заказ.'
    : !draft.dropoff
      ? 'Теперь нажмите, куда доставить.'
      : 'Обе точки на месте. Чтобы переставить, начните заново.'

  const ready = draft.pickup && draft.dropoff && f.customer_name && f.pickup_address && f.dropoff_address

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (ready) create.mutate()
  }

  return (
    <aside className="queue">
      <form className="form" onSubmit={submit}>
        <div className="queue__head">
          <h2>Новый заказ</h2>
          <button type="button" className="btn btn--ghost" onClick={onCancel} aria-label="Закрыть форму">
            ✕
          </button>
        </div>

        <p className={`hint${draft.pickup && draft.dropoff ? ' hint--ok' : ''}`}>
          {hint}{' '}
          {(draft.pickup || draft.dropoff) && (
            <button type="button" className="link" onClick={onReset}>
              Начать заново
            </button>
          )}
        </p>

        <label>
          Откуда забрать
          <input required value={f.pickup_address} onChange={set('pickup_address')} placeholder="Esentai Mall, Аль-Фараби 77/8" />
        </label>
        <label>
          Куда доставить
          <input required value={f.dropoff_address} onChange={set('dropoff_address')} placeholder="Жибек Жолы 53, кв. 12" />
        </label>
        <label>
          Имя клиента
          <input required value={f.customer_name} onChange={set('customer_name')} />
        </label>
        <label>
          Телефон клиента
          <input type="tel" value={f.customer_phone} onChange={set('customer_phone')} placeholder="+7 7__ ___ __ __" />
        </label>

        {create.error && <p className="error">{(create.error as Error).message}</p>}

        <button className="btn btn--primary btn--wide" disabled={!ready || create.isPending}>
          {create.isPending ? 'Создаю…' : 'Создать заказ'}
        </button>
      </form>
    </aside>
  )
}
