// Driver for the markdown-render-speed-02 entry. The harness runs
// `node /bot/main.ts` (node 22). It reads every case from
// /input/cases.json (an array of {id, markdown}), renders each one alone
// with parse() from ./parse.js, and writes /output/html.json: a JSON array
// of the HTML strings, one per case, in the cases' order.
// Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Array<{ id: string; markdown: string }>;

const out = new Array<string>(cases.length);
for (let i = 0; i < cases.length; i++) out[i] = parse(cases[i]!.markdown);

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
