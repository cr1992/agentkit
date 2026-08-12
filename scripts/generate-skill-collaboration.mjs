#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outputDir = path.join(repoRoot, "docs", "architecture");

const skillNames = [
  "run-agent-verify-loop",
  "orchestrate-subagents",
  "manage-worktrees",
  "verify-agent-output",
];

const fixedTerms = [
  ...skillNames,
  "Controller / User Goal",
  "Loop",
  "provider",
  "Task Contract",
  "Artifact Ref + Binding",
  "Evidence Package",
  "Convergence Report",
  "pass · fail · undecidable",
];

const copy = {
  lang: "en",
  title: "Explicit bounded implementation–verification Loop",
  subtitle: "The Loop coordinates independent provider capabilities after the Controller explicitly selects this mode.",
  controllerCopy: "freeze Task Contract · choose providers · final authorization",
  loopMode: "explicit Loop mode",
  loopAction: "record iteration · consume Evidence · continue / fuse / wait / stop",
  dispatch: "dispatch implementation",
  orchestrateAction: "dispatch roles · control task state",
  managedWriter: "managed writer",
  worktreeAction: "isolate writes · freeze Artifact Ref + Binding",
  frozenArtifact: "frozen Artifact",
  verifierAction: "verify one frozen Artifact · emit Evidence Package",
  footer: "Each provider also works independently. One-shot verification calls verify-agent-output directly and does not enter this Loop.",
};

const escapeXml = (value) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

