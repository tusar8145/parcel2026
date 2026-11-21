import 'dart:convert';

import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'home.dart';
import 'ops.dart';
import 'scan.dart' show failureReasons, loadReasons;
import 'signature_pad.dart';

/// Rider Operation: choose a rider, then do the rider app's steps for them (pickup from merchant, receive from hub,
/// start deliveries, deliver, could not deliver, returned to merchant) with the rider app's own rules
/// (/hub-desk/riders/:riderId/…). The staff member is recorded as the one who entered each step.
Future<void> openRiderOperation(BuildContext context) async {
  final id = await pickRider(context, title: 'Which rider?');
  if (id == null || !context.mounted) return;
  List<Map<String, dynamic>> riders = const [];
  try {
    riders = ((await Api.get('/riders', {'active': 'true'})) as List).cast<Map<String, dynamic>>();
  } catch (_) {}
  final match = riders.where((r) => '${r['id']}' == id).toList();
  final label = match.isEmpty ? 'the rider' : '${match.first['label'] ?? match.first['code']}';
  if (!context.mounted) return;
  await Navigator.of(context).push(MaterialPageRoute(builder: (_) => RiderOperationPage(riderId: id, riderLabel: label)));
  opsChanged.value++;
}

class RiderOperationPage extends StatelessWidget {
  const RiderOperationPage({super.key, required this.riderId, required this.riderLabel, this.base});
  final String riderId;
  final String riderLabel;

  /// Where the rider's steps go: the hub desk (operations staff), or /franchise/rider-op/{id} (a franchise's own rider).
  final String? base;

  String get _base => base ?? '/hub-desk/riders/${Uri.encodeComponent(riderId)}';

  Future<Map<String, dynamic>> _tasks() async => ((await Api.get('$_base/tasks')) as Map).cast<String, dynamic>();
  Future<List<Map<String, dynamic>>> _runs() async => ((((await Api.get('$_base/return-runs')) as Map)['items'] as List?) ?? []).cast<Map<String, dynamic>>();

  /// One step for a parcel: the API's own message when it is refused.
  Future<ScanFeedback> _post(String path, Map<String, dynamic> body, String done) async {
    try {
      await Api.post(path, body);
      return ScanFeedback(true, done);
    } on ApiError catch (e) {
      return ScanFeedback(false, e.message);
    } catch (e) {
      return ScanFeedback(false, errorText(e));
    }
  }

  Future<void> _session(BuildContext context, {required String title, required String hint, required Future<ScanFeedback> Function(String code) action, ValueNotifier<String>? status, void Function(int n)? onDone}) async {
    final s = status ?? ValueNotifier('');
    var n = 0;
    await scanBarcode(
      context,
      title: title,
      hint: hint,
      continuous: true,
      status: s,
      onCode: (code, _) async {
        final r = await action(normalizeScan(code));
        if (r.ok) {
          n++;
          if (onDone != null) {
            onDone(n);
          } else {
            s.value = '$n done for $riderLabel';
          }
        }
        return r;
      },
    );
    opsChanged.value++;
  }

  Future<T?> _load<T>(BuildContext context, Future<T> Function() load) async {
    try {
      return await load();
    } catch (e) {
      if (context.mounted) snack(context, errorText(e));
      return null;
    }
  }

