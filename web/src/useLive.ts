import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { wsUrl, type Courier, type Order } from './api'

type LiveEvent =
  | { event: 'courier_location'; data: Pick<Courier, 'id' | 'lat' | 'lng' | 'speed' | 'status'> & { ts: string } }
  | { event: 'courier_updated'; data: Courier }
  | { event: 'order_updated'; data: Order }

export type LiveState = 'connecting' | 'live' | 'lost'

/** Подписка на WebSocket: события сразу правят кэш react-query, без перезапросов. */
export function useLive(): LiveState {
  const qc = useQueryClient()
  const [state, setState] = useState<LiveState>('connecting')

  useEffect(() => {
    let ws: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let ping: ReturnType<typeof setInterval> | undefined
    let closed = false
    let attempt = 0

    const connect = () => {
      ws = new WebSocket(wsUrl())
      ws.onopen = () => {
        attempt = 0
        setState('live')
        // после переподключения подтягиваем всё, что могли пропустить
        qc.invalidateQueries()
        ping = setInterval(() => ws?.readyState === 1 && ws.send('ping'), 25_000)
      }
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as LiveEvent
        switch (msg.event) {
          case 'courier_location': {
            const { id, ts, ...rest } = msg.data
            qc.setQueryData<Courier[]>(['couriers'], (list) =>
              list?.map((c) => (c.id === id ? { ...c, ...rest, last_seen: ts } : c)),
            )
            break
          }
          case 'courier_updated':
            qc.setQueryData<Courier[]>(['couriers'], (list) => {
              if (!list) return list
              return list.some((c) => c.id === msg.data.id)
                ? list.map((c) => (c.id === msg.data.id ? msg.data : c))
                : [...list, msg.data]
            })
            break
          case 'order_updated':
            qc.setQueryData<Order[]>(['orders'], (list) => {
              if (!list) return list
              return list.some((o) => o.id === msg.data.id)
                ? list.map((o) => (o.id === msg.data.id ? msg.data : o))
                : [msg.data, ...list]
            })
            if (msg.data.status === 'delivered') qc.invalidateQueries({ queryKey: ['summary'] })
            break
        }
      }
      ws.onclose = () => {
        clearInterval(ping)
        if (closed) return
        setState('lost')
        attempt += 1
        retry = setTimeout(connect, Math.min(10_000, 1000 * 2 ** attempt))
      }
    }

    connect()
    return () => {
      closed = true
      clearTimeout(retry)
      clearInterval(ping)
      ws?.close()
    }
  }, [qc])

  return state
}
