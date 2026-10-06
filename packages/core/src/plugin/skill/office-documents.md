<!--
  Built-in skill. Name and description are registered in code at
  packages/core/src/plugin/skill.ts (V2) and packages/miao/src/skill/index.ts
  (V1). The body below becomes the skill's content.
-->

# Office documents

Producing a .docx, .xlsx or .pptx is only half the job. The file must also be
*right* — formulas that compute, numbers a reviewer can trace — and *look*
right — the intended fonts, no tofu boxes, no layout that spills onto an extra
page. A generator that exits 0 proves nothing: check the output by rendering
it and reading the result before you tell the user it is done.

Rendering and conversion use `@deepseek-ai/libreoffice-kit` (MPL-2.0), a
prebuilt LibreOffice with font discovery and CJK font substitution. Do not use
a system `soffice`/LibreOffice for Chinese documents: it substitutes 宋体 with
a Traditional-Chinese face, 楷体 with a cursive face and 微软雅黑/等线/仿宋 with
a novelty face, and reflows pages.

## Pick the format from what the reader does next

- Someone reads it as it stands — a report, a deliverable, anything for
  circulation → **PDF**.
- Someone writes in it next — a working paper, a memo, a draft under review →
  **DOCX**.
- The user opens and changes it in a spreadsheet → **XLSX**.
- Short-form output that lives in the conversation → Markdown in chat; no file.
- An explicit user request wins over all of the above.

Build each format deliberately with a generator for it. Renaming a file's
extension converts nothing.

## Where files go

Two directories, and mixing them loses deliverables:

- **Delivery directory** — where the caller collects the finished file. Use the
  path the user gave; else the delivery directory the session already
  established (look before guessing); else the working directory. A file
  written somewhere the caller does not read is the same outcome as no file —
  the work is done and the deliverable is lost behind a confident final
  message.
- **Build directory** — a subdirectory you create for scaffolding and delete
  before finishing: the generator script, temp copies, recalc artifacts,
  rendered check pages. Scaffolding never sits beside the deliverable; a
  reader opening the directory cannot tell which file is the real one.

Before finishing, list the delivery directory and confirm the deliverable is
in it, then say in one clause where you put it.

The filename follows the document's language — a Chinese request gets a
Chinese filename (`比亚迪_002594_DCF模型_20260811.xlsx`). Tickers, dates and
other identifiers stay as they are. The filename is the first thing the user
sees; a half-translated one reads as half-translated output.

## Output language

The document follows the user's language of address, not the template's: a
request in Chinese produces a Chinese document. If the request does not settle
it, use the user's usual locale.

One language per document. Do not mix a Chinese narrative with English section
headings, or English prose with Chinese table headers — this trap does not
look like an error while you are writing it, because the template was in the
other language. Choose headings, labels, captions and annotation tags in one
language and keep every one of them in it. Terms of art keep their source
language in either document.

## Requirements

- Node.js ≥ 22.19 (`node --version`). If it is missing or older, tell the user
  and stop; the kit does not run under Bun.
- The first run downloads about 67 MB (about 160 MB unpacked) into the npm
  cache and builds a font index (about 8 s). Later runs take 1–3 s per
  document. Tell the user before the first download.
- Linux needs CJK fonts installed (for example `fonts-noto-cjk`); otherwise
  Chinese text has nothing to fall back to.

## Font fallbacks

Always pass this table. `--font-fallbacks` replaces the kit's built-in table
rather than extending it, and the built-in table lacks 等线, 方正小标宋简体 and
华文中宋 (without an entry they fall back to a sans or symbol face). Each group
is `[requested family, substitutes in order of preference…]`. Save it once as
`font-fallbacks.json` next to your work files:

```json
[
  ["Calibri", "Carlito"],
  ["Calibri Light", "Carlito", "Calibri"],
  ["Cambria", "Caladea"],
  ["宋体", "SimSun", "NSimSun", "Songti SC", "STSong", "Noto Serif CJK SC", "Noto Serif SC", "Source Han Serif SC"],
  ["黑体", "SimHei", "Heiti SC", "STHeiti", "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC"],
  ["微软雅黑", "Microsoft YaHei", "Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC"],
  ["等线", "DengXian", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC"],
  ["楷体", "KaiTi", "Kaiti SC", "STKaiti", "LXGW WenKai"],
  ["仿宋", "FangSong", "STFangsong", "Songti SC", "Noto Serif CJK SC"],
  ["方正小标宋简体", "FZXiaoBiaoSong-B05S", "STZhongsong", "华文中宋", "SimSun", "Songti SC", "STSong", "Noto Serif CJK SC"],
  ["华文中宋", "STZhongsong", "SimSun", "Songti SC", "STSong", "Noto Serif CJK SC"],
  ["方正仿宋_GBK", "FangSong", "STFangsong", "Songti SC", "Noto Serif CJK SC"],
  ["方正楷体_GBK", "KaiTi", "Kaiti SC", "STKaiti", "LXGW WenKai"],
  ["sans-serif", "Arial", "Liberation Sans", "Helvetica", "DejaVu Sans", "Calibri", "Carlito", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "SimHei", "Heiti SC"],
  ["serif", "Times New Roman", "Liberation Serif", "Times", "DejaVu Serif", "Cambria", "Caladea", "SimSun", "Songti SC", "STSong", "Noto Serif CJK SC"],
  ["monospace", "Courier New", "Liberation Mono", "DejaVu Sans Mono", "Menlo", "Monaco", "Noto Sans Mono CJK SC"],
  ["Symbol", "Standard Symbols PS", "Symbola", "Segoe UI Symbol", "Apple Symbols", "DejaVu Sans"]
]
```

