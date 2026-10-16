# 화면 명세 우선 Playwright E2E — v1.3

이 저장소의 E2E는 **구현 전에 작성한 RED 예제**다. 애플리케이션·fixture·API가 아직 없으므로 실행하거나 GREEN을 확인하지 않았다.

1. `@playwright/test`를 설치하고 `supabase start` + FastAPI + Next.js + Qdrant/Redis로 테스트 환경을 실행한다.
2. E2E_USER_EMAIL / E2E_USER_PASSWORD, 테스트 Workspace e2e-ws, 해당 질문 Q12/Q13, 원본 Owner 및 별도 수신자 계정을 fixture에 seed한다. 실제 사용자 파일을 쓰지 않는다.
3. `playwright/.auth/`는 gitignore. `pnpm exec playwright install`, `pnpm exec playwright test`.
4. RED 원인이 인프라 오류가 아니라 **아직 구현되지 않은 기대 기능**임을 확인한 뒤 AC 단위로 구현한다. 모든 구현 완료 후 CI GREEN 기준을 적용한다.
5. 동일한 서버 state를 수정하는 병렬 E2E는 격리된 테스트 사용자/데이터로 운영하며 tearDown에서 정리한다.

추가 공유/Fork 테스트:
- `workspaces/sharing-owner.spec.ts`: Owner 링크 발급·Fork 허용·철회
- `workspaces/share-public.spec.ts`: guest 읽기만 허용, 비밀값 제거
- `workspaces/fork.spec.ts`: 로그인된 수신자, Fork ON, 독립 Workspace 생성

각 화면 문서의 AC ID가 E2E title과 1:1 대응하게 확장한다. 예제는 모든 87 AC를 구현한 것이 아니다. 실제 API 보안·Worker 복제·Storage 접근·철회 경쟁 상황은 별도 통합 테스트로 검증한다. 실서비스 토큰·비밀번호·PDF 및 비밀 URL이 Trace/Artifact에 저장되지 않도록 한다.
