/** Scoped to prose blocks, so switching layout never rewrites a saved font or
 * changes the navigation, user bubbles, code grid, or status colors. Nested
 * spans inherit these metrics; inline emphasis keeps its own semantic style. */
export const readingStyles = `
[data-lmc-prose] { min-width: 0; overflow-wrap: anywhere; line-height: 1.75; }
[data-lmc-prose] { font-feature-settings: "kern" 1, "liga" 1; -webkit-font-smoothing: antialiased; }
/* Mail is supporting material: 14px against the reply's 16px. Capture the
 * user's scale on the card before overriding it inside prose. Nested quotes
 * and details inherit the same value, rather than shrinking a second time.
 * Card labels, evidence and touch targets keep their existing metrics. */
[data-lmc-mail] { --lmc-mail-text-scale: calc(var(--lmc-text-scale, 1) * 0.875); }
[data-lmc-mail] [data-lmc-prose] { --lmc-text-scale: var(--lmc-mail-text-scale); }
[data-lmc-heading] { text-wrap: balance; letter-spacing: -0.015em; }
[data-lmc-prose] > :first-child { margin-top: 0 !important; }
[data-lmc-prose] > :last-child { margin-bottom: 0 !important; }

/* Inline code capsule & interactive links */
[data-lmc-inline-code="true"] {
  padding: 1.5px 6px;
  margin: 0 1.5px;
  border-radius: 5px;
  background: var(--lmc-prose-tint, rgba(127, 127, 127, 0.1));
  border: 1px solid var(--lmc-prose-divider, rgba(127, 127, 127, 0.18));
  font-size: calc(14px * var(--lmc-text-scale, 1)) !important;
  line-height: calc(22px * var(--lmc-text-scale, 1) * var(--lmc-line-scale, 1)) !important;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
[data-lmc-prose="prose"] [data-lmc-link="true"]:not([data-lmc-inline-code="true"]) {
  color: var(--lmc-prose-accent, #0060F0) !important;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  text-decoration-color: color-mix(in srgb, var(--lmc-prose-accent, #0060F0) 45%, transparent);
  transition: text-decoration-color 140ms ease, opacity 140ms ease;
}
[data-lmc-prose="prose"] [data-lmc-link="true"]:not([data-lmc-inline-code="true"]):hover {
  text-decoration-color: var(--lmc-prose-accent, #0060F0);
}
[data-lmc-prose="prose"] [data-lmc-link="true"][data-lmc-inline-code="true"] {
  color: var(--lmc-prose-accent, #0060F0) !important;
  text-decoration: none !important;
  border-color: color-mix(in srgb, var(--lmc-prose-accent, #0060F0) 34%, var(--lmc-prose-divider, transparent));
  background: color-mix(in srgb, var(--lmc-prose-accent, #0060F0) 7%, var(--lmc-prose-tint, transparent));
  transition: background-color 140ms ease, border-color 140ms ease;
}
[data-lmc-prose="prose"] [data-lmc-link="true"][data-lmc-inline-code="true"]:hover {
  border-color: var(--lmc-prose-accent, #0060F0);
  background: color-mix(in srgb, var(--lmc-prose-accent, #0060F0) 14%, var(--lmc-prose-tint, transparent));
}
[data-lmc-prose="plain"] [data-lmc-link="true"] {
  text-underline-offset: 3px;
  text-decoration-thickness: 1px;
}

/* KaTeX math blocks & inline expressions */
.katex .katex-mathml {
  position: absolute;
  clip: rect(1px, 1px, 1px, 1px);
  clip-path: inset(50%);
  padding: 0;
  border: 0;
  height: 1px;
  width: 1px;
  overflow: hidden;
}
.lmc-math-block {
  display: block;
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 6px 2px;
  box-sizing: border-box;
}
.lmc-math-block .katex-display {
  margin: 0 auto;
  width: max-content;
  max-width: none;
}
.lmc-math-inline { display: inline; }
.lmc-math-inline-display {
  display: inline-block;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  vertical-align: middle;
  padding: 2px 0;
}
.lmc-math-inline-display .katex-display { margin: 0; }
[data-lmc-prose] .katex { font-size: 1.08em; color: inherit; }
[data-lmc-prose] .katex .cjk_fallback {
  font-family: var(--lmc-font-regular, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif);
  font-size: 0.92em;
}
[data-lmc-prose] .katex .mathbf .cjk_fallback,
[data-lmc-prose] .katex .textbf .cjk_fallback {
  font-family: var(--lmc-font-semiBold, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif);
  font-weight: 600;
  font-synthesis: weight;
}

/* Lists, blockquotes, tables & callouts */
[data-lmc-list-text="marker"] { font-variant-numeric: tabular-nums; user-select: none; }
[data-lmc-prose] > [data-lmc-block="quote"] {
  border-left: 3px solid color-mix(in srgb, var(--lmc-prose-accent, #666) 55%, var(--lmc-prose-divider));
  background: color-mix(in srgb, var(--lmc-prose-tint, transparent) 55%, transparent);
  border-radius: 0 8px 8px 0;
  padding: 10px 16px;
  margin: 14px 0;
}
[data-lmc-prose] > [data-lmc-block="quote"] > [data-lmc-prose] > :first-child { margin-top: 0; }
[data-lmc-prose] > [data-lmc-block="quote"] > [data-lmc-prose] > :last-child { margin-bottom: 0; }
[data-lmc-table-row="odd"] { background: color-mix(in srgb, var(--lmc-prose-tint, transparent) 42%, transparent); }
[data-lmc-prose="prose"] > [data-lmc-heading="1"] {
  padding-bottom: 8px;
  border-bottom: 1px solid var(--lmc-prose-divider);
}
[data-lmc-mail-section] [data-lmc-prose] > :first-child { margin-top: 0; }
[data-lmc-mail-section] [data-lmc-prose] > :last-child { margin-bottom: 0; }
[data-lmc-mail-section] [data-lmc-block="list"] { gap: 10px; }

/* Reading style presets: editorial & academic */
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"],
html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] { max-width: 100%; }
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] > [data-lmc-block="paragraph"],
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] > [data-lmc-block="list"] {
  font-size: calc(16px * var(--lmc-text-scale, 1)); line-height: calc(28px * var(--lmc-text-scale, 1) * var(--lmc-line-scale, 1)); margin-top: 10px; margin-bottom: 18px;
}
html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] > [data-lmc-block="paragraph"],
html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] > [data-lmc-block="list"] {
  font-size: calc(16px * var(--lmc-text-scale, 1)); line-height: calc(28px * var(--lmc-text-scale, 1) * var(--lmc-line-scale, 1)); margin-top: 9px; margin-bottom: 16px;
}
html:not([data-lmc-reading-style="standard"]) [data-lmc-prose="prose"] > [data-lmc-block="list"] [data-lmc-list-text] { font-size: inherit; line-height: inherit; }
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] > [data-lmc-block="list"] { gap: 12px; }
html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] > [data-lmc-block="list"] { gap: 10px; }
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] > [data-lmc-heading] { margin-top: 26px; margin-bottom: 12px; }
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] > [data-lmc-heading="1"] {
  font-size: calc(28px * var(--lmc-text-scale, 1)); line-height: calc(38px * var(--lmc-text-scale, 1) * var(--lmc-line-scale, 1)); font-weight: 700; border-bottom: none; padding-bottom: 0;
}
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] > [data-lmc-heading="1"]::before { content: ""; display: block; width: 32px; height: 3px; margin-bottom: 12px; border-radius: 2px; background: var(--lmc-prose-accent); }
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] > [data-lmc-heading="2"] { font-size: calc(22px * var(--lmc-text-scale, 1)); line-height: calc(31px * var(--lmc-text-scale, 1) * var(--lmc-line-scale, 1)); }
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] > [data-lmc-heading="3"] { font-size: calc(18.5px * var(--lmc-text-scale, 1)); line-height: calc(27px * var(--lmc-text-scale, 1) * var(--lmc-line-scale, 1)); }
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] > [data-lmc-block="quote"] { border-color: var(--lmc-prose-accent); background: var(--lmc-prose-tint); border-radius: 0 10px 10px 0; padding: 14px 18px; margin: 18px 0; }
html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] > [data-lmc-block="rule"] { width: 56px; height: 2px; border-radius: 2px; background: var(--lmc-prose-accent); margin: 22px 0; opacity: 0.75; }
html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] > [data-lmc-heading] { margin-top: 24px; margin-bottom: 10px; }
html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] > [data-lmc-heading="1"] { font-size: calc(25px * var(--lmc-text-scale, 1)); line-height: calc(35px * var(--lmc-text-scale, 1) * var(--lmc-line-scale, 1)); font-weight: 700; padding-bottom: 10px; border-bottom: 1px solid var(--lmc-prose-divider); }
html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] > [data-lmc-heading="2"] { font-size: calc(20px * var(--lmc-text-scale, 1)); line-height: calc(29px * var(--lmc-text-scale, 1) * var(--lmc-line-scale, 1)); padding-bottom: 6px; border-bottom: 1px solid var(--lmc-prose-divider); }
html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] > [data-lmc-heading="3"] { font-size: calc(17px * var(--lmc-text-scale, 1)); line-height: calc(26px * var(--lmc-text-scale, 1) * var(--lmc-line-scale, 1)); }
html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] > [data-lmc-block="quote"] { border-left-width: 2px; padding: 10px 18px; margin: 16px 0; }
html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] > [data-lmc-block="rule"] { margin: 20px 0; }
@media (min-width: 900px) {
  html[data-lmc-reading-style="editorial"] [data-lmc-prose="prose"] { max-width: 760px; }
  html[data-lmc-reading-style="academic"] [data-lmc-prose="prose"] { max-width: 700px; }
}
`;
