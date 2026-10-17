/**
 * Code 128 (ISO/IEC 15417) bar widths for tracking IDs and CNs. Code set B for text, switching to
 * code set C for runs of 4+ digits (shorter bars for numeric tails). Returns module widths
 * alternating bar / space, starting with a bar, including the quiet-zone-free start, check and stop.
 */
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];
const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const CODE_C = 99;
const STOP = 106;

const digitRun = (s: string, i: number) => {
  let n = 0;
  while (i + n < s.length && s.charCodeAt(i + n) >= 48 && s.charCodeAt(i + n) <= 57) n++;
  return n;
};

/** Symbol values (start … data … check, stop) for `text` (printable ASCII 32–126). */
export function code128Values(text: string): number[] {
  const s = [...text].filter(ch => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) <= 126).join("");
  if (!s) throw new Error("Code 128 needs at least one printable ASCII character");
  const values: number[] = [];
  let set: "B" | "C";
  let i = 0;
  const leading = digitRun(s, 0);
  if (leading % 2 === 0 && (leading >= 4 || (leading >= 2 && leading === s.length))) {
    set = "C";
    values.push(START_C);
  } else {
    set = "B";
    values.push(START_B);
  }
  while (i < s.length) {
    const run = digitRun(s, i);
    if (set === "C") {
      if (run >= 2) {
        values.push(Number(s.slice(i, i + 2)));
        i += 2;
        continue;
      }
      values.push(CODE_B);
      set = "B";
      continue;
    }
    // Set B: switch to C for an even-length tail run of 4+ digits (or 6+ in the middle).
    const tail = i + run === s.length;
    if (run >= (tail ? 4 : 6)) {
      if (run % 2 === 1) {
        values.push(s.charCodeAt(i) - 32);
        i++;
      }
      values.push(CODE_C);
      set = "C";
      continue;
    }
    values.push(s.charCodeAt(i) - 32);
    i++;
  }
  let check = values[0];
  for (let k = 1; k < values.length; k++) check += values[k] * k;
  values.push(check % 103, STOP);
  return values;
}

/** Module widths (bar, space, bar, …) for `text`. */
export function code128Widths(text: string): number[] {
  return code128Values(text).flatMap(v => [...PATTERNS[v]].map(Number));
}
