<!--
  Built-in skill. Name and description are registered in code at
  packages/core/src/plugin/skill.ts (V2) and packages/miao/src/skill/index.ts
  (V1). The body below becomes the skill's content.
-->

# Office documents

Writing a .docx, .xlsx or .pptx is only half the job: the file must also look
right — the intended fonts, no tofu boxes, no layout that spills onto an extra
page. Check your output by rendering it and looking at the pages before you
tell the user it is done.

Rendering and conversion use `@deepseek-ai/libreoffice-kit` (MPL-2.0), a
prebuilt LibreOffice with font discovery and CJK font substitution. Do not use
a system `soffice`/LibreOffice for Chinese documents: it substitutes 宋体 with
a Traditional-Chinese face, 楷体 with a cursive face and 微软雅黑/等线/仿宋 with
a novelty face, and reflows pages.

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

1. Generate the file.
2. `render` every page (or the worksheet range that matters) and read the PNGs.
3. Check: Chinese and Latin text in the intended faces, no tofu boxes or
   missing glyphs, tables and headings intact, page count as expected, numbers
   and formulas showing values.
4. Fix the generator, regenerate and render again. Say which fonts were
   substituted (`missingFonts`) when you report the result.
