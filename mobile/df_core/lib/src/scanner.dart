import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'widgets.dart';

/// The scanner's sound: a short beep for a good scan, an error tone for a refused one (the app's
/// "deliveryfast/beep" channel, Android's tone generator), with a vibration; the system click if missing.
class Beep {
  static const _channel = MethodChannel('deliveryfast/beep');

  static Future<void> ok() async {
    HapticFeedback.mediumImpact();
    try {
      await _channel.invokeMethod('ok');
    } catch (_) {
      SystemSound.play(SystemSoundType.click);
    }
  }

  static Future<void> error() async {
    HapticFeedback.heavyImpact();
    try {
      await _channel.invokeMethod('error');
    } catch (_) {}
  }
}

/// What happened to a scanned code: shown under the camera (green / red). [close] ends a continuous scan.
class ScanFeedback {
  const ScanFeedback(this.ok, this.message, {this.close = false});
  final bool ok;
  final String message;
  final bool close;
}

/// Handles a code: CAMERA (scanned) or KEYBOARD (typed with "Type it").
typedef ScanHandler = Future<ScanFeedback?> Function(String code, String source);

/// A label's code as the API takes it: the tracking ID (Code128 on the labels), upper case; a tracking
/// link (…/track/EP-261026-ABCDE) gives its ID.
String normalizeScan(String raw) {
  var v = raw.trim().replaceAll(RegExp(r'^\*+|\*+$'), '');
  final link = RegExp(r'/track/([A-Za-z0-9-]+)').firstMatch(v);
  if (link != null) v = link.group(1)!;
  return v.toUpperCase();
}

/// Opens the camera scanner. Without [onCode] it returns the first code read; with it, each code is handed
/// to [onCode] and (when [continuous]) the camera stays open for the next parcel.
Future<String?> scanBarcode(
  BuildContext context, {
  String title = 'Scan barcode',
  String hint = 'Point the camera at the barcode on the label.',
  ScanHandler? onCode,
  bool continuous = false,
  ValueListenable<String>? status,
}) {
  return Navigator.of(context).push<String>(
    MaterialPageRoute(
      builder: (_) => ScannerPage(title: title, hint: hint, onCode: onCode, continuous: continuous, status: status),
    ),
  );
}

class ScannerPage extends StatefulWidget {
  const ScannerPage({super.key, required this.title, required this.hint, this.onCode, this.continuous = false, this.status});
  final String title;
  final String hint;
  final ScanHandler? onCode;
  final bool continuous;

  /// A line under the result (e.g. "3 of 5 scanned"), kept up to date by the caller.
  final ValueListenable<String>? status;

  @override
  State<ScannerPage> createState() => _ScannerPageState();
}

class _ScannerPageState extends State<ScannerPage> {
  final _controller = MobileScannerController(formats: const [BarcodeFormat.code128, BarcodeFormat.code39, BarcodeFormat.qrCode, BarcodeFormat.ean13]);
  bool _busy = false;

  /// Handheld scanners (Zebra, Honeywell…) type the code and Enter like a keyboard: an invisible field takes
  /// it without opening the phone's keyboard.
  final _wedge = TextEditingController();
  final _wedgeFocus = FocusNode();
  ScanFeedback? _last;

  /// The scans of this session, newest first (shown under the result).
  final List<(String, ScanFeedback)> _history = [];
  String? _lastCode;
  DateTime _lastAt = DateTime(2000);
  int _count = 0;

  @override
  void dispose() {
    _wedge.dispose();
    _wedgeFocus.dispose();
    _controller.dispose();
    super.dispose();
  }

  Future<void> _handle(String raw, String source) async {
    final code = normalizeScan(raw);
    if (code.isEmpty || _busy) return;
    // The same label held in front of the camera is read many times a second: once is enough.
    if (code == _lastCode && DateTime.now().difference(_lastAt) < const Duration(seconds: 3)) return;
    _lastCode = code;
    _lastAt = DateTime.now();
    if (widget.onCode == null) {
      Beep.ok();
      Navigator.of(context).pop(code);
      return;
    }
    setState(() => _busy = true);
    ScanFeedback? result;
    try {
      result = await widget.onCode!(code, source);
    } catch (e) {
      result = ScanFeedback(false, errorText(e));
    }
    if (!mounted) return;
    final ok = result?.ok ?? true;
    ok ? Beep.ok() : Beep.error();
    setState(() {
      _busy = false;
      _last = result;
      if (result != null) _history.insert(0, (code, result));
      if (_history.length > 6) _history.removeLast();
      if (ok) _count++;
    });
    if (result?.close == true || (!widget.continuous && ok)) Navigator.of(context).pop(code);
  }

