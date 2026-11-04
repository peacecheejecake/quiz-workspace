'use client';

// ASK-01 문제 쪽 진입점 (docs/screens/ask-llm.md "문제 쪽 진입점", ASK-Q): the "open AI 질문 with
// this question attached" API of the workspace home. The home provides it (WorkspaceHome); the
// question screens read it — QuestionViewer `manage` (문제 상세 footer), `sequence(mock)` and
// `manage(mock)` (headers) through `AskQuestionButton`, and AIEXPL-01's `AI 질문하기`
// (EXPL-W) through `useAskLauncher`. Without a provider (the shared view, stories) or where new
// questions are not possible (feature off, archived workspace) there is no launcher: no button.
//
// `open` creates a new conversation with the attachment (the server checks it and computes its
// disclosure: nothing here sends one) and shows it in the AI 질문 panel on top of every open modal
// layer, holding focus; closing it returns focus to `opener`.
import { Button } from '@quiz/ui';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AskAttachmentInput, Conversation } from '@/lib/ask/client';

export interface AskLauncher {
  /** Opens a new conversation with `attachment`; resolves once the panel shows it (or failed). */
  readonly open: (attachment: AskAttachmentInput, opener: HTMLElement | null) => Promise<void>;
}

const AskLauncherContext = createContext<AskLauncher | null>(null);

export function AskLauncherProvider({
  launcher,
  children,
}: {
  /** Null where the question-side entry points are hidden (feature off, archived, loading). */
  readonly launcher: AskLauncher | null;
  readonly children: ReactNode;
}) {
  return <AskLauncherContext.Provider value={launcher}>{children}</AskLauncherContext.Provider>;
}

/** The home's launcher, or null where questions cannot be attached here. */
export function useAskLauncher(): AskLauncher | null {
  return useContext(AskLauncherContext);
}

/** What a finished, still current launch hands the home: the created conversation (or null). */
export interface AskLaunched {
  readonly conversation: Conversation | null;
  readonly opener: HTMLElement | null;
}

/**
 * The home's launcher: `create` makes the conversation, then `show` opens the panel on it — but
 * only while the launch is still current. A creation that finishes after the user moved on (the
 * question dialog closed so its 질문하기 left the page, the address changed — another panel or
 * workspace —, the home unmounted, or a newer 질문하기) opens nothing and touches no history; the
 * conversation stays on the server, empty (hidden from the 대화 목록).
 */
export function useGuardedAskLaunch(
  create: (attachment: AskAttachmentInput) => Promise<Conversation | null>,
  show: (launched: AskLaunched) => void,
): AskLauncher {
  const latest = useRef({ create, show });
  useEffect(() => {
    latest.current = { create, show };
  });
  const mounted = useRef(true);
  const epoch = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current += 1;
    };
  }, []);
  const [launcher] = useState<AskLauncher>(() => ({
    open: async (attachment, opener) => {
      const mine = ++epoch.current;
      const address = `${window.location.pathname}${window.location.search}`;
      const conversation = await latest.current.create(attachment).catch(() => null);
      const current =
        mounted.current &&
        epoch.current === mine &&
        `${window.location.pathname}${window.location.search}` === address &&
        (opener === null || opener.isConnected);
      if (current) latest.current.show({ conversation, opener });
    },
  }));
  return launcher;
}

export interface AskQuestionButtonProps {
  /** What to attach; null renders nothing (e.g. the position's session is not open yet). */
  readonly attachment: AskAttachmentInput | null;
  /** Visible text (default "질문하기"). */
  readonly children?: ReactNode;
  /** Accessible name (default "이 문제로 AI에게 질문하기"). */
  readonly label?: string;
  readonly size?: 'sm' | 'md';
  readonly variant?: 'primary' | 'secondary' | 'ghost';
}

/** `질문하기` of a question screen (ASK-01 공통: accessible name "이 문제로 AI에게 질문하기"). */
export function AskQuestionButton({
  attachment,
  children = '질문하기',
  label = '이 문제로 AI에게 질문하기',
  size = 'sm',
  variant = 'secondary',
}: AskQuestionButtonProps) {
  const launcher = useAskLauncher();
  const [busy, setBusy] = useState(false);
  if (!launcher || !attachment) return null;
  return (
    <Button
      size={size}
      variant={variant}
      aria-label={label}
      aria-busy={busy || undefined}
      onClick={(event) => {
        if (busy) return;
        const opener = event.currentTarget;
        setBusy(true);
        void launcher.open(attachment, opener).finally(() => setBusy(false));
      }}
    >
      {children}
    </Button>
  );
}
