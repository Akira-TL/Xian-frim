"""只暴露已实现的强类型接口，设备确认接口将在设备链路接入时添加。"""

from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
import os
import secrets
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError

from .models import (
    BadgeRegistration, DemoPreparation, ErrorResponse, Health, ScanRequest, ScanResponse, SentReport, InterfaceTestScanRequest,
    SiteSelection, Source, TerminalConfiguration, UnlockCommand, UnlockRequest, Visit,
    HeartbeatReceipt, MapSnapshot, TerminalHeartbeat, ActivitySnapshot,
)
from .storage import BusinessError, Repository
from .statistics import build_map
from .device_protocol import DeviceEnvelope, DeviceKey, DeviceKeys, DeviceReport, DeviceState, NonceRequest
from .device_service import DeviceService
from .simulation import ScenarioRequest, ScenarioResult, simulate
from .catalog import SiteCatalog, default_catalog
from .deepseek import load_deepseek
from .recommendations import RecommendationAudit, RecommendationModel, RecommendationRecord, RecommendationRejection, RecommendationRequest, RecommendationResult, RecommendationService


def create_app(db_path: Path, operator_token: str, terminal_token: str,
               clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
               device_keys: tuple[DeviceKey, ...] = (), site_catalog: SiteCatalog | None = None,
               recommendation_model: RecommendationModel | None = None) -> FastAPI:
    if (not operator_token or not terminal_token or operator_token == terminal_token
            or not operator_token.isascii() or not terminal_token.isascii()):
        raise ValueError("请配置不同的工作人员和终端访问令牌")
    repository = Repository(db_path)
    devices = DeviceService(repository, device_keys)
    catalog = SiteCatalog.model_validate_json((site_catalog or default_catalog()).model_dump_json())
    recommendations = RecommendationService(repository, catalog, recommendation_model)
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

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError) -> Response:
        if request.url.path == "/api/v1/simulation":
            # 不回显未经验证的数值：JSON 大指数可被解码为 inf，不能再次写入 JSON 响应。
            return Response(content=ErrorResponse(detail="推演参数无效，请检查数值范围和节点配置").model_dump_json(),
                            status_code=422, media_type="application/json")
        return await request_validation_exception_handler(request, error)

    @app.get("/health", response_model=Health)
    def health() -> Health:
        return Health()

    @app.get("/api/v1/sites", dependencies=[Depends(reader)])
    def sites() -> SiteCatalog:
        return catalog

    @app.post("/api/v1/recommendations", dependencies=[Depends(operator)])
    async def recommend(request: RecommendationRequest) -> RecommendationResult:
        return await recommendations.create(request, clock)

    @app.get("/api/v1/recommendations/{snapshot_id}", dependencies=[Depends(reader)])
    def recommendation_record(snapshot_id: str) -> RecommendationRecord:
        return recommendations.read(snapshot_id, clock())

    @app.get("/api/v1/recommendations/{snapshot_id}/audit", dependencies=[Depends(operator)])
    def recommendation_audit(snapshot_id: str) -> RecommendationAudit:
        return recommendations.audit(snapshot_id)

    @app.get("/api/v1/recommendation-rejections", dependencies=[Depends(operator)])
    def recommendation_rejections() -> list[RecommendationRejection]:
        return recommendations.rejections()

    @app.post("/api/v1/badges", dependencies=[Depends(operator)])
    def register(request: BadgeRegistration) -> BadgeRegistration:
        return repository.register(request)

    @app.get("/api/v1/badges", dependencies=[Depends(operator)])
    def badges() -> list[BadgeRegistration]:
        return repository.badges()

    @app.post("/api/v1/visits", dependencies=[Depends(terminal)])
    def scan(request: ScanRequest) -> ScanResponse:
        return repository.scan(request, clock())

    @app.post("/api/v1/demo/visits", dependencies=[Depends(operator)])
    def simulated_scan(request: ScanRequest) -> ScanResponse:
        return repository.scan(request, clock(), Source.GENERATED)

    @app.post("/api/v1/demo/prepare", dependencies=[Depends(operator)])
    def prepare_demo(request: DemoPreparation) -> list[Visit]:
        return repository.prepare_demo(request.batch_id, clock())

    @app.post("/api/v1/interface-test/visits", dependencies=[Depends(operator)])
    def interface_test_scan(request: InterfaceTestScanRequest) -> ScanResponse:
        return repository.scan(request, clock(), Source.INTERFACE_TEST)

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
        return build_map(visits, heartbeats, clock(), source, catalog.heat_thresholds)

    @app.get("/api/v1/activity", dependencies=[Depends(operator)])
    def activity_snapshot(source: Source = Source.PHYSICAL) -> ActivitySnapshot:
        visits, heartbeats, progress = repository.activity_observations(source)
        return ActivitySnapshot(map=build_map(visits, heartbeats, clock(), source, catalog.heat_thresholds),
                                progress=progress if source != Source.GENERATED else None)

    @app.post("/api/v1/simulation", dependencies=[Depends(operator)])
    def scenario(request: ScenarioRequest) -> ScenarioResult:
        return simulate(request, clock())

    @app.post("/api/v1/unlock-commands", dependencies=[Depends(operator)])
    def unlock(request: UnlockRequest) -> UnlockCommand:
        return repository.unlock(request, clock())

    @app.get("/api/v1/unlock-commands", dependencies=[Depends(operator)])
    def commands() -> list[UnlockCommand]:
        return repository.commands()

    @app.post("/api/v1/unlock-commands/{command_id}/sent", dependencies=[Depends(operator)])
    def sent(command_id: str, request: SentReport) -> UnlockCommand:
        return repository.mark_sent(command_id, request.device_id, clock())

    @app.post("/api/v1/badges/{badge_id}/unlock-commands/{command_id}/authorize", dependencies=[Depends(operator)])
    def authorize(badge_id: str, command_id: str, request: NonceRequest) -> DeviceEnvelope:
        return devices.issue(badge_id, clock(), command_id, request.nonce)

    @app.post("/api/v1/badges/{badge_id}/state-challenges", dependencies=[Depends(operator)])
    def state_challenge(badge_id: str) -> DeviceEnvelope:
        return devices.issue(badge_id, clock())

    @app.post("/api/v1/device-reports", dependencies=[Depends(operator)])
    def device_report(request: DeviceReport) -> DeviceState:
        return devices.confirm(request, clock())

    @app.get("/api/v1/badges/{badge_id}/progress", dependencies=[Depends(operator)])
    def progress(badge_id: str) -> DeviceState:
        return devices.progress(badge_id)

    return app


def create_app_from_environment() -> FastAPI:
    enabled = os.environ.get("CHANGAN_DEEPSEEK_ENABLED", "1")
    if enabled not in ("0", "1"):
        raise ValueError("CHANGAN_DEEPSEEK_ENABLED 只允许0或1")
    model_path = os.environ.get("CHANGAN_DEEPSEEK_KEY_PATH")
    model = None if enabled == "0" else load_deepseek(Path(model_path or "data/deepseek.env"), required=model_path is not None)
    keys_path = os.environ.get("CHANGAN_DEVICE_KEYS_PATH")
    keys = () if not keys_path else tuple(DeviceKeys.model_validate_json(Path(keys_path).read_text()).devices)
    catalog_path = os.environ.get("CHANGAN_SITE_CATALOG_PATH")
    catalog = None if not catalog_path else SiteCatalog.model_validate_json(Path(catalog_path).read_text())
    return create_app(Path(os.environ.get("CHANGAN_DB_PATH", "data/changan.sqlite3")),
                      os.environ.get("CHANGAN_OPERATOR_TOKEN", ""),
                      os.environ.get("CHANGAN_TERMINAL_TOKEN", ""), device_keys=keys, site_catalog=catalog,
                      recommendation_model=model)