  Future<void> _type() async {
    final input = TextEditingController();
    final code = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Type the tracking ID'),
        content: TextField(
          controller: input,
          autofocus: true,
          textCapitalization: TextCapitalization.characters,
          decoration: const InputDecoration(hintText: 'e.g. EP-261026-ABCDE'),
          onSubmitted: (v) => Navigator.pop(context, v),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, input.text), child: const Text('OK')),
        ],
      ),
    );
    if (code != null && code.trim().isNotEmpty) {
      _lastCode = null;
      await _handle(code, 'KEYBOARD');
      _wedgeFocus.requestFocus();
    }
  }

  @override
  Widget build(BuildContext context) {
    final last = _last;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        surfaceTintColor: Colors.black,
        title: Text(widget.title),
        actions: [
          IconButton(tooltip: 'Torch', onPressed: () => _controller.toggleTorch(), icon: const Icon(Icons.flashlight_on_outlined)),
          if (widget.continuous)
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text(
                'Done',
                style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700),
              ),
            ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: Stack(
              fit: StackFit.expand,
              children: [
                MobileScanner(
                  controller: _controller,
                  onDetect: (capture) {
                    for (final b in capture.barcodes) {
                      final v = b.rawValue;
                      if (v != null && v.trim().isNotEmpty) {
                        _handle(v, 'CAMERA');
                        break;
                      }
                    }
                  },
                  errorBuilder: (context, error) => Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(
                        'The camera is not available (${error.errorCode.name}). Allow camera access in the phone settings, or type the tracking ID.',
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Colors.white),
                      ),
                    ),
                  ),
                ),
                Center(
                  child: Container(
                    width: 280,
                    height: 160,
                    decoration: BoxDecoration(
                      border: Border.all(color: Colors.white, width: 2.5),
                      borderRadius: BorderRadius.circular(14),
                    ),
                  ),
                ),
                Positioned(
                  left: 0,
                  top: 0,
                  width: 1,
                  height: 1,
                  child: Opacity(
                    opacity: 0,
                    child: TextField(
                      controller: _wedge,
                      focusNode: _wedgeFocus,
                      autofocus: true,
                      keyboardType: TextInputType.none,
                      showCursor: false,
                      onSubmitted: (v) {
                        _wedge.clear();
                        _wedgeFocus.requestFocus();
                        if (v.trim().isNotEmpty) {
                          _lastCode = null;
                          _handle(v, 'KEYBOARD');
                        }
                      },
                    ),
                  ),
                ),
                if (_busy) const Center(child: CircularProgressIndicator(color: Colors.white)),
              ],
            ),
          ),
          Container(
            width: double.infinity,
            color: Colors.white,
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 18),
            child: SafeArea(
              top: false,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (last != null)
                    Container(
                      padding: const EdgeInsets.all(10),
                      margin: const EdgeInsets.only(bottom: 8),
                      decoration: BoxDecoration(color: (last.ok ? good : bad).withValues(alpha: .1), borderRadius: BorderRadius.circular(10)),
                      child: Row(
                        children: [
                          Icon(last.ok ? Icons.check_circle : Icons.error, color: last.ok ? good : bad),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              widget.continuous ? '${last.message}\n${last.ok ? 'Ready: scan the next parcel.' : 'Scan another parcel.'}' : last.message,
                              style: TextStyle(color: last.ok ? good : bad, fontWeight: FontWeight.w600),
                            ),
                          ),
                        ],
                      ),
                    )
                  else
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(
                        widget.hint,
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: muted),
                      ),
                    ),
                  if (widget.status != null)
                    ValueListenableBuilder<String>(
                      valueListenable: widget.status!,
                      builder: (_, s, _) => s.isEmpty
                          ? const SizedBox.shrink()
                          : Padding(
                              padding: const EdgeInsets.only(bottom: 8),
                              child: Text(
                                s,
                                textAlign: TextAlign.center,
                                style: const TextStyle(fontWeight: FontWeight.w700),
                              ),
                            ),
                    )
                  else if (widget.continuous && _count > 0)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(
                        '$_count scanned',
                        textAlign: TextAlign.center,
                        style: const TextStyle(fontWeight: FontWeight.w700),
                      ),
                    ),
                  // Earlier scans of this session (the newest is in the box above).
                  if (widget.continuous && _history.length > 1)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Column(
                        children: [
                          for (final (code, r) in _history.skip(1))
                            Row(
                              children: [
                                Icon(r.ok ? Icons.check : Icons.close, size: 16, color: r.ok ? good : bad),
                                const SizedBox(width: 6),
                                Text(code, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 12.5)),
                                const SizedBox(width: 6),
                                Expanded(
                                  child: Text(
                                    r.message.replaceFirst(code, '').trim(),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(color: muted, fontSize: 12.5),
                                  ),
                                ),
                              ],
                            ),
                        ],
                      ),
                    ),
                  OutlinedButton.icon(onPressed: _busy ? null : _type, icon: const Icon(Icons.keyboard_outlined), label: const Text('Type it instead')),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
