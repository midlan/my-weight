#!/usr/bin/env node
// One implementation of the <img data-inline-svg> → inlined-SVG
// substitution, shared between:
//   - the CI workflow (run as a CLI: `node scripts/inline-svg.mjs
//     public/index.html public/icon.svg`), which replaces the marker
//     in the deployed HTML in place;
//   - tests/fixtures.js, which imports `inlineSvg()` to build a
//     gitignored test HTML the Playwright suite goto's.
//
// The substitution is gated on exact-one matches per HTML file so an
// accidental second occurrence (e.g. example markup in prose) fails
// loudly instead of silently rewriting the wrong place.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const IMG_RE = /<img\s+[^>]*\bdata-inline-svg\b[^>]*\/?>/g;

// Pure function: returns a new HTML string with each
// <img data-inline-svg> swapped for `svg`, plus the substitution
// count so callers can enforce expected-one (or whatever they need).
export function inlineSvg(html, svg) {
  let count = 0;
  const out = html.replace(IMG_RE, () => {
    count++;
    return svg;
  });
  return { html: out, count };
}

// CLI: rewrite the HTML file in place. Exits non-zero with a clear
// message if the marker doesn't appear exactly once.
if (import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , htmlPath, svgPath] = process.argv;
  if (!htmlPath || !svgPath) {
    console.error('usage: inline-svg.mjs <html-file> <svg-file>');
    process.exit(2);
  }
  const html = fs.readFileSync(htmlPath, 'utf8');
  const svg = fs.readFileSync(svgPath, 'utf8');
  const { html: out, count } = inlineSvg(html, svg);
  if (count !== 1) {
    console.error(`expected 1 <img data-inline-svg> in ${htmlPath}, found ${count}`);
    process.exit(1);
  }
  fs.writeFileSync(htmlPath, out);
}
