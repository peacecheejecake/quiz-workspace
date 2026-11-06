// UX12-STEMTABLE: a stem table edited as a table. Every cell has a named input; rows and columns
// are added and removed from menus on their headers, so keyboard and touch use the same path.
// Merged cells stay one input: `stem-table-edit.ts` keeps their spans through every change.
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  MoreIcon,
} from '@quiz/ui';
import { tableGrid } from '@/lib/documents/table-grid';
import type { QuestionFormValues } from '@/lib/questions/form';
import {
  applyTableEdit,
  cellLabel,
  editableStemTables,
  insertColumn,
  insertRow,
  removeColumn,
  removeRow,
  setCell,
  type StemCells,
} from '@/lib/questions/stem-table-edit';
import styles from './stem-table-editor.module.css';

interface LineAction {
  readonly label: string;
  readonly disabled?: boolean;
  readonly run: () => void;
}

function LineMenu({
  label,
  actions,
}: {
  readonly label: string;
  readonly actions: readonly LineAction[];
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <IconButton label={label} icon={<MoreIcon />} size="sm" />
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label={label}>
        {actions.map((action) => (
          <DropdownMenuItem key={action.label} disabled={action.disabled} onSelect={action.run}>
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StemTableEditor({
  index,
  cells,
  fellBack,
  onChange,
}: {
  readonly index: number;
  readonly cells: StemCells;
  readonly fellBack: boolean;
  readonly onChange: (next: StemCells) => void;
}) {
  const name = `표 ${index + 1}`;
  const width = cells.rows[0]?.length ?? 0;
  const height = cells.rows.length;
  return (
    <div className={styles.editor}>
      {fellBack ? <p className={styles.note}>병합 정보 없이 글자 표로 편집합니다.</p> : null}
      {/* A keyboard user scrolls the region, so it takes focus. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div role="region" aria-label={`${name} 편집`} tabIndex={0} className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <td />
              {Array.from({ length: width }, (_, col) => (
                <th key={col} scope="col">
                  <LineMenu
                    label={`${name} ${col + 1}열 메뉴`}
                    actions={[
                      { label: '왼쪽에 열 추가', run: () => onChange(insertColumn(cells, col)) },
                      {
                        label: '오른쪽에 열 추가',
                        run: () => onChange(insertColumn(cells, col + 1)),
                      },
                      {
                        label: '이 열 삭제',
                        disabled: width <= 1,
                        run: () => onChange(removeColumn(cells, col)),
                      },
                    ]}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tableGrid(cells).map((row, r) => (
              // Table rows and cells have no ids; their position is their identity.
              <tr key={r}>
                <th scope="row">
                  <LineMenu
                    label={`${name} ${r + 1}행 메뉴`}
                    actions={[
                      { label: '위에 행 추가', run: () => onChange(insertRow(cells, r)) },
                      { label: '아래에 행 추가', run: () => onChange(insertRow(cells, r + 1)) },
                      {
                        label: '이 행 삭제',
                        disabled: height <= 1,
                        run: () => onChange(removeRow(cells, r)),
                      },
                    ]}
                  />
                </th>
                {row.map(({ col, text, rowSpan, colSpan }) => (
                  <td key={col} rowSpan={rowSpan} colSpan={colSpan}>
                    <textarea
                      className={styles.cell}
                      rows={1}
                      aria-label={cellLabel(index, {
                        row: r,
                        col,
                        ...(rowSpan ? { rowSpan } : {}),
                        ...(colSpan ? { colSpan } : {}),
                      })}
                      autoComplete="off"
                      value={text}
                      onChange={(e) => onChange(setCell(cells, r, col, e.target.value))}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One editor per table of the stem; nothing for a stem without one. */
export function StemTableFields({
  values,
  update,
}: {
  readonly values: QuestionFormValues;
  readonly update: (next: QuestionFormValues, clearKeys?: readonly string[]) => void;
}) {
  const tables = editableStemTables(values.stem, values.stemTables);
  if (tables.length === 0) return null;
  return (
    <>
      {tables.map(({ cells, fellBack }, index) => (
        <StemTableEditor
          // Tables have no ids; their order in the stem is their identity.
          key={index}
          index={index}
          cells={cells}
          fellBack={fellBack}
          onChange={(next) =>
            update({ ...values, ...applyTableEdit(values.stem, values.stemTables, index, next) }, [
              'stem',
            ])
          }
        />
      ))}
    </>
  );
}
