// Korean copy for WS-VIEW-01 failures (pure, unit-tested). Messages never quote a URL, the link
// secret or a server error body.
import { SharedApiError } from './client';

export function sharedFailureMessage(error: unknown): string {
  if (!(error instanceof SharedApiError)) {
    return '공유된 내용을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
  }
  switch (error.kind) {
    case 'network':
      return '서버에 연결하지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요.';
    case 'rateLimited':
      return error.retryAfterSeconds !== undefined
        ? `요청이 너무 많습니다. ${Math.max(error.retryAfterSeconds, 1)}초 후에 다시 시도해 주세요.`
        : '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
    case 'notFound':
      return '요청한 내용을 찾을 수 없습니다. 공유되지 않았거나 더 이상 볼 수 없는 항목입니다.';
    case 'unavailable':
    case 'sessionRequired':
      return '링크를 사용할 수 없습니다.';
    default:
      return '공유된 내용을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
  }
}

/** True when the whole share view must switch to the "unavailable" notice. */
export function endsShareView(error: unknown): boolean {
  return (
    error instanceof SharedApiError &&
    (error.kind === 'unavailable' || error.kind === 'sessionRequired')
  );
}
