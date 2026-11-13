import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'api.dart';
import 'scanner.dart';
import 'widgets.dart';

/// The CN_ features on pre-printed CN labels (Ops and Rider apps), in any order:
///   CN_Merchant  choose a merchant, then scan labels one after another: each becomes that merchant's parcel.
///   CN_Scan      the camera stays on; with the CN barcode in the frame, Capture sends the photo and the server's AI
///                reads the recipient into that CN's parcel. A merchant can be chosen first (optional).
/// The first scan of a label creates its parcel (POST /cn/parcels/merchant, /cn/parcels/capture); later scans add to it.

/// Chooses an active merchant (GET /cn/merchants?q=). Null when cancelled.
Future<Map<String, dynamic>?> pickCnMerchant(BuildContext context) {
  return showModalBottomSheet<Map<String, dynamic>>(
    context: context,
    isScrollControlled: true,
    builder: (_) => const _MerchantPicker(),
  );
}

class _MerchantPicker extends StatefulWidget {
  const _MerchantPicker();
  @override
  State<_MerchantPicker> createState() => _MerchantPickerState();
}

class _MerchantPickerState extends State<_MerchantPicker> {
  final _q = TextEditingController();
  List<Map<String, dynamic>> _items = [];
  bool _loading = true;
  String? _error;
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _q.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final r = await Api.get('/cn/merchants', {'q': _q.text.trim()});
      if (!mounted) return;
      setState(() {
        _items = ((r['items'] as List?) ?? []).cast<Map<String, dynamic>>();
        _error = null;
        _loading = false;
      });
    } catch (e) {
      if (mounted) setState(() => (_error = errorText(e), _loading = false));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * .75,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
              child: TextField(
                controller: _q,
                autofocus: true,
                decoration: const InputDecoration(prefixIcon: Icon(Icons.search), labelText: 'Merchant name, code or phone'),
                onChanged: (_) {
                  _debounce?.cancel();
                  _debounce = Timer(const Duration(milliseconds: 350), _load);
                },
              ),
            ),
            if (_loading) const LinearProgressIndicator(minHeight: 2),
            if (_error != null) Padding(padding: const EdgeInsets.all(12), child: Text(_error!, style: const TextStyle(color: bad))),
            Expanded(
              child: ListView.separated(
                itemCount: _items.length,
                separatorBuilder: (_, _) => const Divider(height: 1),
                itemBuilder: (_, i) {
                  final m = _items[i];
                  return ListTile(
                    title: Text('${m['name']}', style: const TextStyle(fontWeight: FontWeight.w700)),
                    subtitle: Text('${m['code']} · ${m['type'] == 'BANKING_FINANCIAL' ? 'Banking & Financial' : 'E-commerce'}'),
                    onTap: () => Navigator.pop(context, m),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// CN_Merchant: choose the merchant, then scan the labels; each becomes (or is given to) that merchant's parcel.
Future<void> openCnMerchant(BuildContext context, {String? hubId}) async {
  final m = await pickCnMerchant(context);
  if (m == null || !context.mounted) return;
  await scanBarcode(
    context,
    title: 'CN_Merchant · ${m['name']}',
    hint: 'Scan each CN label: the parcel becomes ${m['name']}\'s.',
    continuous: true,
    onCode: (code, source) async {
      final r = await Api.post('/cn/parcels/merchant', {'cn': code, 'merchantId': m['id'], 'hubId': ?hubId});
      return ScanFeedback(r['ok'] != false, '${r['message'] ?? code}');
    },
  );
}

/// CN_Scan: opens the live camera page.
Future<void> openCnScan(BuildContext context, {String? hubId}) {
  return Navigator.of(context).push(MaterialPageRoute(builder: (_) => CnScanPage(hubId: hubId)));
}

class _Sent {
  _Sent(this.cn, this.photo);
  final String cn;
  final Uint8List photo;
  String state = 'sending';
  String message = 'Sending…';
}

class CnScanPage extends StatefulWidget {
  const CnScanPage({super.key, this.hubId});
  final String? hubId;
  @override
  State<CnScanPage> createState() => _CnScanPageState();
}

class _CnScanPageState extends State<CnScanPage> {
  // The frame is kept with each read so Capture can send the photo of what is in front of the camera.
  final _controller = MobileScannerController(
    formats: const [BarcodeFormat.code128, BarcodeFormat.code39, BarcodeFormat.qrCode],
    returnImage: true,
    cameraResolution: const Size(1920, 1080),
  );
  Map<String, dynamic>? _merchant;
  String? _cn;
  Uint8List? _frame;
  DateTime _seenAt = DateTime(2000);
  final List<_Sent> _sent = [];
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    // Re-checks whether the label is still in view (the Capture button and the "in view" text).
    _tick = Timer.periodic(const Duration(milliseconds: 500), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    _controller.dispose();
    super.dispose();
  }

  bool get _inView => _cn != null && _frame != null && DateTime.now().difference(_seenAt) < const Duration(seconds: 2);

  void _onDetect(BarcodeCapture capture) {
    for (final b in capture.barcodes) {
      final v = b.rawValue;
      if (v == null || v.trim().isEmpty) continue;
      final code = normalizeScan(v);
      if (!RegExp(r'^[A-Z]{2,4}-\d{6}-[0-9A-Z]{4,8}$').hasMatch(code)) continue;
      _cn = code;
      if (capture.image != null) _frame = capture.image;
      _seenAt = DateTime.now();
      return;
    }
  }

  Future<void> _capture() async {
    if (!_inView) return;
    final item = _Sent(_cn!, _frame!);
    Beep.ok();
    setState(() {
      _sent.insert(0, item);
      if (_sent.length > 20) _sent.removeLast();
    });
    try {
      final r = await Api.upload(
        '/cn/parcels/capture',
        fields: {'cn': item.cn, 'hubId': ?widget.hubId, 'merchantId': ?(_merchant?['id'] as String?)},
        bytes: item.photo,
        filename: '${item.cn}.jpg',
      );
      item
        ..state = 'sent'
        ..message = '${r['outcome'] == 'CREATED' ? 'New parcel' : 'Added'} · ${r['reading'] == true ? 'reading the label…' : 'photo kept'}';
    } catch (e) {
      Beep.error();
      item
        ..state = 'failed'
        ..message = errorText(e);
    }
    if (mounted) setState(() {});
  }

  Future<void> _retry(_Sent item) async {
    setState(() {
      item.state = 'sending';
      item.message = 'Sending…';
    });
    try {
      await Api.upload('/cn/parcels/capture', fields: {'cn': item.cn, 'hubId': ?widget.hubId, 'merchantId': ?(_merchant?['id'] as String?)}, bytes: item.photo, filename: '${item.cn}.jpg');
      item
        ..state = 'sent'
        ..message = 'Sent';
    } catch (e) {
      item
        ..state = 'failed'
        ..message = errorText(e);
    }
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final inView = _inView;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        surfaceTintColor: Colors.black,
        title: const Text('CN_Scan'),
        actions: [
          IconButton(tooltip: 'Light', onPressed: () => _controller.toggleTorch(), icon: const Icon(Icons.flashlight_on_outlined)),
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Done', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
          ),
        ],
      ),
      body: Column(
        children: [
          Container(
            color: Colors.white,
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
            child: Row(
              children: [
                const Icon(Icons.storefront_outlined, color: muted, size: 20),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    _merchant == null ? 'Merchant: not chosen (optional)' : 'Merchant: ${_merchant!['name']}',
                    style: const TextStyle(fontWeight: FontWeight.w600),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                if (_merchant != null) IconButton(tooltip: 'Clear', onPressed: () => setState(() => _merchant = null), icon: const Icon(Icons.close, size: 20)),
                TextButton(
                  onPressed: () async {
                    final m = await pickCnMerchant(context);
                    if (m != null && mounted) setState(() => _merchant = m);
                  },
                  child: Text(_merchant == null ? 'Choose' : 'Change'),
                ),
              ],
            ),
          ),
          Expanded(
            child: Stack(
              fit: StackFit.expand,
              children: [
                MobileScanner(
                  controller: _controller,
                  onDetect: _onDetect,
                  errorBuilder: (context, error) => Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text('The camera is not available (${error.errorCode.name}). Allow camera access in the phone settings.', textAlign: TextAlign.center, style: const TextStyle(color: Colors.white)),
                    ),
                  ),
                ),
                IgnorePointer(
                  child: Center(
                    child: FractionallySizedBox(
                      widthFactor: .86,
                      heightFactor: .7,
                      child: Container(
                        decoration: BoxDecoration(border: Border.all(color: inView ? good : Colors.white, width: 2.5), borderRadius: BorderRadius.circular(16)),
                      ),
                    ),
                  ),
                ),
                Positioned(
                  left: 12,
                  right: 12,
                  top: 12,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    decoration: BoxDecoration(color: Colors.black.withValues(alpha: .55), borderRadius: BorderRadius.circular(10)),
                    child: Text(
                      inView ? 'CN in view: $_cn' : 'Bring the parcel into the frame with its CN barcode and the recipient\'s details.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: inView ? const Color(0xFF6CE9A6) : Colors.white, fontWeight: FontWeight.w700),
                    ),
                  ),
                ),
              ],
            ),
          ),
          Container(
            color: Colors.white,
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
            child: SafeArea(
              top: false,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SizedBox(
                    height: 56,
                    child: FilledButton.icon(
                      onPressed: inView ? _capture : null,
                      icon: const Icon(Icons.camera_alt),
                      label: Text(inView ? 'Capture $_cn' : 'Capture (CN not in view)', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
                    ),
                  ),
                  if (_sent.isNotEmpty) const SizedBox(height: 8),
                  for (final s in _sent.take(4))
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Row(
                        children: [
                          Icon(
                            s.state == 'sent' ? Icons.check_circle : (s.state == 'failed' ? Icons.error : Icons.cloud_upload_outlined),
                            size: 18,
                            color: s.state == 'sent' ? good : (s.state == 'failed' ? bad : muted),
                          ),
                          const SizedBox(width: 6),
                          Text(s.cn, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 12.5)),
                          const SizedBox(width: 6),
                          Expanded(child: Text(s.message, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: muted, fontSize: 12.5))),
                          if (s.state == 'failed') TextButton(onPressed: () => _retry(s), child: const Text('Retry')),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
