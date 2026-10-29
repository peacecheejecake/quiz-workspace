# Workspace 공유·Fork — 기능·보안 확정 명세 v1.3

**원칙:** 링크 소지자는 읽기 전용. **원 저작자가 Fork를 명시적으로 허용**했고 수신자가 별도 계정으로 로그인한 경우에만 독립 Workspace Fork 가능. 공유 링크는 Workspace 멤버십이 아니다.

## 1. 정책 및 공개 범위

| 항목 | 기본값·요구사항 |
|---|---|
| 링크 공유 | OFF; Workspace Owner만 발급·회수·만료·재발급 가능 |
| 링크 열람 | 유효 링크를 받은 비로그인 사용자도 조회 허용; 로그인 불필요 |
| Fork | OFF; 링크 단위 `allow_fork` 설정을 Owner만 켤 수 있음 |
| 열람 범위 | Workspace 명세, 발행된(PUBLISHED) PDF/교정 텍스트/목차, 발행된 문제·정답·해설, 범위가 제한된 검색/발췌, 현재 발행 revision의 문서 요약과 장별 최신 정리 노트(DOCSUM-SPEC 2026-10-29, §8) |
| 비공개 범위 | 초안, 미발행 revision, 개인 풀이·즐겨찾기·다시 풀기, owner 프로필, 공유 링크 비밀값, API 키, 관리·작업·활동 기록, 전문 텍스트 내보내기 파일, 이전 revision 요약·이전 버전 노트·요약/노트 생성 상태·오류·비용 |
| 편집 | 링크만 가진 viewer는 업로드·편집·문제 생성·답안 제출·즐겨찾기·삭제·공유 관리 전부 불가 |
| 삭제·보관 | Archive 후 공유 read 유지(Owner revoke 가능); 삭제 요청 이후 공유와 Fork 즉시 거부 |
| Fork 결과 | 현재 published snapshot의 독립 복제; 원본과 자동 동기화 없음; 각 문서·문제 식별자는 새로 발급 |
| 저작권 | Owner에게 PDF·문제의 공유와 복제 허용 권리를 확인하도록 안내. Viewer 권한은 다운로드 방지 DRM을 보장하지 않음 |

## 2. 링크 비밀값과 접근 제어

