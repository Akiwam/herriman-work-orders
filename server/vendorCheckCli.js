// Run the vendor conformance check from the command line (STORY-009, REQ-054).
//
//   VENDOR_KEY=hwo_… npm run vendor:check -- --vendor lama --base-url https://test.example
//
// The key is read from the VENDOR_KEY environment variable, not a command-line flag, so it does not
// end up in shell history or process listings. It is never printed. Exit code 0 = passed, 1 = failed,
// 2 = wrong usage.

import { parseArgs } from 'node:util';
import { runVendorCheck, formatReport } from './vendorCheck.js';

const { values } = parseArgs({
  options: {
    vendor: { type: 'string' }, 'base-url': { type: 'string' },
    'timeout-ms': { type: 'string', default: '5000' }, attempts: { type: 'string', default: '3' },
  },
});
const key = process.env.VENDOR_KEY;
if (!values.vendor || !values['base-url'] || !key) {
  console.error('Usage: VENDOR_KEY=<the vendor key> npm run vendor:check -- --vendor <madison_ai|lama|sprypoint> --base-url <url>');
  process.exit(2);
}

const report = await runVendorCheck({
  baseUrl: values['base-url'], vendor: values.vendor, key,
  timeoutMs: Number(values['timeout-ms']), attempts: Number(values.attempts),
});
console.log(formatReport(report));
process.exit(report.passed ? 0 : 1);
