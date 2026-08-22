/**
 * The one check worth having: section extraction.
 *
 * Everything else in main.js is either Obsidian API plumbing or the library's
 * job. This is the only place the plugin decides something on its own, and it
 * has two ways to be wrong that you cannot hear until you have listened to the
 * wrong half of a note: cutting at the wrong heading level, and cutting at a
 * `#` inside a code fence.
 *
 * Run: node test.mjs
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { sectionRange, estimateSeconds, formatTime } = createRequire(import.meta.url)('./main.js')

const lines = [
  '# Title', // 0
  'Intro.', // 1
  '## A', // 2
  'Body of A.', // 3
  '### A1', // 4
  'Body of A1.', // 5
  '```md', // 6
  '## not a heading', // 7
  '```', // 8
  'Tail of A1.', // 9
  '## B', // 10
  'Body of B.', // 11
]

// `## A` owns A, A1 and the fenced block — and stops before `## B`.
assert.deepEqual(sectionRange(lines, 2), [2, 10])

// `### A1` stops at the next same-or-higher heading, which is `## B`.
assert.deepEqual(sectionRange(lines, 4), [4, 10])

// A `##` inside a fence is not a heading. Without fence tracking this would
// have been [2, 7] above and read half a section.
assert.deepEqual(sectionRange(lines, 2).at(1), 10)

// `# Title` owns the whole document.
assert.deepEqual(sectionRange(lines, 0), [0, 12])

// The last heading runs to the end of the file.
assert.deepEqual(sectionRange(lines, 10), [10, 12])

// A non-heading line is its own one-line range, never a crash.
assert.deepEqual(sectionRange(lines, 3), [3, 4])
assert.deepEqual(sectionRange(lines, 999), [999, 1000])

// A tilde fence does not close a backtick fence.
assert.deepEqual(sectionRange(['## A', '```', '~~~', '## inside', '```', '## B'], 0), [0, 5])

// Estimates are never zero: a zero-length segment would make the scrubber's
// total collapse and the bar jump when the real duration arrives.
assert.equal(estimateSeconds(0), 1)
assert.equal(estimateSeconds(140), 10)
assert.equal(estimateSeconds(undefined), 1)

assert.equal(formatTime(0), '0:00')
assert.equal(formatTime(61.7), '1:01')
assert.equal(formatTime(-5), '0:00')
assert.equal(formatTime(NaN), '0:00')

console.log('all checks passed')
