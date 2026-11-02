"""그림 파일 올리기 (직원 사진·도면 밑그림) 공통: 본문 크기 제한"""

from fastapi import Request


async def read_limited(request: Request, limit: int) -> bytes | None:
    """요청 본문을 limit 바이트까지만 읽는다. 넘으면 그 자리에서 멈추고 None.

    Content-Length를 빼고 조각조각(chunked) 보내도 큰 본문을 메모리에 다 싣지 않는다
    (헤더의 Content-Length만 보고 request.body()로 읽으면 끝없이 받는다)."""
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)
