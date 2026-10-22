export const statuses = ["pass", "partial_pass", "fail", "skipped"];
export function resultError(status, comment) {
  if (!statuses.includes(status)) return "Choose an outcome.";
  if (typeof comment !== "string" || comment.length > 3000)
    return "Comments must be at most 3,000 characters.";
  if (["fail", "partial_pass"].includes(status) && comment.trim().length < 2)
    return "Fail and Partial pass require a comment of at least 2 characters.";
  return "";
}
export const QUICK =
  "A01,A02,A03,A04,A07,A09,B01,B03,B11,B12,C01,C03,D01,D02,D07,D14,D16,F04,F07,G02,G06,H02,H03,H04,H05,I01,J04,K03,K09,L01,M02,N02".split(
    ",",
  );
