# UX11-AI-DIRECT — 첨부 문제를 문맥으로 사용하는 직접 질문

**테스트:** `tests/e2e/ask/ux11-ai-direct.spec.ts` (prompt·worker 계약: `packages/core/tests/test_ask.py`, `apps/worker/tests/test_ask_job.py`)
**Phase:** UX11-AI-DIRECT
**연계:** [ASK-01](ask-llm.md), [구현 기준](../implementation/ux11/ai-direct.md), [문제 첨부 공개 수준](../questions.md)

### UX11-AI-DIRECT-AC01

문제에서 AI 질문을 열면 문제는 첨부 문맥이며 자동 질문이나 전체 해설은 생성하지 않는다. 사용자가 특정 보기·용어·문장·근거를 물으면 최신 질문에 직접 답한다. 전체 해설은 명시적으로 요청한 경우에만 공개 수준 안에서 제공한다.

### UX11-AI-DIRECT-AC02

유효한 질문을 보내기 버튼이나 Enter로 보내면 입력란은 네트워크 응답을 기다리기 전에 비워지고 보낸 질문과 진행 상태를 확인할 수 있다.

### UX11-AI-DIRECT-AC03

실패한 질문은 잃지 않고 새 draft를 덮지 않는다. 빠른 중복 전송과 IME 조합 중 Enter는 중복 메시지를 만들지 않는다. API 수락 전 실패 시 전송 이후 편집이 없으면 보낸 질문을 복구하고 새 draft는 보존하고 실패한 질문은 복사 가능한 로컬 복구 영역에 표시한다. 수락 후 stream 실패는 기존 메시지의 재시도를 사용한다.

### UX11-AI-DIRECT-AC04

기존 hint/full 서버 공개 경계, 개인 대화 인가, 근거와 인용, 스트리밍 및 재시도를 유지한다. 제출 전 hint 요청에는 정답·해설 DTO가 없다.
