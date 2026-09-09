import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

test('the pager always offers the first and last page', async () => {
  const { pageNumbers } = await import('../src/dashboard.js');

  assert.deepEqual(pageNumbers(1, 1), [1], 'one page needs no gaps');
  assert.deepEqual(pageNumbers(1, 3), [1, 2, 3], 'short runs are shown whole');
  assert.deepEqual(pageNumbers(1, 20), [1, 2, 3, 'gap', 20]);
  assert.deepEqual(pageNumbers(10, 20), [1, 'gap', 8, 9, 10, 11, 12, 'gap', 20]);
  assert.deepEqual(pageNumbers(20, 20), [1, 'gap', 18, 19, 20]);

  // A gap must never stand in for a single page — "1 … 3" hides page 2 behind
  // an ellipsis that cannot be clicked.
  for (let pages = 1; pages <= 40; pages++) {
    for (let current = 1; current <= pages; current++) {
      const out = pageNumbers(current, pages);
      assert.ok(out.includes(1) && out.includes(pages), `${current}/${pages}: ends missing`);
      assert.ok(out.includes(current), `${current}/${pages}: current page missing`);
      const nums = out.filter((n) => n !== 'gap');
      assert.deepEqual([...nums].sort((a, b) => a - b), nums, `${current}/${pages}: out of order`);
      out.forEach((n, i) => {
        if (n !== 'gap') return;
        assert.ok(out[i + 1] - out[i - 1] > 2,
          `${current}/${pages}: an ellipsis is hiding exactly one page`);
      });
    }
  }
});
