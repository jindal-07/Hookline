// Builds Excel workbooks in memory for tests.
import * as XLSX from "xlsx";

export function makeWorkbook(rows, { bookType = "xlsx", sheetName = "Videos", leadingRows = [] } = {}) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([...leadingRows, ...rows]), sheetName);
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType }));
}

export const SAMPLE_ROWS = [
  ["Video_URL", "Title", "Category", "Views", "Likes"],
  ["https://www.facebook.com/reel/1111111111111", "Maid's secret", "Drama", "250,000", "1.2K"],
  ["https://m.facebook.com/watch/?v=2222222222222", "Office twist", "Comedy", 98000, 450],
  ["", "", "", "", ""],                                                   // blank row: ignored
  ["https://www.facebook.com/reel/1111111111111?mibextid=x", "Dup", "Drama", "", ""], // duplicate of row 2
  ["https://www.youtube.com/watch?v=abc", "Wrong host", "", "", ""],
  ["not a url", "Bad", "", "lots", ""],
];
