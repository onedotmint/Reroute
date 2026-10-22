// Explicit cloud-acceptance fixture; not part of the default local test suite.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
assert.equal(process.platform, 'linux');
assert.match(process.env.REROUTE_JOB_ID ?? '', /^[0-9a-f-]{36}$/);
assert.equal(existsSync('.reroute.json'), false);
assert.equal(existsSync('.git'), false);
const sourceSha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
process.stdout.write(JSON.stringify({ marker: 'REROUTE_DAYTONA_LIVE_OK', jobId: process.env.REROUTE_JOB_ID, node: process.version, platform: process.platform, sourceSha256 }) + '\n');
process.stderr.write('REROUTE_DAYTONA_STDERR_OK\n');
