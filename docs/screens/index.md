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
| WS-01 | Workspace 홈 | `/workspaces` | [workspaces.md](workspaces.md) |
| DOC-01 | Documents 목록·업로드 | `/workspaces/:workspaceId/documents` | [documents-library.md](documents-library.md) |
| DOC-02 | PDF 열람·원문 교정 | `/workspaces/:workspaceId/documents/:documentId` | [documents-editor.md](documents-editor.md) |
| SEARCH-01 | 다국어 원문 검색 | `/workspaces/:workspaceId/search` | [search.md](search.md) |
| QOV-01 | Questions Heatmap 홈 | `/workspaces/:workspaceId/questions` | [questions-overview.md](questions-overview.md) |
| QBANK-01 | 문제은행 목록·편집 | `/workspaces/:workspaceId/questions/bank` | [questions-bank.md](questions-bank.md) |
| QPLAY-01 | 문제 풀이 Floating Side Panel | `/workspaces/:workspaceId/questions?question=:questionId` | [questions-practice.md](questions-practice.md) |
| QIMPORT-01 | 문제 PDF 가져오기 | `/workspaces/:workspaceId/questions/import` | [questions-import.md](questions-import.md) |
| QGEN-01 | 문제 변형 출제 | `/workspaces/:workspaceId/questions/generate` | [questions-generation.md](questions-generation.md) |
| HISTORY-01 | 작업·변경·풀이 이력 | `/workspaces/:workspaceId/history` | [history-jobs.md](history-jobs.md) |

| WS-SHARE-01 | Workspace 공유 관리 (Owner) | `/workspaces/:workspaceId/settings/sharing` | [workspace-sharing.md](workspace-sharing.md) |
| WS-VIEW-01 | 공유 Workspace 조회 (Guest) | `/share/:shareId` | [workspace-shared-view.md](workspace-shared-view.md) |
| WS-FORK-01 | 공유 Workspace Fork (Recipient) | `/share/:shareId?panel=fork` | [workspace-fork.md](workspace-fork.md) |

## 공통 규칙

- 총 21개 화면, AC 97개(기존 70개, 공유·Fork 신규 17개, Auth CAPTCHA 신규 8개 — A4, 검색 저하 SEARCH-01-AC06 1개 — M7.4b, 처리 진행 표시 DOC-01-AC05 1개 — UX3-JOB).

- 인증 없는 접근 / 권한 오류 / Workspace archive / deleted / 실패 / 빈 데이터 상태를 정의한다.
- `/workspaces/:workspaceId` 내부에서는 `workspace_id` 권한을 서버에서 확인한다. 클라이언트 필터만으로 데이터 격리를 구현하지 않는다.
- 외부 인증 콜백은 `auth.md`, upload/배포 설정은 `deployment.md`, 상태/marker·변형 정책은 `questions.md`, UI 토큰은 `design-system.md`가 기준이다.
- AC ↔ test mapping은 `e2e-strategy.md` 참조.