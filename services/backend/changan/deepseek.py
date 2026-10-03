"""DeepSeek 外部服务适配器：密钥只在服务端读取，结果继续由业务层校验。"""

from pathlib import Path
from typing import Annotated, Literal

import httpx
from pydantic import BaseModel, Field, SecretStr, ValidationError

from .models import Contract
from .recommendations import ModelUnavailable, RecommendationInput


class ChatMessage(Contract):
    role: Literal["system", "user"]
    content: str


class JsonFormat(Contract):
    type: Literal["json_object"] = "json_object"


class ThinkingMode(Contract):
    type: Literal["disabled"] = "disabled"


class ChatRequest(Contract):
    model: Literal["deepseek-flash"] = "deepseek-flash"
    messages: list[ChatMessage]
    response_format: JsonFormat = Field(default_factory=JsonFormat)
    thinking: ThinkingMode = Field(default_factory=ThinkingMode)
    stream: Literal[False] = False
    max_tokens: int = 1024


class ReplyMessage(BaseModel):
    content: str


class ReplyChoice(BaseModel):
    finish_reason: str
    message: ReplyMessage


class ChatReply(BaseModel):
    choices: Annotated[list[ReplyChoice], Field(min_length=1, max_length=1)]


SYSTEM_PROMPT = (
    "你为长安游迹演示生成下一站建议。只依据用户提供的快照，从 candidates 中选一个 site_id；"
    "原样返回 snapshot_id。不要编造人数、道路、开放状态、文化史实、兴趣画像或已完成任务。"
    "selected_visit_site 仅为选定到访记录的地点，不是实时定位。只说选定到访地点，"
    "不要把任何节点称为当前位置；推荐地点是下一站，不是已到达地点。"
    "visited_sites 仅表示到访，绝不表示已完成。完成只依据 completed_games；为空时不要声称"
    "已完成、已通关、已收藏、已解锁或已获得奖励，应说明没有认证完成记录。"
    "B/C 的小游戏未接入时只能提示观察内容，不能声称可玩。只输出 json 对象，不输出思考过程。"
    '格式示例：{"snapshot_id":"输入中的编号","selected_site":"B",'
    '"child_text":"下一站去城门看看吧。","operator_reason":"根据输入说明选择依据。"}。'
    "child_text 为适合孩子的简短一句话，最多200字符；operator_reason 最多500字符。"
)


class DeepSeekModel:
    def __init__(self, api_key: SecretStr, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.api_key = api_key
        self.transport = transport

    async def recommend(self, snapshot: RecommendationInput) -> str:
        request = ChatRequest(messages=[ChatMessage(role="system", content=SYSTEM_PROMPT),
                                        ChatMessage(role="user", content=snapshot.model_dump_json())])
        try:
            async with httpx.AsyncClient(transport=self.transport, timeout=httpx.Timeout(10, connect=3),
                                         follow_redirects=False, trust_env=False) as client:
                async with client.stream("POST", "https://api.deepseek.com/chat/completions",
                    headers=[("Authorization", "Bearer " + self.api_key.get_secret_value()),
                             ("Content-Type", "application/json")], content=request.model_dump_json()) as response:
                    if response.status_code != 200:
                        raise ModelUnavailable("模型服务未返回成功响应")
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > 65536:
                            raise ModelUnavailable("模型服务响应超出大小限制")
            reply = ChatReply.model_validate_json(bytes(body))
            if reply.choices[0].finish_reason != "stop":
                raise ModelUnavailable("模型服务没有完整结束生成")
            return reply.choices[0].message.content
        except (httpx.RequestError, ValidationError):
            # 不记录外部异常或响应体，避免泄露凭据与服务内部详情。
            raise ModelUnavailable("模型服务请求或响应失败") from None


def load_deepseek(path: Path, *, required: bool = False) -> DeepSeekModel | None:
    if not path.exists() and not required:
        return None
    if not path.is_file() or path.is_symlink() or path.stat().st_mode & 0o077:
        raise ValueError("DeepSeek 私有配置必须是权限600的普通文件")
    lines = [line.strip() for line in path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    if len(lines) != 1:
        raise ValueError("DeepSeek 私有配置仅允许一行密钥定义")
    name, separator, value = lines[0].partition("=")
    value = value.strip()
    if name.strip() != "DEEPSEEK_API_KEY" or not separator or not value or not value.isascii() or any(
            character.isspace() for character in value):
        raise ValueError("DeepSeek 私有配置格式无效")
    return DeepSeekModel(SecretStr(value))
