'use client';

// QBANK-01 question detail (FloatingSidePanel): stem, options with correct markers, answers,
// explanation/rubric, source links into the document viewer and the revision history. Editors get
// edit / status / delete actions; the API re-checks every one of them.
import { Badge, Button, CheckIcon, FloatingSidePanel } from '@quiz/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  getQuestionAction,
  getQuestionRevisionAction,
  type QuestionRevision,
} from '@/lib/questions/actions';
import {
  PUBLICATION_STATUS_LABELS,
  QUESTION_TYPE_LABELS,
  type PublicationStatus,
  type Question,
  type QuestionDetail,
} from '@/lib/questions/form';
import type { DocumentOption } from '@/lib/questions/server';
import { documentTitle, formatDateTime, NO_CHAPTER_TITLE, pageText, sourceHref } from './labels';
import styles from './question-bank.module.css';

export interface QuestionDetailPanelProps {
  readonly workspaceId: string;
  /** The list's copy; the panel refreshes it (with revisions) when it opens. Null = closed. */
  readonly question: Question | null;
  readonly onClose: () => void;
  readonly canEdit: boolean;
  readonly documents: readonly DocumentOption[];
  readonly onEdit: (question: Question) => void;
  readonly onStatus: (question: Question, status: PublicationStatus) => void;
  readonly onDelete: (question: Question) => void;
}