function svgFor() {
  const t = Object.fromEntries(Object.entries(copy).map(([key, value]) => [key, escapeXml(value)]));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1020" viewBox="0 0 1080 1020" role="img" aria-labelledby="title desc" xml:lang="${t.lang}">
  <title id="title">${t.title}</title>
  <desc id="desc">Controller explicitly selects Loop mode. Loop coordinates orchestrate-subagents, manage-worktrees, and verify-agent-output. Evidence Package returns to Loop and Convergence Report returns to Controller.</desc>
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0 0 L10 5 L0 10 Z" fill="#64748b"/></marker>
    <filter id="shadow" x="-15%" y="-20%" width="130%" height="150%"><feDropShadow dx="0" dy="7" stdDeviation="11" flood-color="#0f172a" flood-opacity="0.09"/></filter>
    <style>
      .bg{fill:#f6f8fb}.title{font:700 29px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;fill:#172033}.subtitle{font:400 15px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;fill:#64748b}.controller-name{font:700 21px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#fff}.controller-copy{font:400 14px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;fill:#dbeafe}.name{font:700 19px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:#172033}.role{font:600 15px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;fill:#334155}.edge{fill:none;stroke:#64748b;stroke-width:2.2;marker-end:url(#arrow)}.edge-dashed{fill:none;stroke:#64748b;stroke-width:2.1;stroke-dasharray:7 7;marker-end:url(#arrow)}.label{font:600 13px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;fill:#475569;paint-order:stroke;stroke:#f6f8fb;stroke-width:7px;stroke-linejoin:round}.footer{font:400 13px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;fill:#64748b}.pill{font:700 11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.7px}
    </style>
  </defs>
  <rect class="bg" width="1080" height="1020" rx="28"/>
  <text class="title" x="62" y="57">${t.title}</text>
  <text class="subtitle" x="62" y="86">${t.subtitle}</text>
  <g filter="url(#shadow)">
    <rect x="300" y="126" width="480" height="96" rx="18" fill="#2454d8"/>
    <text class="controller-name" x="540" y="165" text-anchor="middle">Controller / User Goal</text>
    <text class="controller-copy" x="540" y="193" text-anchor="middle">${t.controllerCopy}</text>
  </g>
  <path class="edge" d="M540 222 L540 270"/><text class="label" x="560" y="250">${t.loopMode}</text>
  <g filter="url(#shadow)">
    <rect x="250" y="270" width="580" height="120" rx="17" fill="#fffaf5" stroke="#fb923c" stroke-width="1.7"/><rect x="250" y="270" width="580" height="9" rx="4.5" fill="#f97316"/>
    <rect x="278" y="295" width="82" height="22" rx="11" fill="#ffedd5"/><text class="pill" x="319" y="310" text-anchor="middle" fill="#c2410c">STATE MACHINE</text>
    <text class="name" x="278" y="344">run-agent-verify-loop</text><text class="role" x="278" y="371">${t.loopAction}</text>
  </g>
  <path class="edge" d="M390 390 C326 425 316 443 316 472"/><text class="label" x="280" y="433">${t.dispatch}</text>
  <g filter="url(#shadow)">
    <rect x="100" y="472" width="432" height="112" rx="16" fill="#fff" stroke="#c4b5fd" stroke-width="1.5"/><rect x="100" y="472" width="432" height="8" rx="4" fill="#8b5cf6"/>
    <rect x="128" y="496" width="92" height="22" rx="11" fill="#f3e8ff"/><text class="pill" x="174" y="511" text-anchor="middle" fill="#7e22ce">ORCHESTRATE</text>
    <text class="name" x="128" y="546">orchestrate-subagents</text><text class="role" x="128" y="574">${t.orchestrateAction}</text>
  </g>
  <path class="edge" d="M316 584 L316 638"/><text class="label" x="336" y="616">${t.managedWriter}</text>
  <g filter="url(#shadow)">
    <rect x="100" y="638" width="432" height="112" rx="16" fill="#fff" stroke="#86efac" stroke-width="1.5"/><rect x="100" y="638" width="432" height="8" rx="4" fill="#16a34a"/>
    <rect x="128" y="662" width="96" height="22" rx="11" fill="#dcfce7"/><text class="pill" x="176" y="677" text-anchor="middle" fill="#15803d">GIT ISOLATION</text>
    <text class="name" x="128" y="712">manage-worktrees</text><text class="role" x="128" y="740">${t.worktreeAction}</text>
  </g>
  <path class="edge" d="M316 750 C316 785 352 800 398 817"/><text class="label" x="338" y="783">${t.frozenArtifact}</text>
  <g filter="url(#shadow)">
    <rect x="250" y="817" width="580" height="120" rx="17" fill="#fff" stroke="#7dd3fc" stroke-width="1.5"/><rect x="250" y="817" width="580" height="9" rx="4.5" fill="#0284c7"/>
    <rect x="278" y="842" width="118" height="22" rx="11" fill="#e0f2fe"/><text class="pill" x="337" y="857" text-anchor="middle" fill="#0369a1">INDEPENDENT ONCE</text>
    <text class="name" x="278" y="891">verify-agent-output</text><text class="role" x="278" y="918">${t.verifierAction}</text>
  </g>
  <path class="edge" d="M830 877 C950 824 963 669 963 537 C963 428 908 347 830 333"/>
  <text class="label" x="931" y="635" text-anchor="end">Evidence Package</text><text class="label" x="931" y="656" text-anchor="end">pass · fail · undecidable</text>
  <path class="edge-dashed" d="M830 302 C933 260 919 181 780 174"/><text class="label" x="906" y="238" text-anchor="middle">Convergence Report</text>
  <line x1="62" y1="971" x2="1018" y2="971" stroke="#dbe2ea"/><text class="footer" x="62" y="997">${t.footer}</text>
</svg>
`;
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const checkOnly = process.argv.includes("--check");
  const svg = svgFor();
  for (const name of skillNames) assert.match(svg, new RegExp(`>${name}<`));
  for (const term of fixedTerms) assert.ok(svg.includes(term), `diagram missing fixed term: ${term}`);
  const svgPath = path.join(outputDir, "skill-collaboration.svg");
  if (checkOnly) {
    assert.equal(await readFile(svgPath, "utf8"), svg, "diagram is stale; run node scripts/generate-skill-collaboration.mjs");
  } else {
    await writeFile(svgPath, svg, "utf8");
  }
}

await main();
