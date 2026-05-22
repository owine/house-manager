import axe from 'axe-core';

const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// Rules requiring full-document context — meaningless for an isolated component
// rendered by Testing Library, so disabled to avoid false positives. Page-level
// coverage of these lives in the Phase 2 axe page scans.
const DOCUMENT_RULES_OFF: Record<string, { enabled: false }> = {
  region: { enabled: false },
  'landmark-one-main': { enabled: false },
  'page-has-heading-one': { enabled: false },
  'document-title': { enabled: false },
  'html-has-lang': { enabled: false },
  bypass: { enabled: false },
};

/**
 * Assert no WCAG 2.1 AA axe violations. Defaults to scanning `document.body` —
 * where Testing Library mounts everything INCLUDING portaled content (Base UI
 * dialogs/popovers portal out of the RTL `container`, so scanning `container`
 * would miss them).
 */
export async function expectNoAxeViolations(container: HTMLElement = document.body): Promise<void> {
  const results = await axe.run(
    {
      include: [container],
      // Base UI Dialog/Popover render internal focus-trap sentinel spans
      // (`role="button"` with no name). They're framework plumbing, not author
      // markup or user-operable commands, so exclude them rather than disable
      // the `aria-command-name` rule (which must stay active for real buttons).
      exclude: [['[data-base-ui-focus-guard]']],
    },
    {
      runOnly: { type: 'tag', values: WCAG_AA },
      rules: DOCUMENT_RULES_OFF,
    },
  );
  if (results.violations.length > 0) {
    const summary = results.violations
      .map(
        (v) =>
          `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
      )
      .join('\n');
    throw new Error(`axe found ${results.violations.length} violation(s):\n${summary}`);
  }
}