If the document uses another family that is not installed, add a group for it
that names a visually similar face (serif for 宋/明 styles, sans for 黑/圆
styles).

## Commands

All commands print one JSON object to stdout. Write each command out in full;
do not put `npx … dsoffice` in a shell variable (zsh does not word-split it).

```sh
# Render pages to PNG (output dir must be new or empty). --pages all|1,3; --dpi 110 is enough to read.
npx -y -p @deepseek-ai/libreoffice-kit@0.1.3 dsoffice render --input report.docx --output-dir render-report --pages all --dpi 110 --font-fallbacks "$(cat font-fallbacks.json)"

# Render one worksheet area.
npx -y -p @deepseek-ai/libreoffice-kit@0.1.3 dsoffice render --input data.xlsx --output-dir render-data --sheet Sheet1 --range A1:H40 --font-fallbacks "$(cat font-fallbacks.json)"

# Convert (target format from the extension: pdf, docx, xlsx, pptx, odt, csv, …).
npx -y -p @deepseek-ai/libreoffice-kit@0.1.3 dsoffice convert --input report.docx --output report.pdf --font-fallbacks "$(cat font-fallbacks.json)"

# Compute formulas that have no cached values (for example written by openpyxl).
npx -y -p @deepseek-ai/libreoffice-kit@0.1.3 dsoffice recalculate --input data.xlsx --output data-calculated.xlsx
```

`render` returns `images[].path` and `missingFonts`. `missingFonts` lists
families the document asks for that are not installed; they are drawn with the
substitute from the table, so check them on the rendered page.

## Excel workbooks

Build .xlsx with openpyxl. A workbook is a model, not a printout: a reviewer
must be able to change an input and watch results move.

**Colour carries meaning.** Blue font = hardcoded input, black = formula,
green = a link to a cell on another sheet. Use the same three colours in every
workbook so assumptions and calculations separate at a glance. Do not invent
extra conventions your own checks do not understand.

**Every input lives in its own cell.** Every calculation cell is a formula.
A number typed *inside* a formula is still a hardcode: `=6173.8+1.1` looks
compliant and is not — neither figure can be coloured, sourced or changed.
Put each retrieved figure in an input cell with its own source comment, then
reference the cells. The only literals a formula may carry are structural
constants a reader would never want to change: a unit conversion (`/10000`),
a period count (`/12`), percent-to-decimal (`/100`).

**Trace the numbers.** Attach a cell comment to every significant input with
its source, date and definition. Use one fixed set of tag words (for example
`[reported]`, `[estimated]`, `[inferred]`) and never paraphrase them — checks
and readers match the literal string, and `[已测算]` reads as untagged to a
check looking for `[estimated]`.

**Present like a spreadsheet.** Numbers right-aligned, text left-aligned,
headers aligned with their column. A restrained fill for header rows and
input blocks. Borders mark structure: a heavier rule above section headers
and under subtotals, a double rule under grand totals. Word documents are the
opposite — their tables bring their own furniture.

**Recalculate, then scan for errors — mandatory before delivery.** Formulas
written by openpyxl have no cached values: blanks until Excel computes them,
and errors you cannot see at all.

```sh
npx -y -p @deepseek-ai/libreoffice-kit@0.1.3 dsoffice recalculate --input model.xlsx --output model-check.xlsx
```

Read the recalculated copy with `openpyxl` in data-only mode and scan every
cell for cached error strings — `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`,
`#N/A`. One cached error fails delivery: fix the formula, not the check.
Then render the used ranges and look at them; `###` overflow, truncated text
and broken column widths do not show in a data read.

**Reviewing a workbook someone else prepared** runs the same rules in
reverse: hunt for figures buried inside formulas, constants in calculation
cells, inputs without source comments — then recalculate and compare against
the stated results.

## Charts

Generate charts before assembling the document, sized for the width they will
occupy on the page. Regenerate from data instead of editing image files, and
keep the chart script in the build directory with the rest of the
scaffolding.

## Authoring rules

Name fonts the recipient is likely to have — 宋体, 黑体, 微软雅黑, 等线, 楷体,
仿宋 and Calibri/Arial/Times New Roman — not macOS-only families such as
PingFang SC or Songti SC, which Windows Office does not have.

Office files keep Latin and East Asian fonts separately. Setting only the Latin
name leaves Chinese text in the default East Asian font:

- python-docx: `run.font.name = "宋体"` sets only the Latin font. Also set
  `run._element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), "宋体")`
  (`from docx.oxml.ns import qn`). For document-wide defaults, set both on the
  `Normal` style.
- python-pptx: `run.font.name` sets only `a:latin`. Add an `a:ea` element with
  `typeface="微软雅黑"` to the run's `a:rPr` for Chinese text.
- docx (npm): pass `font: { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "宋体" }`.
- openpyxl: `Font(name="宋体")` applies to the whole cell. Formulas have no
  cached values until you run `recalculate`.

## Checking loop

1. Generate the file into the delivery directory.
2. Workbooks: recalculate, scan every cell for cached formula errors, then
   render the ranges that matter. Documents: render page 1 first as a canary —
   wrong fonts and broken layout are cheapest to catch there — then render
   every page.
3. Read the PNGs. Check: Chinese and Latin text in the intended faces, no tofu
   boxes or missing glyphs, tables and headings intact, page count as
   expected, nothing spilling onto extra pages, numbers and formulas showing
   values.
4. Fix the generator, regenerate and check again. Never report done from a
   generator exit code.
5. Remove the build directory, confirm the deliverable is in the delivery
   directory, and say which fonts were substituted (`missingFonts`) when you
   report the result.
