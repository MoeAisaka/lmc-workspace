/** Scoped to prose blocks, so switching layout never rewrites a saved font or
 * changes the navigation, user bubbles, code grid, or status colors. Nested
 * spans inherit these metrics; inline emphasis keeps its own semantic style. */
export const readingStyles = `
[data-lmc-prose] { min-width: 0; overflow-wrap: anywhere; }
/* Mail is supporting material: 14px against the reply's 16px. Capture the
 * user's scale on the card before overriding it inside prose. Nested quotes
 * and details inherit the same value, rather than shrinking a second time.
 * Card labels, evidence and touch targets keep their existing metrics. */
[data-lmc-mail] { --lmc-mail-text-scale: calc(var(--lmc-text-scale, 1) * 0.875); }
[data-lmc-mail] [data-lmc-prose] { --lmc-text-scale: var(--lmc-mail-text-scale); }
[data-lmc-heading] { text-wrap: balance; }
[data-lmc-prose] > [data-lmc-block="quote"] { border-left: 3px solid var(--lmc-prose-divider); padding: 4px 16px; margin: 12px 0; }
[data-lmc-prose] > [data-lmc-block="quote"] > [data-lmc-prose] > :first-child { margin-top: 0; }
[data-lmc-prose] > [data-lmc-block="quote"] > [data-lmc-prose] > :last-child { margin-bottom: 0; }
[data-lmc-mail-section] [data-lmc-prose] > :first-child { margin-top: 0; }
[data-lmc-mail-section] [data-lmc-prose] > :last-child { margin-bottom: 0; }
[data-lmc-mail-section] [data-lmc-block="list"] { gap: 10px; }
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"],
html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] { max-width: 100%; }
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] > [data-lmc-block="paragraph"],
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] > [data-lmc-block="list"] {
  font-size: calc(16px * var(--lmc-text-scale, 1)); line-height: calc(28px * var(--lmc-text-scale, 1) * var(--lmc-line-scale, 1)); margin-top: 10px; margin-bottom: 18px;
}
html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] > [data-lmc-block="paragraph"],
html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] > [data-lmc-block="list"] {
  font-size: calc(16px * var(--lmc-text-scale, 1)); line-height: calc(28px * var(--lmc-text-scale, 1) * var(--lmc-line-scale, 1)); margin-top: 8px; margin-bottom: 14px;
}
html:not([data-lmc-reading-style="standard"]) [data-lmc-prose="prose"] > [data-lmc-block="list"] [data-lmc-list-text] { font-size: inherit; line-height: inherit; }
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] > [data-lmc-block="list"] { gap: 12px; }
html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] > [data-lmc-block="list"] { gap: 8px; }
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] > [data-lmc-heading] { margin-top: 28px; margin-bottom: 12px; }
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] > [data-lmc-heading="1"] {
  font-size: calc(30px * var(--lmc-text-scale, 1)); line-height: calc(39px * var(--lmc-text-scale, 1) * var(--lmc-line-scale, 1)); font-weight: 700;
}
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] > [data-lmc-heading="1"]::before { content: ""; display: block; width: 32px; height: 3px; margin-bottom: 14px; background: var(--lmc-prose-accent); }
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] > [data-lmc-heading="2"] { font-size: calc(23px * var(--lmc-text-scale, 1)); line-height: calc(32px * var(--lmc-text-scale, 1) * var(--lmc-line-scale, 1)); }
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] > [data-lmc-heading="3"] { font-size: calc(19px * var(--lmc-text-scale, 1)); line-height: calc(28px * var(--lmc-text-scale, 1) * var(--lmc-line-scale, 1)); }
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] > [data-lmc-block="quote"] { border-color: var(--lmc-prose-accent); background: var(--lmc-prose-tint); border-radius: 0 8px 8px 0; padding: 14px 18px; margin: 20px 0; }
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] > [data-lmc-block="rule"] { width: 48px; height: 2px; background: var(--lmc-prose-accent); margin: 24px 0; }
html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] > [data-lmc-heading] { margin-top: 24px; margin-bottom: 10px; }
html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] > [data-lmc-heading="1"] { font-size: calc(25px * var(--lmc-text-scale, 1)); line-height: calc(35px * var(--lmc-text-scale, 1) * var(--lmc-line-scale, 1)); font-weight: 700; padding-bottom: 12px; border-bottom: 1px solid var(--lmc-prose-divider); }
html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] > [data-lmc-heading="2"] { font-size: calc(20px * var(--lmc-text-scale, 1)); line-height: calc(29px * var(--lmc-text-scale, 1) * var(--lmc-line-scale, 1)); padding-bottom: 8px; border-bottom: 1px solid var(--lmc-prose-divider); }
html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] > [data-lmc-heading="3"] { font-size: calc(17px * var(--lmc-text-scale, 1)); line-height: calc(26px * var(--lmc-text-scale, 1) * var(--lmc-line-scale, 1)); }
html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] > [data-lmc-block="quote"] { border-left-width: 2px; padding: 8px 18px; margin: 18px 0; }
html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] > [data-lmc-block="rule"] { margin: 22px 0; }
@media (min-width: 900px) {
  html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] { max-width: 760px; }
  html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] { max-width: 700px; }
}
`;
