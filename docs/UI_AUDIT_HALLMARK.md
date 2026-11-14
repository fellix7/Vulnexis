# UI audit: Hallmark

**Skill:** [Hallmark](https://github.com/Nutlope/hallmark) v2.0.0 (commit `04977e1`), `audit` verb: report only, no files changed.
**Date:** 14 November 2026. **Genre inferred:** modern-minimal (developer tool / platform). **Scopes:** landing page as a page; `/scan` and `/overview` as app screens.
**Method:** `sloplint.mjs --render --before` on the CSS and the running dev server (1280×800, 1440×900, 1920×1080 folds; 1440 and 375 full pages), then the judged gates walked from the screenshots (`gates.md` § 1, § 4, § 5).

Raw output: landing **20 FAIL · 66 REFLEX · 12 WARN**; app screens **16 FAIL · 59 REFLEX · 4 WARN**. Most counts are repeats of a few rules (for example 50 lines of "gap off the 4 px scale"). The deduplicated findings follow, with false positives dismissed.

## The read

1. **What the page is for:** Indian developers without a security team; the one action is "scan a GitHub repo".
2. **What works and stays:** a strong, honest system. AI content is always violet and dashed, verified data is solid; priorities always carry a word; real product UI as the hero visual instead of an illustration; nothing invented (the preview is labelled "demo data"); phone layout holds at 375 px; a global reduced-motion rule exists.
3. **What reads as generated** (Hallmark's house rules): the **eyebrow** above every section heading and the **tracked small capitals** on labels and table heads (`RISK FUNNEL`, `HOVER OR SELECT A STAGE`, `GUARDRAILS`); monospace used as a label voice; landing sections that run long on words; equal tiles with an icon above each heading.
4. **What is broken:** one control shows no keyboard focus; text-field edges are too faint to see; a few labels are 10.5 to 11 px; `overflow-x: hidden` on `body`.

## Floor (Hallmark never ships these)

### Accessibility and correctness: real bugs, fix regardless of style

| # | Gate | Where | Finding | Fix |
| :--- | :--- | :--- | :--- | :--- |
| A1 | 26a focus | `/scan`, "Choose source folder" (`components/scan/SourceFolder.tsx`, styled as `label.btn`) | Keyboard focus lands on the hidden file input, so nothing visible shows focus | `.btn:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px }` |
| A2 | 40 contrast | `/scan`, the GitHub link field (`.input`, `index.css:719`) | The field's edge is under 3:1 against the card (WCAG 1.4.11 non-text contrast) | Use a lighter border token for inputs, about `#4a4d55`, or fill the field one step off the card |
| A3 | 34 overflow | `index.css:126` | `overflow-x: hidden` on `body` can break `position: sticky` | `overflow-x: clip` on both `html` and `body` |
| A4 | 10a motion | `overview.css:197` (`.ov-stage__bar > span`) | Funnel bars animate `width` (layout work on every frame) | Animate `transform: scaleX()` with `transform-origin: left` |
| A5 | 48 tokens | `index.css:304, 459` and `findings.css:89, 234` (10 lines) | Colour literals (`#3a3c42`, `#fff`) outside the token block | Add `--line-hover` and `--on-solid` tokens and use them |

### House rules: Hallmark's style rules, not accessibility

These are Floor in Hallmark (it treats them as the most reliable "machine-made" tells), but they are style choices. Fixing them is a restyle of the type system, about one to two hours of work.

| # | Gate | Where | Finding | Fix |
| :--- | :--- | :--- | :--- | :--- |
| H1 | 54 + 67 eyebrow, tracked caps | `.eyebrow` (`index.css:226`), used on every landing section and page header; `.dtable thead th` (`index.css:839`); `.agent-io dt` (`agent.css:143`); `.fd-check__state` (`finding-detail.css:201`); 7 more | Small uppercase, letter-spaced labels above headings and in table heads | Keep an eyebrow only where it carries a fact (for example "Demo data"); otherwise delete it, or let it become the heading. Labels: body face, one step smaller, sentence case, no tracking |
| H2 | 58 screen budget | Landing at y≈6150, "Why Kavach" feature tiles + Guardrails: **314 words on one 900 px screen**; the hero carries three text blocks before its actions | Too much to read per screen | Cut each tile to one sentence and drop the trust line under the hero buttons (it repeats the policies) |
| H3 | 44d fold | Landing at 1920×1080: the hero section, including the product preview, ends at 1283 px | The hero runs past one screen. The headline, lede and both actions are inside the fold, so gate 12 passes | Shorten the preview to three rows at ≥1440 px, or move it below the hero |

## Reflex (fix, or waive with a reason)

| # | Gate | Where | Finding | Suggested answer |
| :--- | :--- | :--- | :--- | :--- |
| R1 | 75 small text | Table heads at 10.5 px; `.ov-dist__note`, `.repo-hint`, `.scan-run__note` at 11 px | Strains the eye on a projector | Raise to 12 px (`--fs-xs: 12px`) |
| R2 | 64 mono labels | `.eyebrow`, `.badge--mono`, `.fd-chain__tag`, `.fx-legend dt` | Monospace used as a label voice | Mono only for code, versions and commands |
| R3 | 3 icon tiles | Landing "Built for India" (`ul.kv-cards`) | Four equal columns, each with an icon above its heading | Put the icon inline with the heading, or make the DPDP card wider as the lead fact |
| R4 | 39b control height | App: `a.btn` at 28 px | App controls should be 32 to 40 px with a 44 px hit area | `.btn--sm` to 32 px |
| R5 | 26b states | No `:active` style anywhere | Buttons give no press feedback | `.btn:active { transform: translateY(1px) }` |
| R6 | 49b wrap | `/overview` at 768 px: the "Scan a project" link wraps to two lines | | `white-space: nowrap` |
| R7 | 24b spacing | ~50 values off the 4 px scale (5 px, 7 px, 2 px 7 px gaps and paddings) | Cosmetic | Round to 4 / 8 when touching those rules; waive the rest |
| R8 | 44c fold | Landing at 1440×900, same cause as H3 | | Fixed with H3 |

## Warnings, confirmed or dismissed

| Gate | Finding | Verdict |
| :--- | :--- | :--- |
| 27 reduced motion (reported as FAIL in `landing.css`, `scan.css`) | The linter checks each file alone | **Dismissed:** `index.css:189` has a global `prefers-reduced-motion` rule covering every animation and transition |
| 56 two sticky elements (sidebar + topbar) | Both are `top: 0` | **Dismissed:** the sidebar is a separate column; they never overlap |
| 56 (landing nav + table head) | `.dtable thead th` is sticky | **Dismissed:** the table sits in an `overflow-x: auto` wrapper, so its head sticks inside the wrapper, not under the nav |
| 40 gradient contrast (3.89:1 on `.kv-plan` featured card) | Muted text over the accent-tinted gradient | **Confirmed:** use `--text-2` instead of `--text-3` inside the featured plan |
| 29 glass panel (`index.css:1095`) | Blur over translucent black (mobile sidebar backdrop) | **Dismissed:** it is a modal backdrop, not a surface |
| 41 panel text colour | `.panel` sets no text colour | **Dismissed:** inherits `--text` from `body` |
| 59 ten sections | Landing has 10 sections (hero and footer included) | **Confirmed:** merge "The problem" into "Built for India", or drop the final CTA band, which repeats the hero |
| 25 measure | 44ch and 76ch prose | Minor; leave |

## Finish (craft, never blocks)

- F3: add `text-wrap: balance` to `h1`, `h2` (fixes the "stub" line in "Hindi for the founder, commands for the dev" at 375 px, F26).
- F6: `font-variant-numeric: tabular-nums` on large numbers (`.lp-stat__n`, `.kv-plan__price .num`, funnel counts).
- F7: six components share one container recipe (`.scan-alt__item`, `.ib-law`, `.kv-card` …); vary weight or fill by role.
- F15: six different column gaps across landing sections; pick one.

## Depth recommendation

- **Polish** (keep the look, fix what a gate names) settles A1 to A5, R1, R4 to R6, the contrast warning, F3 and F6. **About 30 to 45 minutes.** Recommended before the demo: these are what a judge would actually notice (focus, contrast, legibility on a projector).
- **Restyle** (keep the layout, change the type system) is needed for H1 and R2: removing eyebrows and tracked or mono labels across about 40 places.
- **Full** redesign would address H2, H3, R3 and the section count by recomposing the landing page. Not recommended inside the hackathon window.