export function QuestionDetailPanel({
  workspaceId,
  question,
  onClose,
  canEdit,
  documents,
  onEdit,
  onStatus,
  onDelete,
}: QuestionDetailPanelProps) {
  return (
    <FloatingSidePanel
      open={question !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={question?.question_number ? `${question.question_number}번 문제` : '문제 상세'}
      description={
        question
          ? `${QUESTION_TYPE_LABELS[question.question_type]} · ${question.chapter?.title ?? NO_CHAPTER_TITLE}`
          : undefined
      }
      closeLabel="패널 닫기"
      mobileLayout="full"
      footer={
        question && canEdit ? (
          <div className={styles.panelActions}>
            {question.publication_status === 'DRAFT' ? (
              <Button onClick={() => onStatus(question, 'CONFIRMED')}>확정</Button>
            ) : null}
            {question.publication_status === 'CONFIRMED' ? (
              <>
                <Button asChild>
                  <Link
                    href={`/workspaces/${workspaceId}/questions/generate?source=${encodeURIComponent(question.id)}`}
                  >
                    변형 출제
                  </Link>
                </Button>
                <Button onClick={() => onStatus(question, 'ARCHIVED')}>보관</Button>
              </>
            ) : null}
            {question.publication_status === 'ARCHIVED' ? (
              <Button onClick={() => onStatus(question, 'CONFIRMED')}>보관 해제</Button>
            ) : null}
            <Button onClick={() => onDelete(question)}>삭제</Button>
            <Button variant="primary" onClick={() => onEdit(question)}>
              편집
            </Button>
          </div>
        ) : undefined
      }
    >
      {question ? (
        <DetailBody
          key={`${question.id}:${question.revision.id}`}
          workspaceId={workspaceId}
          question={question}
          documents={documents}
        />
      ) : null}
    </FloatingSidePanel>
  );
}

function DetailBody({
  workspaceId,
  question,
  documents,
}: {
  workspaceId: string;
  question: Question;
  documents: readonly DocumentOption[];
}) {
  const [detail, setDetail] = useState<QuestionDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [past, setPast] = useState<{ id: string; revision: QuestionRevision } | null>(null);
  const [pastError, setPastError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getQuestionAction(workspaceId, question.id).then((result) => {
      if (!live) return;
      if (result.ok) setDetail(result.data);
      else setLoadError(result.message);
    });
    return () => {
      live = false;
    };
  }, [workspaceId, question.id]);

  async function showRevision(revisionId: string) {
    setSelected(revisionId);
    setPastError(null);
    if (revisionId === (detail ?? question).revision.id) {
      setPast(null);
      return;
    }
    const result = await getQuestionRevisionAction(workspaceId, question.id, revisionId);
    if (result.ok) setPast({ id: revisionId, revision: result.data });
    else setPastError(result.message);
  }

  const current = detail ?? question;
  const rev = current.revision;
  return (
    <div className={styles.detail}>
      <div className={styles.itemMeta}>
        <Badge>{QUESTION_TYPE_LABELS[current.question_type]}</Badge>
        <Badge tone={current.publication_status === 'CONFIRMED' ? 'success' : 'warning'}>
          {PUBLICATION_STATUS_LABELS[current.publication_status]}
        </Badge>
        <span>버전 {rev.version}</span>
      </div>
      <RevisionView revision={rev} type={current.question_type} heading="문제" />

      <section className={styles.detailSection} aria-labelledby="qbank-detail-sources">
        <h3 id="qbank-detail-sources" className={styles.detailHeading}>
          출처
        </h3>
        {current.sources.length === 0 ? (
          <p className={styles.detailText}>연결된 출처가 없습니다.</p>
        ) : (
          <ul className={styles.plainList}>
            {current.sources.map((source, i) => {
              const href = sourceHref(workspaceId, source);
              const text =
                `${documentTitle(documents, source.document_id)} ${pageText(source) ?? ''}`.trim();
              return (
                <li key={`${source.document_id ?? 'none'}-${i}`}>
                  {href ? (
                    <Link href={href} className={styles.sourceLink}>
                      {text}
                    </Link>
                  ) : (
                    text
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className={styles.detailSection} aria-labelledby="qbank-detail-history">
        <h3 id="qbank-detail-history" className={styles.detailHeading}>
          수정 이력
        </h3>
        {loadError ? <p role="alert">{loadError}</p> : null}
        {detail ? (
          <ul className={styles.plainList}>
            {detail.revisions.map((r) => {
              const active = r.id === detail.revision.id;
              const pressed = (selected ?? detail.revision.id) === r.id;
              return (
                <li key={r.id}>
                  <Button
                    size="sm"
                    className={styles.revisionButton}
                    aria-pressed={pressed}
                    onClick={() => void showRevision(r.id)}
                  >
                    버전 {r.version}
                    {active ? ' (현재)' : ''} · {formatDateTime(r.created_at)}
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : loadError ? null : (
          <p className={styles.detailText} role="status">
            이력을 불러오는 중입니다.
          </p>
        )}
        {pastError ? <p role="alert">{pastError}</p> : null}
        {past && selected === past.id ? (
          <div className={styles.revisionPreview}>
            <RevisionView
              revision={past.revision}
              type={current.question_type}
              heading={`버전 ${past.revision.version} 내용`}
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}

export function RevisionView({
  revision,
  type,
  heading,
}: {
  revision: QuestionRevision;
  type: Question['question_type'];
  heading: string;
}) {
  const correct = new Set(revision.correct_option_ids ?? []);
  return (
    <>
      <section className={styles.detailSection}>
        <h3 className={styles.detailHeading}>{heading}</h3>
        <p className={styles.detailText}>{revision.stem}</p>
      </section>
      {type === 'MCQ' ? (
        <section className={styles.detailSection}>
          <h3 className={styles.detailHeading}>
            보기{revision.is_multi_answer ? ' (복수 정답)' : ''}
          </h3>
          <ol className={styles.optionList}>
            {revision.options.map((option, i) => {
              const isCorrect = correct.has(option.id);
              return (
                <li key={option.id} className={styles.optionRow} data-correct={isCorrect}>
                  <span className={styles.optionLabel}>{i + 1}.</span>
                  <span className={styles.optionText}>{option.text}</span>
                  {isCorrect ? (
                    <span className={styles.correctMark}>
                      <CheckIcon width={16} height={16} />
                      정답
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {revision.correct_option_ids === null ? (
            <p className={styles.detailText}>정답이 지정되지 않았습니다.</p>
          ) : null}
        </section>
      ) : null}
      {type === 'SHORT_ANSWER' ? (
        <section className={styles.detailSection}>
          <h3 className={styles.detailHeading}>허용 답안</h3>
          <p className={styles.detailText}>
            {revision.accepted_answers?.length
              ? revision.accepted_answers.join(', ')
              : '등록된 허용 답안이 없어 직접 채점합니다.'}
          </p>
        </section>
      ) : null}
      {type === 'ESSAY' ? (
        <section className={styles.detailSection}>
          <h3 className={styles.detailHeading}>채점 기준</h3>
          <p className={styles.detailText}>{revision.rubric || '등록된 채점 기준이 없습니다.'}</p>
        </section>
      ) : null}
      {revision.explanation ? (
        <section className={styles.detailSection}>
          <h3 className={styles.detailHeading}>해설</h3>
          <p className={styles.detailText}>{revision.explanation}</p>
        </section>
      ) : null}
    </>
  );
}