  /// Pickup from merchant: choose the pickup (merchant), then scan each parcel it hands over.
  Future<void> _pickup(BuildContext context) async {
    final tasks = await _load(context, _tasks);
    if (tasks == null || !context.mounted) return;
    final pickups = ((tasks['pickups'] as List?) ?? []).cast<Map<String, dynamic>>();
    if (pickups.isEmpty) return snack(context, 'No pickups are assigned to $riderLabel.');
    final stops = <String, Map<String, dynamic>>{};
    final counts = <String, int>{};
    for (final p in pickups) {
      final stop = (p['pickupStop'] as Map?)?.cast<String, dynamic>() ?? {};
      final key = '${stop['key']}';
      stops[key] = stop;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    final key = stops.length == 1 ? stops.keys.first : await pickFromList(context, title: 'Which pickup?', items: stops.keys.toList(), labelOf: (k) => '${stops[k]!['name']} · ${counts[k]} parcel(s)');
    if (key == null || !context.mounted) return;
    final expected = counts[key] ?? 0;
    final status = ValueNotifier('0 of $expected collected');
    await _session(
      context,
      title: 'Pickup: ${stops[key]!['name']}',
      hint: 'Scan each parcel the merchant hands over ($expected expected).',
      status: status,
      onDone: (n) => status.value = '$n of $expected collected',
      action: (code) => _post('$_base/parcels/${Uri.encodeComponent(code)}/pickup', {'outcome': 'COLLECTED', 'expectedStop': key}, '$code collected by $riderLabel'),
    );
  }

  /// Receive from hub (optional): each parcel the hub gives the rider is checked against their deliveries and returns.
  Future<void> _receive(BuildContext context) async {
    final data = await _load(context, () async => (await _tasks(), await _runs()));
    if (data == null || !context.mounted) return;
    final (tasks, runs) = data;
    final deliveries = {for (final p in ((tasks['deliveries'] as List?) ?? []).cast<Map>()) '${p['trackingId']}': p};
    final returns = <String, Map>{};
    for (final r in runs) {
      for (final p in ((r['parcels'] as List?) ?? []).cast<Map>()) {
        returns['${p['trackingId']}'] = r;
      }
    }
    final status = ValueNotifier('');
    await _session(
      context,
      title: 'Receive from hub',
      hint: 'Scan each parcel the hub gives $riderLabel: for deliveries or returns.',
      status: status,
      onDone: (n) => status.value = '$n checked',
      action: (code) async {
        final d = deliveries[code];
        if (d != null) return ScanFeedback(true, '$code is $riderLabel\'s: ${d['recipientName'] ?? (d['recipient'] as Map?)?['name'] ?? ''}'.trim());
        final r = returns[code];
        if (r != null) return ScanFeedback(true, '$code is $riderLabel\'s: return to ${(r['merchant'] as Map?)?['name'] ?? 'the merchant'} (${r['number']})');
        return ScanFeedback(false, '$code is not assigned to $riderLabel. Give it with Delivery rider assign or Return rider assign.');
      },
    );
  }

  Future<void> _start(BuildContext context) async {
    final status = ValueNotifier('');
    await _session(
      context,
      title: 'Start deliveries',
      hint: 'Scan each parcel $riderLabel loads. The recipient gets the delivery code by SMS.',
      status: status,
      onDone: (n) => status.value = '$n out for delivery',
      action: (code) => _post('$_base/parcels/${Uri.encodeComponent(code)}/start-delivery', {}, '$code out for delivery · code sent to the recipient'),
    );
  }

  /// Deliver: each scan opens that parcel's delivery screen (cash and proof); then the camera comes back.
  Future<void> _deliver(BuildContext context) async {
    while (true) {
      if (!context.mounted) return;
      final code = await scanBarcode(context, title: 'Deliver', hint: 'Scan the parcel $riderLabel hands over.');
      if (code == null || !context.mounted) return;
      final id = normalizeScan(code);
      final tasks = await _load(context, _tasks);
      if (tasks == null || !context.mounted) return;
      final match = ((tasks['deliveries'] as List?) ?? []).cast<Map<String, dynamic>>().where((p) => '${p['trackingId']}' == id).toList();
      if (match.isEmpty) {
        Beep.error();
        snack(context, '$id is not one of $riderLabel\'s deliveries.');
        continue;
      }
      final done = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => OpsDeliverPage(parcel: match.first, base: _base, riderLabel: riderLabel)));
      opsChanged.value++;
      if (done != true) return;
    }
  }

  Future<void> _failed(BuildContext context) async {
    final choice = await showModalBottomSheet<(String, String, String)>(context: context, isScrollControlled: true, showDragHandle: true, builder: (_) => const _FailSheet());
    if (choice == null || !context.mounted) return;
    final (reason, next, note) = choice;
    final status = ValueNotifier('');
    await _session(
      context,
      title: 'Could not deliver',
      hint: 'Scan each parcel: $reason (${next == 'RETRY' ? 'try again' : 'return to sender'}).',
      status: status,
      onDone: (n) => status.value = '$n saved',
      action: (code) => _post(
        '$_base/parcels/${Uri.encodeComponent(code)}/delivery',
        {'outcome': 'FAILED', 'reason': reason, 'nextAction': next, if (note.isNotEmpty) 'note': note},
        '$code saved: $reason (${next == 'RETRY' ? 'try again' : 'return to sender'})',
      ),
    );
  }

  Future<void> _returned(BuildContext context) async {
    final runs = await _load(context, _runs);
    if (runs == null || !context.mounted) return;
    if (runs.isEmpty) return snack(context, 'No return runs are assigned to $riderLabel.');
    final id = runs.length == 1
        ? '${runs.first['id']}'
        : await pickFromList(
            context,
            title: 'Which return run?',
            items: runs.map((r) => '${r['id']}').toList(),
            labelOf: (id) {
              final r = runs.firstWhere((r) => '${r['id']}' == id);
              return '${r['number']} · ${(r['merchant'] as Map?)?['name'] ?? ''} · ${((r['parcels'] as List?) ?? []).length} parcel(s)';
            },
          );
    if (id == null || !context.mounted) return;
    final run = runs.firstWhere((r) => '${r['id']}' == id);
    final name = TextEditingController();
    final go = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Who is taking the parcels back?'),
        content: TextField(controller: name, decoration: const InputDecoration(labelText: 'Name (optional)')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Start scanning')),
        ],
      ),
    );
    if (go != true || !context.mounted) return;
    final total = ((run['parcels'] as List?) ?? []).length;
    final status = ValueNotifier('0 of $total returned');
    await _session(
      context,
      title: 'Return ${run['number']}',
      hint: 'Scan each parcel ${(run['merchant'] as Map?)?['name'] ?? 'the merchant'} takes back.',
      status: status,
      onDone: (n) => status.value = '$n of $total returned${n >= total ? ' · run complete' : ''}',
      action: (code) => _post(
        '$_base/parcels/${Uri.encodeComponent(code)}/return',
        {'runId': id, if (name.text.trim().isNotEmpty) 'receivedBy': name.text.trim()},
        '$code returned',
      ),
    );
  }

  Widget _task(BuildContext context, IconData icon, Color color, String title, String text, Future<void> Function(BuildContext) onTap) => Panel(
    padding: EdgeInsets.zero,
    child: ListTile(
      leading: Icon(icon, color: color),
      title: Text(title, style: const TextStyle(fontWeight: FontWeight.w800)),
      subtitle: Text(text),
      trailing: const Icon(Icons.qr_code_scanner, color: Color(0xFF98A2B3)),
      onTap: () => onTap(context),
    ),
  );

  Widget _group(String title) => Padding(
    padding: const EdgeInsets.fromLTRB(2, 14, 2, 6),
    child: Text(title.toUpperCase(), style: const TextStyle(fontWeight: FontWeight.w800, color: brand, fontSize: 12.5, letterSpacing: .6)),
  );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Rider operation · $riderLabel', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17))),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 24),
        children: [
          Text('Do $riderLabel\'s steps for them, as in the rider app. You are recorded as the one who entered them.', style: const TextStyle(color: muted)),
          _group('First mile'),
          _task(context, Icons.storefront_outlined, warn, 'Pickup from merchant', 'Choose the pickup, then scan each parcel the merchant hands over.', _pickup),
          _group('Last mile'),
          _task(context, Icons.fact_check_outlined, good, 'Receive from hub (optional)', 'Check the parcels the hub gives the rider: for deliveries or returns.', _receive),
          _task(context, Icons.local_shipping_outlined, brand, 'Start deliveries', 'Scan each parcel as it is loaded. The recipient gets the delivery code.', _start),
          _task(context, Icons.check_circle_outline, good, 'Deliver', 'Scan the parcel, then the cash and the proof.', _deliver),
          _task(context, Icons.report_gmailerrorred_outlined, bad, 'Could not deliver', 'Choose the reason and what happens next, then scan.', _failed),
          _task(context, Icons.undo, brand, 'Returned to merchant', 'Choose the return run, then scan each parcel the merchant takes back.', _returned),
        ],
      ),
    );
  }
}

