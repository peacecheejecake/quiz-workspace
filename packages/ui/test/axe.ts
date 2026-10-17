import axe from 'axe-core';

// Page-level rules do not apply to isolated component renders.
const PAGE_LEVEL_RULES = ['region', 'landmark-one-main', 'page-has-heading-one'];

/** Runs axe over the whole document (portalled layers included) and returns violation ids. */
export async function axeViolations(): Promise<string[]> {
  const results = await axe.run(document.body, {
    rules: Object.fromEntries(PAGE_LEVEL_RULES.map((id) => [id, { enabled: false }])),
  });
  return results.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`,
  );
}
