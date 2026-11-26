#!/usr/bin/env node
// CI helper: read vitest's JSON report, print one GitHub annotation per failed
// test (annotations are readable without signing in, unlike job logs) and exit 1
// when anything failed. Usage: node scripts/ci-test-report.mjs test-results.json
import fs from "node:fs";
import path from "node:path";

const file = process.argv[2] ?? "test-results.json";
const MAX_ANNOTATIONS = 10; // GitHub shows at most 10 error annotations per step

// Workflow-command escaping (https://docs.github.com/actions/reference/workflow-commands-for-github-actions)
const escData = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = (s) => escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
const clean = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, "").slice(0, 1800);

if (!fs.existsSync(file)) {
    console.log(`::error title=${escProp("No test report")}::${escData(`${file} was not written: vitest stopped before reporting.`)}`);
    process.exit(1);
}

const report = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
let shown = 0;
const annotate = (relFile, title, message) => {
    if (shown >= MAX_ANNOTATIONS) return;
    shown++;
    console.log(`::error file=${escProp(relFile)},title=${escProp(title)}::${escData(clean(message))}`);
};

for (const suite of report.testResults ?? []) {
    const relFile = path.relative(process.cwd(), suite.name ?? "").split(path.sep).join("/");
    const failedTests = (suite.assertionResults ?? []).filter((a) => a.status === "failed");
    for (const t of failedTests) {
        annotate(relFile, t.fullName ?? t.title ?? "test", (t.failureMessages ?? []).join("\n") || "(no message)");
    }
    // A suite can fail without a failed test: import error, failing hook.
    if (suite.status === "failed" && failedTests.length === 0) {
        annotate(relFile, "suite failed", suite.message || "(no message)");
    }
}

const failedTests = report.numFailedTests ?? 0;
const failedSuites = report.numFailedTestSuites ?? 0;
if (failedTests > 0 || failedSuites > 0 || report.success === false) {
    console.error(`${failedTests} test(s) failed, ${failedSuites} suite(s) failed`);
    process.exit(1);
}
console.log(`${report.numPassedTests} tests passed`);
