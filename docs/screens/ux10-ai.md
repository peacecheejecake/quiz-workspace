# UX10-AI — AI 가용성과 저장된 해설

**Route:** Workspace 홈 · 본문 검색 · 문제 보기 · 노트 · 문서 요약 · 모의고사
**Phase:** UX10-AI.0
**테스트:** `tests/e2e/questions/ux10-ai.spec.ts`

```yaml
id: UX10-AI
linked_tests: [UX10-AI-AC01, UX10-AI-AC02, UX10-AI-AC03, UX10-AI-AC04]
```

### UX10-AI-AC01

LLM 또는 기능이 꺼지면 새 AI 동작은 숨기고 일반 풀이와 보기 섞기는 사용할 수 있다.

### UX10-AI-AC02

허용된 저장 해설은 기본 펼침이며 없는 해설을 자동 생성하지 않는다.

### UX10-AI-AC03

지정된 해설 전송 안내를 삭제하고 제출 전 해설을 노출하지 않는다.

### UX10-AI-AC04

서버 기능 설정과 권한은 직접 API 요청에도 적용되며 저장 콘텐츠 읽기 권한은 유지된다.