/// Could not deliver: the reason, try again or return to sender, and a note (as the rider app).
class _FailSheet extends StatefulWidget {
  const _FailSheet();
  @override
  State<_FailSheet> createState() => _FailSheetState();
}

class _FailSheetState extends State<_FailSheet> {
  String? _reason;
  String _next = 'RETRY';
  final _note = TextEditingController();
  String? _error;

  @override
  void initState() {
    super.initState();
    loadReasons().then((_) => mounted ? setState(() {}) : null);
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(16, 0, 16, 16 + MediaQuery.of(context).viewInsets.bottom),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('Why could they not be delivered?', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
              RadioGroup<String>(
                groupValue: _reason,
                onChanged: (v) => setState(() => _reason = v),
                child: Column(children: [for (final r in failureReasons) RadioListTile<String>(dense: true, value: r, title: Text(r))]),
              ),
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'RETRY', label: Text('Try again'), icon: Icon(Icons.replay)),
                  ButtonSegment(value: 'RETURN', label: Text('Return to sender'), icon: Icon(Icons.assignment_return_outlined)),
                ],
                selected: {_next},
                onSelectionChanged: (s) => setState(() => _next = s.first),
              ),
              const SizedBox(height: 10),
              TextField(controller: _note, maxLength: 500, decoration: const InputDecoration(labelText: 'Note', counterText: '')),
              if (_error != null) ErrorBox(_error!),
              const SizedBox(height: 10),
              FilledButton.icon(
                onPressed: () {
                  if (_reason == null) return setState(() => _error = 'Choose why it could not be delivered.');
                  if (_reason == 'Other' && _note.text.trim().isEmpty) return setState(() => _error = 'Write what happened.');
                  Navigator.pop(context, (_reason!, _next, _note.text.trim()));
                },
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                icon: const Icon(Icons.qr_code_scanner),
                label: const Text('Start scanning'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Deliver (Rider Operation): as the rider app's Deliver screen: who received it, the cash, the proof (code, signature
/// or photo, as allowed for the parcel), a note.
class OpsDeliverPage extends StatefulWidget {
  const OpsDeliverPage({super.key, required this.parcel, required this.base, required this.riderLabel});
  final Map<String, dynamic> parcel;
  final String base;
  final String riderLabel;
  @override
  State<OpsDeliverPage> createState() => _OpsDeliverPageState();
}

class _OpsDeliverPageState extends State<OpsDeliverPage> {
  final _form = GlobalKey<FormState>();
  final _pad = GlobalKey<SignaturePadState>();
  late final _receivedBy = TextEditingController(text: '${(widget.parcel['recipient'] as Map?)?['name'] ?? ''}');
  final _otp = TextEditingController();
  late final _cash = TextEditingController(text: _cod > 0 ? _plain(_cod) : '0');
  final _note = TextEditingController();
  late final bool _proofRequired = widget.parcel['proofRequired'] != false;
  late final List<String> _methods = [
    ...((widget.parcel['proofMethods'] as List?) ?? const ['OTP', 'SIGNATURE', 'PHOTO']).map((m) => '$m'),
    if (!_proofRequired) 'NONE',
  ];
  late String _method = _proofRequired ? _methods.first : 'NONE';
  List<String> _relations = const ['Self'];
  String _relation = 'Self';
  bool _partial = false;
  bool _cashConfirmed = false;
  String? _photo;
  bool _busy = false;
  String? _error;

  num get _cod => toNum(widget.parcel['codAmount']);
  String get _id => '${widget.parcel['trackingId']}';
  static String _plain(num n) => n == n.roundToDouble() ? '${n.round()}' : '$n';
  bool get _started => widget.parcel['deliveryCodeSent'] == true || '${widget.parcel['status']}' == 'OUT_FOR_DELIVERY';

  @override
  void initState() {
    super.initState();
    Api.get('/delivery/receiver-relations')
        .then((r) {
          final list = (((r as Map)['relations'] as List?) ?? []).map((e) => '$e').toList();
          if (list.isNotEmpty && mounted) setState(() => _relations = list);
        })
        .catchError((_) {});
  }

  Future<void> _takePhoto() async {
    final photo = await pickPhotoDataUrl(context);
    if (photo != null && mounted) setState(() => _photo = photo);
  }

  Future<void> _resend() async {
    try {
      await Api.post('${widget.base}/parcels/${Uri.encodeComponent(_id)}/resend-code', {});
      if (mounted) snack(context, 'A new code was sent to the recipient.');
    } catch (e) {
      if (mounted) snack(context, errorText(e));
    }
  }

  Future<void> _submit() async {
    setState(() => _error = null);
    if (!_form.currentState!.validate()) return;
    Map<String, dynamic>? proof;
    if (_method == 'NONE') {
      proof = null;
    } else if (_method == 'OTP') {
      proof = {'method': 'OTP', 'otp': _otp.text.trim()};
    } else if (_method == 'SIGNATURE') {
      final png = await _pad.currentState?.toDataUrl();
      if (png == null) return setState(() => _error = 'Ask the recipient to sign in the box.');
      proof = {'method': 'SIGNATURE', 'image': png};
    } else {
      if (_photo == null) return setState(() => _error = 'Take a photo of the signed invoice.');
      proof = {'method': 'PHOTO', 'image': _photo};
    }
    final collected = _partial ? toNum(_cash.text.trim()) : _cod;
    if (_cod > 0 && !_partial && !_cashConfirmed) return setState(() => _error = 'Confirm that ${widget.riderLabel} collected ${taka(_cod)}.');
    setState(() => _busy = true);
    try {
      await Api.post('${widget.base}/parcels/${Uri.encodeComponent(_id)}/delivery', {
        'outcome': 'DELIVERED',
        'receivedBy': _receivedBy.text.trim(),
        'receiverRelation': _relation,
        'proof': ?proof,
        'codCollected': collected,
        if (_partial) 'partial': true,
        if (_note.text.trim().isNotEmpty) 'note': _note.text.trim(),
        'capture': {'capturedAt': DateTime.now().toUtc().toIso8601String()},
      });
      Beep.ok();
      if (!mounted) return;
      snack(context, '$_id delivered.');
      Navigator.of(context).pop(true);
    } on ApiError catch (e) {
      Beep.error();
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final merchantOrder = widget.parcel['merchant'] != null;
    return Scaffold(
      appBar: AppBar(title: Text('Deliver $_id', style: const TextStyle(fontWeight: FontWeight.w800))),
      body: Form(
        key: _form,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text('For ${widget.riderLabel}', style: const TextStyle(color: muted)),
            const SizedBox(height: 8),
            Panel(
              title: 'Received by',
              child: Column(
                children: [
                  TextFormField(
                    controller: _receivedBy,
                    decoration: const InputDecoration(labelText: 'Name'),
                    validator: (v) => (v?.trim().isEmpty ?? true) ? 'Who received it?' : null,
                  ),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 6,
                    children: [for (final r in _relations) ChoiceChip(label: Text(r), selected: _relation == r, onSelected: (_) => setState(() => _relation = r))],
                  ),
                ],
              ),
            ),
            if (_cod > 0)
              Panel(
                title: 'Cash',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (!_partial)
                      CheckboxListTile(
                        contentPadding: EdgeInsets.zero,
                        value: _cashConfirmed,
                        onChanged: (v) => setState(() => _cashConfirmed = v ?? false),
                        title: Text('${widget.riderLabel} collected ${taka(_cod)}', style: const TextStyle(fontWeight: FontWeight.w800, color: good, fontSize: 16)),
                      ),
                    if (merchantOrder)
                      SwitchListTile(
                        contentPadding: EdgeInsets.zero,
                        value: _partial,
                        onChanged: (v) => setState(() => _partial = v),
                        title: const Text('Partial delivery'),
                        subtitle: const Text('The recipient kept only part of the order; the rest goes back to the merchant.'),
                      ),
                    if (_partial)
                      TextFormField(
                        controller: _cash,
                        keyboardType: const TextInputType.numberWithOptions(decimal: true),
                        decoration: InputDecoration(labelText: 'Cash collected (৳0 to ${taka(_cod)})', prefixText: '৳ '),
                        validator: (v) {
                          final n = num.tryParse(v?.trim() ?? '');
                          if (n == null || n < 0 || n > _cod) return 'Enter an amount from ৳0 to ${taka(_cod)}';
                          return null;
                        },
                      ),
                  ],
                ),
              ),
            Panel(
              title: 'Proof',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (_methods.length > 1)
                    Wrap(
                      spacing: 8,
                      children: [
                        for (final m in _methods)
                          ChoiceChip(
                            label: Text(m == 'OTP' ? "Recipient's code" : (m == 'SIGNATURE' ? 'Signature' : (m == 'NONE' ? 'No proof' : 'Photo'))),
                            selected: _method == m,
                            onSelected: (_) => setState(() {
                              _method = m;
                              _error = null;
                            }),
                          ),
                      ],
                    ),
                  const SizedBox(height: 10),
                  if (_method == 'NONE') const Text('This parcel was booked without proof required: the delivery can be completed without it.', style: TextStyle(color: muted)),
                  if (_method == 'OTP') ...[
                    if (!_started) const Text('Start the delivery first: the code is sent to the recipient then.', style: TextStyle(color: warn)),
                    TextFormField(
                      controller: _otp,
                      keyboardType: TextInputType.number,
                      maxLength: 6,
                      decoration: const InputDecoration(labelText: 'Code from the recipient\'s SMS', counterText: ''),
                      validator: (v) => _method == 'OTP' && !RegExp(r'^\d{4,6}$').hasMatch(v?.trim() ?? '') ? 'Enter the recipient\'s code' : null,
                    ),
                    if (widget.parcel['devDeliveryCode'] != null) Text('Test code: ${widget.parcel['devDeliveryCode']}', style: const TextStyle(color: muted, fontSize: 12)),
                    Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: _started ? _resend : null, child: const Text('Send the code again'))),
                  ],
                  if (_method == 'SIGNATURE') ...[
                    Container(
                      height: 180,
                      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10), border: Border.all(color: const Color(0xFFD0D5DD))),
                      child: ClipRRect(borderRadius: BorderRadius.circular(10), child: SignaturePad(key: _pad)),
                    ),
                    Row(
                      children: [
                        const Expanded(child: Text('The recipient signs in the box.', style: TextStyle(color: muted, fontSize: 12.5))),
                        TextButton(onPressed: () => _pad.currentState?.clear(), child: const Text('Clear')),
                      ],
                    ),
                  ],
                  if (_method == 'PHOTO') ...[
                    if (_photo != null)
                      ClipRRect(
                        borderRadius: BorderRadius.circular(10),
                        child: Image.memory(base64Decode(_photo!.substring(_photo!.indexOf(',') + 1)), height: 200, fit: BoxFit.cover),
                      ),
                    OutlinedButton.icon(onPressed: _takePhoto, icon: const Icon(Icons.photo_camera_outlined), label: Text(_photo == null ? 'Take a photo of the signed invoice' : 'Take it again')),
                  ],
                ],
              ),
            ),
            TextFormField(controller: _note, maxLength: 500, decoration: const InputDecoration(labelText: 'Note (optional)', counterText: '')),
            if (_error != null) ...[const SizedBox(height: 12), ErrorBox(_error!)],
            const SizedBox(height: 16),
            BusyButton(label: 'Confirm delivery', busy: _busy, onPressed: _submit, icon: Icons.check),
          ],
        ),
      ),
    );
  }
}
