# UX11 — 직접 AI 답변·풀이 복귀·발문 문단 개선

2026-11-05 추가 요청. UX10 작업을 취소하지 않고 후속 Task로 병행한다. 최신 사용자 결정이 기존 화면 명세보다 우선하며 변경된 AC·계약은 각 RED 단계에 원본 screens와 연결한다.

| Task | 구현 기준 | 의존·소유 |
|---|---|---|
| UX11-AI-DIRECT | [AI 직접 답변·입력](ai-direct.md) | prompt는 독립, ask-panel은 UX10-AI 통합 후. 질문 첨부/submit 경계는 UX10-QVIEW 보존 |
| UX11-RETURN | [다시 풀기·global 복귀](return.md) | UX10-QVIEW 및 UX10-PLAY 계약 위에 연결. Provider/공통 복귀 UI 먼저 독립 구현 가능 |
| UX11-STEM | [발문 문단·제시 항목](stem.md) | 독립, 기존 STEM-ITEMS-A/B와 호환 |

각 Task는 gpt-6.1-terra 기본 effort agent 하나에 1:1 배정, 독립 worktree·task branch 사용. 구현 후 독립 Codex 리뷰 통과→커밋→main thread 재검증·통합 QA. 수정도 같은 모델 agent. 새 구현의 CI는 기존 UX10과 같은 feature PR 하나에서 실행하고 GREEN까지 수정, develop/main PR 병합 및 production 배포 권한은 기존 사용자 지시를 따른다. 로컬 검증은 생략하지 않는다. 다른 활성 Task 파일과 겹치면 소유권 인계 전 수정하지 않는다.

사용자 확정: 전송 실패 시 새 입력이 없으면 실패 질문을 복구하고 새 입력은 보존한다. 다시 풀기는 현재 문제만 새 시도로, 기존 기록은 보존한다. 범위/모의고사의 기존 회차 결과는 유지하며 현재 문제의 다시 풀기는 별도 연습으로 기록한다(사용자 최종 확정). 사용자 마지막 보조 본문 사례도 STEM 범위에 포함한다.
