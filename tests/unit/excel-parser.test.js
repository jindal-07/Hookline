import { describe, it, expect } from "vitest";
import { parseSpreadsheet, parseCount, detectSpreadsheetType, validationReportCsv } from "../../server/src/services/excel/ExcelParser.js";
import { makeWorkbook, SAMPLE_ROWS } from "../fixtures/spreadsheets.js";

const allowedHosts = ["facebook.com", "www.facebook.com", "m.facebook.com", "fb.watch"];
const parse = (buf, filename = "videos.xlsx", opts = {}) => parseSpreadsheet(buf, { filename, allowedHosts, ...opts });

describe("ExcelParser", () => {
  it("parses rows, detects the URL column case-insensitively and keeps row numbers", () => {
    const r = parse(makeWorkbook(SAMPLE_ROWS));
    expect(r.columns.video_url).toBe("Video_URL");
    expect(r.columns.optional_found).toEqual(["title", "category", "views", "likes"]);
    expect(r.rows.map(x => x.row)).toEqual([2, 3, 5, 6, 7]); // blank row 4 skipped
    const first = r.rows[0];
    expect(first).toMatchObject({ valid: true, normalized_url: "https://www.facebook.com/reel/1111111111111", title: "Maid's secret", views: 250000, likes: 1200, external_id: "1111111111111" });
  });

  it("validates each row independently and reports duplicates and invalid URLs", () => {
    const r = parse(makeWorkbook(SAMPLE_ROWS));
    expect(r.summary).toEqual({ total_rows: 5, valid: 2, invalid: 3, duplicates: 1 });
    expect(r.rows.find(x => x.row === 5)).toMatchObject({ valid: false, duplicate_of: 2 });
    expect(r.rows.find(x => x.row === 6).errors[0].code).toBe("HOST_NOT_ALLOWED");
    const bad = r.rows.find(x => x.row === 7);
    expect(bad.errors[0].code).toBe("MALFORMED");
    expect(bad.warnings[0]).toMatch(/views/);
  });

  it("finds a header row below title rows and supports .xls", () => {
    const buf = makeWorkbook(SAMPLE_ROWS.slice(0, 3), { bookType: "biff8", leadingRows: [["Weekly viral list"], []] });
    expect(detectSpreadsheetType(buf)).toBe("xls");
    const r = parse(buf, "old.xls");
    expect(r.header_row).toBe(3);
    expect(r.rows[0].row).toBe(4);
    expect(r.summary.valid).toBe(2);
  });

  it("rejects non-spreadsheets, missing URL column and oversized sheets", () => {
    expect(() => parse(Buffer.from("hello"), "x.xlsx")).toThrow(/not a valid Excel/);
    expect(() => parse(makeWorkbook(SAMPLE_ROWS), "x.csv")).toThrow(/not a valid CSV/); // binary workbook renamed to .csv
    expect(() => parse(makeWorkbook(SAMPLE_ROWS), "x.txt")).toThrow(/Only .xlsx, .xls and .csv/);
    expect(() => parse(makeWorkbook([["url", "title"], ["https://www.facebook.com/reel/1111111111111", "x"]]))).toThrow(/No "video_url" column/);
    const many = [["video_url"], ...Array.from({ length: 6 }, (_, i) => [`https://www.facebook.com/reel/1${i}00000000000`])];
    expect(() => parse(makeWorkbook(many), "m.xlsx", { maxRows: 5 })).toThrow(/Too many rows/);
  });

  it("parses engagement counts", () => {
    expect(parseCount("250,000").value).toBe(250000);
    expect(parseCount("1.5M").value).toBe(1500000);
    expect(parseCount(42).value).toBe(42);
    expect(parseCount("").value).toBeNull();
    expect(parseCount("abc").error).toBeTruthy();
  });

  it("produces a downloadable CSV report of problem rows", () => {
    const csv = validationReportCsv(parse(makeWorkbook(SAMPLE_ROWS)));
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("row,video_url,error_codes,errors,warnings");
    expect(lines).toHaveLength(4);
    expect(csv).toContain("DUPLICATE");
  });
});
