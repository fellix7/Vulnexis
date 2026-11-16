# UI audit: Hallmark

> **Note (after the hackathon):** the India brief (`/india`), the Hindi toggle and WhatsApp sharing described here have been removed from the product. This document is kept as the hackathon record.

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
| H2 | 58 screen budget | Landing at y≈6150, "Why Vulnera" feature tiles + Guardrails: **314 words on one 900 px screen**; the hero carries three text blocks before its actions | Too much to read per screen | Cut each tile to one sentence and drop the trust line under the hero buttons (it repeats the policies) |
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

## Polish applied (same day)

Depth: **polish**, requested by the team. The look and layout are unchanged.

| Finding | Change | Re-check |
| :--- | :--- | :--- |
| A1 focus | `label.btn` shows the accent ring when its hidden file input has keyboard focus (`index.css`) | 26a clear |
| A2 field edge | New `--line-input: #666a73` token for `.input` / `.select` borders: 3.5:1 on the card | 40 clear |
| A3 overflow | `overflow-x: clip` on `html` and `body` | 34 clear |
| A4 motion | Funnel bars animate `transform: scaleX()` instead of `width` | 10a clear |
| A5 tokens | `--line-hover`, `--on-solid`, `--critical-solid`, `--topbar-bg`, `--drawer-shadow`, `--code-bg`, `--flag-*` tokens; no colour literals outside `:root` | 48 clear |
| R1 small text | `--fs-xs` 11 px → 12 px; every 10.5 px / 11 px size uses the token | 75 clear |
| R4 control height | `.btn--sm` 28 px → 32 px | 39b clear in the app |
| R5 states | `:active` press feedback on buttons | present in `index.css` (the per-file 26b report for `landing.css` is dismissed) |
| R6 wrap | Inline `.link` does not wrap | 49b clear |
| Gradient contrast | Muted text on the featured plan uses `--text-2` | 40 clear |
| F3, F6 | `text-wrap: balance` on display heads; tabular figures on big numbers | clear |

**Still open, by choice:** the house rules H1 (eyebrows and tracked caps), H2 (words per screen), H3 (hero height at 1440 and 1920), R2 (mono labels), R3 (icon tiles), R7 (off-scale spacing). They need a restyle or a landing recomposition. The landing `button.lp-stage` (85 px funnel stage selectors) is **waived** for 39b: these are card-sized selectors, not buttons.

## Restyle applied (second pass)

Requested by the team after the polish. Content and wiring kept; the type system and the landing composition changed.

| Finding | Change |
| :--- | :--- |
| H1 eyebrows, tracked caps | Eyebrows removed above every page and section heading; the 15 remaining small-capital label rules (table heads, agent I/O labels, tags, legends) are now the body face, sentence case, untracked |
| R2 mono labels | Labels use the body face; monospace stays only for code, versions, package names and figures |
| 38iii one-colour heading | The dimmed second line of the hero headline is now the same colour |
| H3 hero / 79 empty half | Hero is one screen: headline, one sentence, two actions, and the agent's decisions (demo data) beside them as the signature. The product preview follows as its own section |
| H2 screen budget | Hero lede cut to one sentence; trust line removed; feature, step and India card copy cut to one sentence each; captions removed |
| 59 section count | Guardrails and the closing CTA band removed (their content is in the agent section, the pricing CTA and `SYSTEM_POLICIES.md`); 249 lines of dead CSS deleted |
| R3 icon tiles | India cards set the icon inline with the heading; the DPDP card leads, wider |
| R7 spacing | Gaps, paddings and margins in `index.css` and `landing.css` moved onto the 4 px scale |

**Re-check (landing):** 0 FAIL on the access, motion, token, eyebrow and tracked-caps gates. What remains:
- **58**: the hero's agent card adds about 100 words. It is product UI and the page's signature, so it is **waived**.
- **56**: dismissed, as above.
- **20**: Hallmark's build stamp, which only applies to pages Hallmark built.
- Per-file reduced-motion and `:active` reports: dismissed, both exist in `index.css`.
- **39b** `lp-stage` card selectors and **64** repository names in example chips: **waived**.

**Known gap:** in Hindi mode the agent's step titles and decisions stay in English, because the server writes them. Translating them means adding Hindi strings to `server/src/index.ts`.


---

## Round 3: less text (mentor feedback, Nov 2026)

Feedback: the UI read as wordy and congested. A Hallmark redesign pass focused on copy density, keeping the brand (dark surfaces, lime accent, Inter) and every route, link and handler.

| Screen | Words before | Words after | What changed |
| :--- | ---: | ---: | :--- |
| Landing | 1,403 | 870 | Section ledes cut; the "four steps" and the four feature cards removed (they repeated the agent loop and the product preview); comparison bullet lists removed; tier rules and the go-to-market block shortened |
| Scan | 602 | 190 | One-line header and step hints; "what happens to your files" reduced to four one-liners; supported formats folded into a disclosure |
| Overview | 619 | 395 | Funnel captions and side notes removed; the repeated tier rule under each urgent finding removed; notes shortened |
| India brief | 709 | 589 | The full text of each law folded behind "What the law says" |
| Reports | 487 | 317 | Notes and empty states cut to one sentence |
| Agent, Architecture, Evidence, Remediation, Finding | | | One-line headers; rule boxes cut to short lines; fine print removed or shortened |

Remaining words on Agent and Findings are the product's own data (trace steps, table rows).

Floor fixes in this pass: the eyebrow above the finding title removed; status dots replaced with state icons; middle-dot meta strings replaced with commas; one em dash removed; the inert sticky table header removed; stamp restored in `client/src/index.css`.

Linter: `sloplint client/src --genre modern-minimal`: 1 FAIL (gate 56, sidebar and top bar both `sticky; top: 0`; a false positive, they are in separate grid columns), 91 REFLEX (mostly 6px and 10px gaps off the 4px scale, and mono figure labels; unchanged from before, left for a later polish), 11 WARN.