- 링크 생성 시 최소 32바이트 CSPRNG 비밀값을 생성하고 서버에는 SHA-256/HMAC digest만 저장. 평문은 발급 응답에서 단 한 번 제공. 이후 필요하면 rotate.
- 예시: `https://app.example.com/share/{shareId}#k={secret}`. URL Fragment는 HTTP 요청/Referer에 전달되지 않으며, 클라이언트가 `POST /api/v1/shared/{shareId}/sessions`로 1회 교환한다. 교환 후 fragment 삭제.
- 짧은 수명의 공유 전용 세션을 `HttpOnly; Secure; SameSite=Lax` cookie로 발급한다. 이 세션에는 workspace ID·share ID·읽기 범위만 담고 실제 Supabase 로그인과 혼합하지 않는다.
- 서버는 공유 read 요청마다 현재 share link의 revoked/expired/deleted 상태를 재검증한다. Qdrant Workspace 필터는 서버에서 강제한다.
- 공유 페이지 및 자료 응답 `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `robots=noindex,nofollow`.
- 토큰·JWT·signed Storage URL은 API 로그, analytics, OpenGraph, 예외 출력, Playwright Trace에 남기지 않는다.
- 링크 교환과 Fork 요청에 rate limit, CSRF 및 Origin 보호, Workspace 리소스 ID 소속 확인.
- PDF는 Supabase private bucket에서 공유 세션을 재검증한 후 짧은 signed URL 또는 서버 프록시로 제공한다.

## 3. 역할·권한

| 기능 | Owner | 비로그인 링크 Viewer | 로그인 링크 Viewer, Fork OFF | 로그인 링크 Viewer, Fork ON |
|---|:---:|:---:|:---:|:---:|
| Published 문서·문제·원문 검색 읽기 | ✅ | ✅ | ✅ | ✅ |
| 원본 수정/문제 풀이 저장 | ✅ | ❌ | ❌ | ❌ |
| 공유 링크 설정·철회 | ✅ | ❌ | ❌ | ❌ |
| 개인 상태·이력 조회 | 본인 데이터 | ❌ | ❌ | ❌ |
| 독립 Fork 요청 | Owner 별도 선택 | ❌ | ❌ | ✅ |
| Fork 결과 편집 | — | — | — | 본인 새 Workspace만 |

## 4. DB 및 버전

```sql
workspace_share_links(
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  created_by uuid not null references auth.users(id),
  token_digest bytea not null,
  allow_fork boolean not null default false,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

workspace_forks(
  id uuid primary key,
  source_workspace_id uuid,
  source_share_link_id uuid,
  target_workspace_id uuid not null unique references workspaces(id),
  forked_by uuid not null references auth.users(id),
  source_snapshot_manifest jsonb not null,
  origin_attribution jsonb not null,
  status text not null, -- PENDING/COPYING/COMPLETED/FAILED/CANCELLED
  created_at timestamptz not null,
  completed_at timestamptz
);
```

- `supabase/migrations`를 유일한 DB migration owner로 둔다. FastAPI가 공유 토큰·권한 검사의 유일한 경계다.
- 원본 Workspace 삭제 후 Fork된 Workspace는 계속 존재. Source provenance는 삭제 가능한 FK와 별도의 복제 시점 attribution으로 보존한다.
- Fork는 내부 Workspace ID, document, chapter, question, revision, source references를 새 ID로 remap한다. 원본 개인별 `question_attempts`, `question_user_states`는 복사하지 않는다.

## 5. REST API 계약

Owner 전용:
- `POST /api/v1/workspaces/{id}/share-links`: 비밀 링크 발급; 기본 Fork OFF
- `GET /api/v1/workspaces/{id}/share-links`: 비밀값 없는 링크 메타 조회
- `PATCH /api/v1/workspaces/{id}/share-links/{linkId}`: Fork 허용·만료 수정
- `POST /api/v1/workspaces/{id}/share-links/{linkId}/revoke`: 접근 즉시 철회
- `POST /api/v1/workspaces/{id}/share-links/{linkId}/rotate`: 기존 철회 후 새 비밀 링크 발급

Shared viewer (공유 session에만 허용):
- `POST /api/v1/shared/{shareId}/sessions`: fragment 비밀값을 읽기 전용 세션으로 교환
- `GET /api/v1/shared/{shareId}`: 발행 상태 Workspace·목차·Fork 정책
- `GET /api/v1/shared/{shareId}/documents/{docId}`: 발행 문서
- `GET /api/v1/shared/{shareId}/documents/{docId}/pdf`: private PDF 인증 접근
- `POST /api/v1/shared/{shareId}/search`: 공개 문서 범위의 제한된 검색
- `GET /api/v1/shared/{shareId}/questions`: 발행 문제 목록
- `GET /api/v1/shared/{shareId}/questions/{questionId}`: 발행 문제·해설
- `GET /api/v1/shared/{shareId}/documents/{docId}/summary`: 현재 발행 revision의 성공한 문서 요약(없으면 404, §8)
- `GET /api/v1/shared/{shareId}/chapter-notes`: 최신 정리 노트가 있는 장 목록
- `GET /api/v1/shared/{shareId}/chapters/{chapterId}/note`: 장의 최신 성공 정리 노트(각주는 발행 문제만 링크)

Fork (공유 session + **Supabase 사용자 JWT** 동시 필요):
- `POST /api/v1/shared/{shareId}/forks`: 이름·멱등 키; 202 Accepted + job id
- `GET /api/v1/me/forks/{forkId}`: 본인 Fork 진행 상태만 조회

## 6. 비동기 Fork 처리

1. 수신자는 유효한 공유 페이지에서 Fork ON 정책을 확인하고 로그인한다. 로그인 후에도 share session과 `allow_fork`를 서버에서 다시 검증한다.
2. 서버는 복제 권한·용량·쿼터·멱등성을 확인하고 원본의 현재 **published revision IDs**를 immutable snapshot manifest에 고정한다.
3. `workspace_forks(PENDING)`과 Celery job을 생성한다. Worker는 새 Workspace를 비공개 상태로 만들고 PDF·문서·목차·정답·해설·문제들을 별도 storage prefix와 새로운 ID로 복제한다.
4. 개인별 풀이, Favorite/Retry, Owner 활동 로그, 공유 설정, draft는 제외한다. 문제 lineage와 source references는 새 ID로 매핑한다.
5. 커밋 직전 링크 revoke/expire 및 allow_fork OFF 여부를 다시 검사한다. 도중 철회되면 Fork는 CANCELLED하고 임시 DB·Storage 복제물을 청소한다.
6. 성공 시에만 target Workspace를 ACTIVE로 공개하며 `COMPLETED` 기록. 완료된 복제본은 원본 링크 철회/삭제의 영향을 받지 않는다.

## 7. Screen-first E2E 및 릴리스

화면 3개 추가: [Owner 공유 관리](screens/workspace-sharing.md), [게스트 읽기](screens/workspace-shared-view.md), [수신자 Fork](screens/workspace-fork.md).

AC 5+6+6=17개를 각각 Playwright로 먼저 RED 테스트로 작성한다. 검증 시나리오:
- 일반 비로그인 Workspace URL 401 vs 유효 공유 링크만 읽기 허용
- 잘못된 secret / revoke / expire / delete 이후 **기존 공유 세션까지** 차단
- 타 Workspace ID·비발행 revision·개인별 진도·쓰기 API 차단
- allow_fork OFF, 비로그인 사용자, 잘못된 링크는 Fork 거부
- Fork 승인·완료 후 데이터 복제와 ID 재매핑·개인 상태 초기화
- 작업 중 철회는 취소 및 리소스 정리, 완료 후 철회는 Fork 데이터 유지
- 토큰/URL 및 개인정보 유출 방지, 복제 및 공유·저작권 안내

개발 순서: S0(명세/E2E) → S1(share API/인가) → S2(공유 UI) → S3(Fork Worker) → S4(보안·성능·배포 검증). M3/M4 및 Auth A 트랙 의존.

## 8. 문서 요약·정리 노트·텍스트 내보내기 (DOCSUM-SPEC 2026-10-29)

원칙은 §1과 같다: 게스트는 **발행된 것만, 읽기만** 한다.

| 기능 | Owner·editor | viewer(멤버) | 링크 게스트 |
|---|:---:|:---:|:---:|
| 문서 요약 읽기 | ✅ 마지막 성공 요약(+stale) | ✅ 같음 | 현재 발행 revision의 성공 요약만 |
| 요약 만들기·다시 시도 | ✅ 활성 Workspace | ❌ | ❌ |
| 정리 노트 읽기 | ✅ 모든 버전 | ✅ 모든 버전 | 장마다 최신 성공 버전만 |
| 정리 노트 만들기·다시 만들기 | ✅ 활성 Workspace | ❌ | ❌ |
| 전문 텍스트 내보내기 | ✅ 발행본·초안 | ✅ 발행본 | ❌ |

- **결정(2026-10-29):** 요약은 발행 원문에서, 정리 노트는 발행 문제·정답·해설에서 만든 파생 내용이라 게스트에게도 원본과 같은 범위로 보인다. 요약은 게스트가 지금 읽을 수 있는 발행 revision과 일치할 때만 준다(이전 revision 요약은 이미 바뀐 원문을 담을 수 있으므로 404). 텍스트 내보내기는 사용자 결정 Q9로 멤버 전용이다(게스트는 화면에서 원문을 읽을 수만 있다; DRM 아님 — §1 저작권 행).
- 공유 응답은 §2의 header(`no-store`, `no-referrer`)를 따르고, 생성 상태·오류 코드·usage·job id·`question_refs`의 revision id를 주지 않는다. 매 요청 링크 상태를 재검증하므로 철회 후에는 이미 열린 panel의 요청도 거부된다.
- Fork는 요약(현재 snapshot revision의 성공 요약과 opt-in)과 장마다 최신 정리 노트를 새 id로 복제한다(§6 개인 데이터 제외 규칙 유지; 이전 기록·실패 run·usage 제외).
