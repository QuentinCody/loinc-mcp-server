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

// Index
const indexContent = readFile('src/index.ts');
assertContains('src/index.ts', indexContent, 'LoincDataDO', 'index.ts exports LoincDataDO');
assertContains('src/index.ts', indexContent, 'McpAgent', 'index.ts uses McpAgent');
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

// Catalog
const catalogContent = readFile('src/spec/catalog.ts');
assertContains('src/spec/catalog.ts', catalogContent, 'ApiCatalog', 'catalog.ts uses ApiCatalog type');
assertContains('src/spec/catalog.ts', catalogContent, '$lookup', 'catalog.ts includes $lookup endpoint');
assertContains('src/spec/catalog.ts', catalogContent, '$expand', 'catalog.ts includes $expand endpoint');
assertContains('src/spec/catalog.ts', catalogContent, 'ConceptMap', 'catalog.ts includes ConceptMap endpoint');

console.log(`\n${BLUE}Test Results Summary${RESET}`);
console.log(`Total tests: ${totalTests}`);
console.log(`${GREEN}Passed: ${passedTests}${RESET}`);
console.log(`${RED}Failed: ${failedTests}${RESET}`);

if (failedTests > 0) {
  console.log(`\n${RED}Regression tests failed.${RESET}`);
  process.exit(1);
}

console.log(`\n${GREEN}LOINC structured content regression tests passed.${RESET}`);
