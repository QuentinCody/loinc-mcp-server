#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assertContains(filePath, haystack, needle, testName) {
  totalTests++;
  if (haystack.includes(needle)) {
    console.log(`${GREEN}✓${RESET} ${testName}`);
    passedTests++;
  } else {
    console.log(`${RED}✗${RESET} ${testName}`);
    console.log(`  Missing: ${needle}`);
    console.log(`  File: ${filePath}`);
    failedTests++;
  }
}

function assertNotContains(filePath, haystack, needle, testName) {
  totalTests++;
  if (!haystack.includes(needle)) {
    console.log(`${GREEN}\u2713${RESET} ${testName}`);
    passedTests++;
  } else {
    console.log(`${RED}\u2717${RESET} ${testName}`);
    console.log(`  Must not contain: ${needle}`);
    console.log(`  File: ${filePath}`);
    failedTests++;
  }
}

function readFile(relPath) {
  const absPath = path.resolve(SERVER_ROOT, relPath);
  return fs.readFileSync(absPath, 'utf8');
}

console.log(`${BLUE}LOINC Structured Content Regression Tests${RESET}`);

// Code Mode tools
const codeModeContent = readFile('src/tools/code-mode.ts');
assertContains('src/tools/code-mode.ts', codeModeContent, 'createSearchTool', 'code-mode.ts includes createSearchTool');
assertContains('src/tools/code-mode.ts', codeModeContent, 'createExecuteTool', 'code-mode.ts includes createExecuteTool');
assertContains('src/tools/code-mode.ts', codeModeContent, 'loincCatalog', 'code-mode.ts uses loincCatalog');
assertContains('src/tools/code-mode.ts', codeModeContent, 'LOINC_DATA_DO', 'code-mode.ts uses LOINC_DATA_DO binding');

// The citation must not be rebuilt from the startup primary endpoint: with
// failover live that names a host that may not have answered.
assertContains('src/tools/code-mode.ts', codeModeContent, 'loincSourceDescriptor(endpoints)', 'code-mode.ts derives the citation source from every resolved endpoint');
assertNotContains('src/tools/code-mode.ts', codeModeContent, 'url: primary.baseUrl', 'code-mode.ts does not cite the startup primary as the answering host');

// Index
const indexContent = readFile('src/index.ts');
assertContains('src/index.ts', indexContent, 'LoincDataDO', 'index.ts exports LoincDataDO');
assertContains('src/index.ts', indexContent, 'StatelessMcpWorker', 'index.ts uses StatelessMcpWorker');
assertContains('src/index.ts', indexContent, 'registerCodeMode', 'index.ts registers Code Mode');
assertContains('src/index.ts', indexContent, 'registerQueryData', 'index.ts registers query-data');
assertContains('src/index.ts', indexContent, 'registerGetSchema', 'index.ts registers get-schema');

// DO
const doContent = readFile('src/do.ts');
assertContains('src/do.ts', doContent, 'RestStagingDO', 'do.ts extends RestStagingDO');
assertContains('src/do.ts', doContent, 'LoincDataDO', 'do.ts exports LoincDataDO');

// HTTP with auth
const httpContent = readFile('src/lib/http.ts');
assertContains('src/lib/http.ts', httpContent, 'Authorization', 'http.ts includes Authorization header');
assertContains('src/lib/http.ts', httpContent, 'Basic', 'http.ts uses HTTP Basic auth');
assertContains('src/lib/http.ts', httpContent, 'fhir.loinc.org', 'http.ts points to LOINC FHIR server');

// Two-tier upstream: keyless FHIR mirrors when no credential is configured
assertContains('src/lib/http.ts', httpContent, 'resolveLoincEndpoints', 'http.ts resolves the upstream tier at runtime');
assertContains('src/lib/http.ts', httpContent, 'https://tx.fhir.org/r4', 'http.ts includes the keyless tx.fhir.org tier');
assertContains('src/lib/http.ts', httpContent, 'https://r4.ontoserver.csiro.au/fhir', 'http.ts includes the Ontoserver failover');
assertContains('src/lib/http.ts', httpContent, 'loincSourceDescriptor', 'http.ts derives the citation source from the resolved endpoint set');

// Adapter stamps which upstream answered onto every result
const adapterContent = readFile('src/lib/api-adapter.ts');
assertContains('src/lib/api-adapter.ts', adapterContent, 'loinc_tier', 'api-adapter.ts stamps _meta.loinc_tier');
assertContains('src/lib/api-adapter.ts', adapterContent, 'loinc_version', 'api-adapter.ts stamps the LOINC release');

// Catalog
const catalogContent = readFile('src/spec/catalog.ts');
assertContains('src/spec/catalog.ts', catalogContent, 'ApiCatalog', 'catalog.ts uses ApiCatalog type');
assertContains('src/spec/catalog.ts', catalogContent, '$lookup', 'catalog.ts includes $lookup endpoint');
assertContains('src/spec/catalog.ts', catalogContent, '$expand', 'catalog.ts includes $expand endpoint');
assertContains('src/spec/catalog.ts', catalogContent, 'ConceptMap', 'catalog.ts includes ConceptMap endpoint');
assertContains('src/spec/catalog.ts', catalogContent, 'loincCatalogFor', 'catalog.ts builds a tier-aware catalog');
assertContains('src/spec/catalog.ts', catalogContent, 'DEGRADED', 'catalog.ts marks the endpoints that degrade without credentials');

// Measured 2026-08-27: tx.fhir.org serves 25 property parts for $lookup 2160-0
// property=*, Ontoserver only 12. The catalog must attribute the larger figure
// to tx.fhir.org alone and name what the failover mirror drops.
assertContains('src/spec/catalog.ts', catalogContent, 'THE TWO MIRRORS DIFFER', 'catalog.ts warns that the two keyless mirrors are not equivalent');
assertContains('src/spec/catalog.ts', catalogContent, 'Ontoserver returned 12 parts', 'catalog.ts states the Ontoserver property subset');
assertNotContains('src/spec/catalog.ts', catalogContent, 'all 25 code properties', 'catalog.ts no longer claims both keyless mirrors serve all 25 properties');
assertContains('src/spec/catalog.ts', catalogContent, 'Ontoserver returns total 1', 'catalog.ts scopes the ValueSet-search gap to each mirror');

// The README carries the same corrected figures for a human reader.
const readmeContent = readFile('README.md');
assertContains('README.md', readmeContent, 'The two keyless mirrors are not equivalent', 'README states the mirrors differ');
assertContains('README.md', readmeContent, 'The 25-property figure belongs to `tx.fhir.org` alone', 'README attributes the 25-property figure to tx.fhir.org');
assertContains('README.md', readmeContent, 'pnpm --filter @bio-mcp/shared run build', 'README records the @bio-mcp/shared deadlineMs build dependency');

console.log(`\n${BLUE}Test Results Summary${RESET}`);
console.log(`Total tests: ${totalTests}`);
console.log(`${GREEN}Passed: ${passedTests}${RESET}`);
console.log(`${RED}Failed: ${failedTests}${RESET}`);

if (failedTests > 0) {
  console.log(`\n${RED}Regression tests failed.${RESET}`);
  process.exit(1);
}

console.log(`\n${GREEN}LOINC structured content regression tests passed.${RESET}`);
