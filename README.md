# Quiz Workspace

PDF 책 기반 다국어 검색·문제 관리 플랫폼 — **설계 v1.3** (2026-10-16)

> 현재 저장소는 요구사항·설계·선행 E2E 테스트 초안을 담고 있습니다. 서비스 구현은 아직 진행되지 않았습니다.

## 구성

- **Core (Python):** Docling PDF 구조화, 계층형 청킹, Qwen3 다국어 Embedding, Qdrant Dense/BM25 + RRF, Reranker, 근거 발췌, 문제 PDF 추출과 변형. 범용 RAG 챗봇은 제외.
- **Service API (FastAPI):** Supabase Auth 및 JWT 검증, Workspace/문서/문제, 이력, Celery Worker, 링크 공유와 허가된 Fork.
- **Frontend (Next.js):** Workspace, PDF 보기·텍스트 교정, 다국어 검색, 문제은행/풀이/히트맵, Floating Side Panel, Minimal Glass 디자인 시스템.
- **배포:** Vercel + Supabase(Auth·PostgreSQL·Storage) + Python 서비스/Worker + Qdrant + Redis.

## v1.3 확정 사항

- 공유 링크 소지자: 로그인 없이 **읽기 전용**, 쓰기 권한 없음.
- 원 저작자가 Fork를 허용한 경우: 로그인한 수신자는 독립 Workspace로 published snapshot 복제 가능. 원본과 동기화하지 않고 개인 풀이 기록은 복제하지 않음.
- 문제 Heatmap: 문제 하나 = 상태색 1개 마커. 일반 문제는 둥근 사각형, 즐겨찾기는 **같은 색의 둥근 별**. Hover/Focus 때만 확대.
- 개발 절차: **화면 명세 → Playwright E2E 선작성(RED) → 구현(GREEN) → 검증**.

## 설계 문서

- [아키텍처](docs/architecture.md)
- [Workspace 공유·Fork 및 보안](docs/workspace-sharing.md)
- [인증](docs/auth.md)
- [Questions](docs/questions.md)
- [디자인 시스템](docs/design-system.md)
- [배포](docs/deployment.md)
- [E2E 전략](docs/e2e-strategy.md)
- [화면별 명세 목록](docs/screens/index.md)

설계 상태: **요구사항 확정 / 애플리케이션 미구현 / E2E 초안 미실행**.
