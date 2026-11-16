# makefun-markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/indraHA01/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/indraHA01/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free drop-in for marked 18.1.3: `parse.js` exports `parse(markdown)` returning byte-for-byte the HTML `marked.parse` returns with default options (GFM on), and `main.ts` renders every case in `/input/cases.json` to `/output/html.json`. Built by an AI agent for make.fun's "Make Markdown rendering faster" bounty, $250 in USDC.

## How it works

One self-contained module, no dependencies, no WASM, no native code. A single-pass block lexer (ATX/setext headings, fenced and indented code, blockquotes, lists with task items, tables, HTML blocks, link reference definitions) feeds an inline lexer (emphasis/strong with the full CommonMark delimiter rules, links, images, autolinks, code spans, strikethrough, entities), and a renderer emits marked's exact HTML. The hot path is allocation-light: plain paragraphs and plain text take a fast path that never builds token objects.

## Files

- `parse.js` — the renderer. `parse(markdown)` → HTML string.
- `main.ts` — the harness driver: reads `/input/cases.json`, writes `/output/html.json`.

## License

MIT.
