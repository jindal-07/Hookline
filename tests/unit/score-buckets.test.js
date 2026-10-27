import { describe, it, expect } from "vitest";
import { scoreBuckets } from "../../server/src/services/queries.js";

describe("score distribution buckets", () => {
  // the live data that prompted this: 6 in 70–74, 31 in 75–79, threshold 75
  const rows = [
    { bucket: 7, above: false, n: 6 }, { bucket: 7, above: true, n: 31 },
    { bucket: 8, above: true, n: 252 }, { bucket: 9, above: true, n: 111 },
  ];

  it("splits the bucket the threshold falls in", () => {
    const b = scoreBuckets(rows, 75);
    expect(b).toHaveLength(11);
    expect(b.find(x => x.bucket === "70–74")).toMatchObject({ count: 6, above: false });
    expect(b.find(x => x.bucket === "75–79")).toMatchObject({ count: 31, above: true });
    expect(b.filter(x => x.above).reduce((t, x) => t + x.count, 0)).toBe(394);
  });

  it("keeps ten buckets when the threshold is on a boundary", () => {
    const b = scoreBuckets(rows, 80);
    expect(b).toHaveLength(10);
    expect(b.find(x => x.bucket === "70–79")).toMatchObject({ count: 37, above: false });
    expect(b.find(x => x.bucket === "80–89").above).toBe(true);
  });
});
