// Exhaustive check of the 4-way monotone search used for wallet age.
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchFirstTrue } from "../src/chain.mjs";

test("finds the first true block for every boundary in small ranges", async () => {
  for (let hi = 0; hi <= 40; hi++) {
    for (let answer = 0; answer <= hi; answer++) {
      let probes = 0;
      const got = await searchFirstTrue(0, hi, async (b) => {
        probes++;
        return b >= answer;
      });
      assert.equal(got, answer, `hi=${hi} answer=${answer}`);
      assert.ok(probes <= 3 * 8, `bounded probes (${probes})`);
    }
  }
});

test("stays within about 14 rounds over Arc-sized history", async () => {
  const answer = 21_167_692;
  let rounds = 0;
  const got = await searchFirstTrue(0, 24_727_000, async (b) => {
    rounds++;
    return b >= answer;
  });
  assert.equal(got, answer);
  assert.ok(rounds <= 3 * 14, `probes ${rounds}`);
});
