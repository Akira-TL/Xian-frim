"""只暴露已实现的强类型接口，设备确认接口将在设备链路接入时添加。"""

from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
import os
import secrets
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response

from .models import (
    BadgeRegistration, ErrorResponse, Health, ScanRequest, ScanResponse, SentReport,
    SiteSelection, Source, TerminalConfiguration, UnlockCommand, UnlockRequest, Visit,
    HeartbeatReceipt, MapSnapshot, TerminalHeartbeat,
)
from .storage import BusinessError, Repository
from .statistics import build_map


def create_app(db_path: Path, operator_token: str, terminal_token: str,
               clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc)) -> FastAPI:
    if (not operator_token or not terminal_token or operator_token == terminal_token
            or not operator_token.isascii() or not terminal_token.isascii()):
        raise ValueError("请配置不同的工作人员和终端访问令牌")
    repository = Repository(db_path)
    app = FastAPI(title="长安游迹接口", version="0.1.0")

    def verify(token: str, authorization: str | None) -> None:
        if (authorization is None or not authorization.isascii()
                or not secrets.compare_digest(authorization, "Bearer " + token)):
            raise HTTPException(status_code=401, detail="访问令牌无效")

    def operator(authorization: Annotated[str | None, Header()] = None) -> None:
        verify(operator_token, authorization)

    def terminal(authorization: Annotated[str | None, Header()] = None) -> None:
        verify(terminal_token, authorization)

    def reader(authorization: Annotated[str | None, Header()] = None) -> None:
        if authorization is not None and authorization.isascii() and secrets.compare_digest(authorization, "Bearer " + operator_token):
            return
        verify(terminal_token, authorization)

    @app.exception_handler(BusinessError)
    async def business_error(request: Request, error: BusinessError) -> Response:
        return Response(content=ErrorResponse(detail=error.detail).model_dump_json(),
                        status_code=error.status, media_type="application/json")

    @app.get("/health", response_model=Health)
    def health() -> Health:
        return Health()

    @app.post("/api/v1/badges", dependencies=[Depends(operator)])
    def register(request: BadgeRegistration) -> BadgeRegistration:
        return repository.register(request)

    @app.post("/api/v1/visits", dependencies=[Depends(terminal)])
    def scan(request: ScanRequest) -> ScanResponse:
        return repository.scan(request, clock())

    @app.post("/api/v1/demo/visits", dependencies=[Depends(operator)])
    def simulated_scan(request: ScanRequest) -> ScanResponse:
        return repository.scan(request, clock(), Source.GENERATED)

    @app.get("/api/v1/visits", dependencies=[Depends(operator)])
    def visits() -> list[Visit]:
        return repository.visits()

    @app.get("/api/v1/terminal/configuration", dependencies=[Depends(terminal)])
    def configuration() -> TerminalConfiguration:
        return repository.configuration()

    @app.put("/api/v1/terminal/configuration", dependencies=[Depends(operator)])
    def select_site(request: SiteSelection) -> TerminalConfiguration:
        return repository.select_site(request.site_id)

    @app.post("/api/v1/terminal/heartbeat", dependencies=[Depends(terminal)])
    def heartbeat(request: TerminalHeartbeat) -> HeartbeatReceipt:
        return repository.heartbeat(request, clock())

    @app.get("/api/v1/map", dependencies=[Depends(reader)])
    def map_snapshot(source: Source = Source.PHYSICAL) -> MapSnapshot:
        visits, heartbeats = repository.observations()
        return build_map(visits, heartbeats, clock(), source)

    @app.post("/api/v1/unlock-commands", dependencies=[Depends(operator)])
    def unlock(request: UnlockRequest) -> UnlockCommand:
        return repository.unlock(request, clock())

    @app.post("/api/v1/unlock-commands/{command_id}/sent", dependencies=[Depends(operator)])
    def sent(command_id: str, request: SentReport) -> UnlockCommand:
        return repository.mark_sent(command_id, request.device_id, clock())

    return app


def create_app_from_environment() -> FastAPI:
    return create_app(Path(os.environ.get("CHANGAN_DB_PATH", "data/changan.sqlite3")),
                      os.environ.get("CHANGAN_OPERATOR_TOKEN", ""),
                      os.environ.get("CHANGAN_TERMINAL_TOKEN", ""))
