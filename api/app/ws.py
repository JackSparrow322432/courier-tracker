import json
from typing import Any

from fastapi import WebSocket
from fastapi.encoders import jsonable_encoder


class Hub:
    """Простая рассылка событий всем подключённым диспетчерам/клиентам."""

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.clients.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self.clients.discard(ws)

    async def broadcast(self, event: str, data: Any) -> None:
        msg = json.dumps({"event": event, "data": jsonable_encoder(data)})
        dead = []
        for ws in self.clients:
            try:
                await ws.send_text(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)


hub = Hub()
