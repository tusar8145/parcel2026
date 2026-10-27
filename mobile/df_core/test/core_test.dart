import 'package:df_core/df_core.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('a scanned code becomes the tracking ID the API takes', () {
    expect(normalizeScan(' *ep-261026-abcde* '), 'EP-261026-ABCDE');
    expect(normalizeScan('https://paira-express.imagine-design.net/track/EP-261026-ABCDE?t=x'), 'EP-261026-ABCDE');
  });

  test('Code 128 matches the API encoder: start B, set C for a digit tail, check digit and stop', () {
    // "HS-261026-0005": text in set B, the tail "0005" in set C (values as code128.ts produces them).
    final v = code128Values('HS-261026-0005');
    expect(v.first, 104);
    expect(v.last, 106);
    expect(v.contains(99), isTrue);
    var check = v[0];
    for (var k = 1; k < v.length - 2; k++) {
      check += v[k] * k;
    }
    expect(v[v.length - 2], check % 103);
    // Every symbol is 11 modules wide (the stop 13): bars and spaces alternate.
    expect(code128Widths('EP-261026-ABCDE').fold<int>(0, (a, b) => a + b), (code128Values('EP-261026-ABCDE').length - 1) * 11 + 13);
  });
}
