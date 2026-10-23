# Screen Requirements Index — Platform v1.3

화면별 요구사항의 Source of Truth. 기능 구현 전 AC 문서와 Playwright E2E를 먼저 작성한다. 변경 PR은 Spec ID ↔ Test ID 추적 가능해야 한다.

| ID | Screen | Route | Requirements |
|---|---|---|---|
| AUTH-01 | 로그인 | `/login` | [auth-login.md](auth-login.md) |
| AUTH-02 | 회원가입 | `/signup` | [auth-signup.md](auth-signup.md) |
| AUTH-03 | 이메일 인증 대기 | `/auth/verify` | [auth-verify.md](auth-verify.md) |
| AUTH-04 | 인증 콜백 | `/auth/callback` | [auth-callback.md](auth-callback.md) |
| AUTH-05 | 비밀번호 재설정 요청 | `/forgot-password` | [auth-forgot.md](auth-forgot.md) |
| AUTH-06 | 새 비밀번호 설정 | `/reset-password` | [auth-reset.md](auth-reset.md) |
| AUTH-07 | 인증 오류 안내 | `/auth/error` | [auth-error.md](auth-error.md) |
| ACCOUNT-01 | 계정 보안 설정 | `/settings/security` | [account-security.md](account-security.md) |
| WS-01 | Workspace 목록 | `/workspaces` | [workspaces.md](workspaces.md) |
| DOC-01 | 문서 관리 Floating Dialog | `/workspaces/:workspaceId?panel=documents` | [documents-library.md](documents-library.md) |
| DOC-02 | PDF 열람·원문 교정 | `/workspaces/:workspaceId/documents/:documentId` | [documents-editor.md](documents-editor.md) |
| SEARCH-01 | 통합 검색 (문제·원문) | `/workspaces/:workspaceId?q=:query` | [search.md](search.md) |
| QOV-01 | Workspace 홈 (문제 Heatmap) | `/workspaces/:workspaceId` | [questions-overview.md](questions-overview.md) |
| QBANK-01 | 문제은행 목록·편집 | `/workspaces/:workspaceId/questions/bank` | [questions-bank.md](questions-bank.md) |
| QPLAY-01 | 문제 풀이 Floating Side Panel | `/workspaces/:workspaceId?question=:questionId` | [questions-practice.md](questions-practice.md) |
| QIMPORT-01 | 문제 PDF 가져오기 | `/workspaces/:workspaceId/questions/import` | [questions-import.md](questions-import.md) |
| QGEN-01 | 문제 변형 출제 | `/workspaces/:workspaceId/questions/generate` | [questions-generation.md](questions-generation.md) |
| HISTORY-01 | 이력 Floating Dialog | `/workspaces/:workspaceId?panel=history` | [history-jobs.md](history-jobs.md) |
| WS-SHARE-01 | Workspace 공유 관리 (Owner) | `/workspaces/:workspaceId?panel=share` | [workspace-sharing.md](workspace-sharing.md) |
| WS-VIEW-01 | 공유 Workspace 조회 (Guest) | `/share/:shareId` | [workspace-shared-view.md](workspace-shared-view.md) |
| WS-FORK-01 | 공유 Workspace Fork (Recipient) | `/share/:shareId?panel=fork` | [workspace-fork.md](workspace-fork.md) |

## 공통 규칙

- 총 21개 화면, AC 112개(기존 70개, 공유·Fork 신규 17개, Auth CAPTCHA 신규 8개 — A4, 검색 저하 SEARCH-01-AC06 1개 — M7.4b, 처리 진행 표시 DOC-01-AC05 1개 — UX3-JOB, Workspace 홈 통합 10개 — UX3c: QOV-01-AC07~AC10, SEARCH-01-AC07, DOC-01-AC06, QIMPORT-01-AC05, QGEN-01-AC05, HISTORY-01-AC04, QBANK-01-AC05, UX4 2개: 홈 `문제` 메뉴 QOV-01-AC11, 문제은행 검색·필터 접기·PDF dialog QBANK-01-AC06, 서버 측 문제 추출 시작 1개 — QIMP-AUTO: QIMPORT-01-AC06, 서버 측 등록 1개 — QIMP-JOB: QIMPORT-01-AC07, 교재 챕터 매칭 1개 — CHAPTER-MAP: QIMPORT-01-AC08).
- **Workspace 홈 통합(UX3c 2026-10-20):** Workspace 안에는 왼쪽 메뉴(문서/검색/문제/이력/공유 설정)가 없고 `/workspaces/:workspaceId` 하나가 홈이다(QOV-01). 홈 상단의 Workspace header가 통합 검색과 `문서 n`·`문제`(메뉴: PDF 관리·직접 추가·변형 출제, UX4)·`문제은행` 버튼 묶음, 오른쪽 정렬된 `이력`·`공유하기` 아이콘 버튼 묶음을 갖는다. 문서 관리·문제 PDF 관리·문제 생성·이력·링크 공유는 홈 위에 겹쳐 뜨는 non-modal Floating Dialog(`?panel=documents|question-pdfs|generate|history|share`)이며 나중에 연 dialog가 위에 온다. 통합 검색 상태는 홈 URL(`?q=&scope=…`)에 둔다. 이전 경로(`/documents`, `/search`, `/questions`, `/history`, `/settings/sharing`)는 같은 상태의 홈으로 redirect한다. 실제 페이지로 남는 하위 화면(DOC-02, QBANK-01, QIMPORT-01·QGEN-01의 검토 화면)은 뒤로가기와 breadcrumb을 둔다. 홈과 dialog에는 화면 제목·설명 header가 없다(접근성 `h1`은 시각적으로 숨겨 유지).
- 버튼으로 화면이 바뀌면 UI가 먼저 바뀌고 데이터는 skeleton을 보이는 동안 불러온다(route `loading.tsx`, dialog는 즉시 열리고 내용 skeleton).

- 인증 없는 접근 / 권한 오류 / Workspace archive / deleted / 실패 / 빈 데이터 상태를 정의한다.
- `/workspaces/:workspaceId` 내부에서는 `workspace_id` 권한을 서버에서 확인한다. 클라이언트 필터만으로 데이터 격리를 구현하지 않는다.
- 외부 인증 콜백은 `auth.md`, upload/배포 설정은 `deployment.md`, 상태/marker·변형 정책은 `questions.md`, UI 토큰은 `design-system.md`가 기준이다.
- AC ↔ test mapping은 `e2e-strategy.md` 참조.
