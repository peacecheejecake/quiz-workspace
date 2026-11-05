# UX10-QVIEW — 문제 보기

linked_tests: `tests/e2e/questions/questions-practice.spec.ts`, `tests/integration/questions/test_practice_api.py`

### UX10-QVIEW-AC01

문제 은행과 모의고사에서 보기 원본 순서가 기본이며 명시한 경우에만 섞는다. 채점은 보기 ID로 한다.

### UX10-QVIEW-AC02

이전·다음 화살표는 제출과 높이가 같고 접근성 이름과 양 끝 비활성을 유지한다.

### UX10-QVIEW-AC03

현재 revision의 본인 최신 결과를 다시 열며 다른 사용자와 미제출 응답에 정답을 노출하지 않는다.

### UX10-QVIEW-AC04

확인 후 본인 기록과 Heatmap을 초기화하고 이전 session과 결과를 다시 노출하지 않는다. 취소는 무변경이다.

### UX10-QVIEW-AC05

초기화와 제출의 경합, 멱등 재전송, 보관 및 다른 Workspace 요청을 서버에서 처리한다.
