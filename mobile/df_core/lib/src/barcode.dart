import 'package:flutter/material.dart';

/// Code 128 bar widths, as the API's labels and slips draw them (apps/api/src/modules/documents/pdf/code128.ts):
/// code set B for text, set C for runs of 4+ digits.
const _patterns = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', //
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

int _digitRun(String s, int i) {
  var n = 0;
  while (i + n < s.length && s.codeUnitAt(i + n) >= 48 && s.codeUnitAt(i + n) <= 57) {
    n++;
  }
  return n;
}

List<int> code128Values(String text) {
  final s = String.fromCharCodes(text.codeUnits.where((c) => c >= 32 && c <= 126));
  if (s.isEmpty) return const [];
  final values = <int>[];
  var setC = false;
  final leading = _digitRun(s, 0);
  if (leading % 2 == 0 && (leading >= 4 || (leading >= 2 && leading == s.length))) {
    setC = true;
    values.add(105);
  } else {
    values.add(104);
  }
  var i = 0;
  while (i < s.length) {
    final run = _digitRun(s, i);
    if (setC) {
      if (run >= 2) {
        values.add(int.parse(s.substring(i, i + 2)));
        i += 2;
        continue;
      }
      values.add(100);
      setC = false;
      continue;
    }
    final tail = i + run == s.length;
    if (run >= (tail ? 4 : 6)) {
      if (run % 2 == 1) {
        values.add(s.codeUnitAt(i) - 32);
        i++;
      }
      values.add(99);
      setC = true;
      continue;
    }
    values.add(s.codeUnitAt(i) - 32);
    i++;
  }
  var check = values[0];
  for (var k = 1; k < values.length; k++) {
    check += values[k] * k;
  }
  values
    ..add(check % 103)
    ..add(106);
  return values;
}

/// Module widths (bar, space, bar, …).
List<int> code128Widths(String text) => [
  for (final v in code128Values(text)) ...[for (final c in _patterns[v].split('')) int.parse(c)],
];

/// A Code 128 barcode (a cash slip's number for the hub to scan), with quiet zones on a white background.
class Code128Barcode extends StatelessWidget {
  const Code128Barcode(this.value, {super.key, this.height = 70});
  final String value;
  final double height;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.white,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: SizedBox(
        height: height,
        width: double.infinity,
        child: CustomPaint(painter: _BarsPainter(code128Widths(value))),
      ),
    );
  }
}

class _BarsPainter extends CustomPainter {
  _BarsPainter(this.widths);
  final List<int> widths;

  @override
  void paint(Canvas canvas, Size size) {
    final total = widths.fold<int>(0, (a, b) => a + b);
    if (total == 0) return;
    final unit = size.width / total;
    final paint = Paint()..color = Colors.black;
    var x = 0.0;
    for (var i = 0; i < widths.length; i++) {
      final w = widths[i] * unit;
      if (i.isEven) canvas.drawRect(Rect.fromLTWH(x, 0, w, size.height), paint);
      x += w;
    }
  }

  @override
  bool shouldRepaint(_BarsPainter old) => old.widths != widths;
}
