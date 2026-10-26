import 'dart:convert';

import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import 'home.dart';
import 'offline.dart';
import 'phone.dart';
import 'signature_pad.dart';

/// Why a delivery failed (the API's FAILURE_REASONS).
const failureReasons = ['Recipient unavailable', 'Incorrect address', 'Recipient refused', 'Unable to contact recipient', 'Access / safety issue', 'Other'];

/// The parcel's status as the rider sees it, with what's saved in the outbox and not sent yet.
String localStatus(Map<String, dynamic> p) {
  final o = Outbox.of('${p['trackingId']}');
  if (o != null && o.error == null) {
    if (o.kind == 'delivered') return 'DELIVERED';
    if (o.kind == 'failed') return 'RETRY_SCHEDULED';
    if (o.kind == 'start') return 'OUT_FOR_DELIVERY';
  }
  return '${p['status']}';
}

/// Deliveries: to start, out for delivery, to try again; "Scan" finds a parcel by its label.
class DeliveriesPage extends StatelessWidget {
  const DeliveriesPage({super.key});

  Future<void> _scan(BuildContext context) async {
    await scanBarcode(
      context,
      title: 'Find a parcel',
      hint: 'Scan the label of a parcel you are delivering.',
      onCode: (code, _) async {
        final found = Tasks.list('deliveries').any((p) => p['trackingId'] == code);
        if (!found) return ScanFeedback(false, '$code is not one of your deliveries.');
        if (context.mounted) Navigator.of(context).push(MaterialPageRoute(builder: (_) => DeliveryPage(trackingId: code)));
        return ScanFeedback(true, code);
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<List<Pending>>(
      valueListenable: Outbox.items,
      builder: (context, _, _) => ValueListenableBuilder<Map<String, dynamic>?>(
        valueListenable: Tasks.data,
        builder: (context, data, _) {
          if (data == null) {
            return ValueListenableBuilder<String?>(
              valueListenable: Tasks.error,
              builder: (_, e, _) => e == null ? const Center(child: CircularProgressIndicator()) : ErrorView(message: e, onRetry: Tasks.load),
            );
          }
          final all = Tasks.list('deliveries');
          final open = all.where((p) => localStatus(p) != 'DELIVERED').toList();
          final cod = open.fold<num>(0, (a, p) => a + toNum(p['codAmount']));
          return RefreshIndicator(
            onRefresh: Tasks.load,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text('${open.length} to deliver · COD ${taka(cod)}', style: const TextStyle(fontWeight: FontWeight.w700)),
                    ),
                    FilledButton.tonalIcon(onPressed: () => _scan(context), icon: const Icon(Icons.qr_code_scanner, size: 18), label: const Text('Scan')),
                  ],
                ),
                const SizedBox(height: 10),
                if (all.isEmpty) const EmptyView(icon: Icons.local_shipping_outlined, text: 'No deliveries assigned to you right now.'),
                for (final p in all) _DeliveryCard(parcel: p),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _DeliveryCard extends StatelessWidget {
  const _DeliveryCard({required this.parcel});
  final Map<String, dynamic> parcel;

  @override
  Widget build(BuildContext context) {
    final p = parcel;
    final r = (p['recipient'] as Map?) ?? {};
    final d = (p['delivery'] as Map?) ?? {};
    final status = localStatus(p);
    final saved = Outbox.of('${p['trackingId']}');
    return Card(
      elevation: 0,
      color: Colors.white,
      margin: const EdgeInsets.only(bottom: 10),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: const BorderSide(color: line),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => DeliveryPage(trackingId: '${p['trackingId']}'))),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text('${p['trackingId']}', style: const TextStyle(fontWeight: FontWeight.w800)),
                  ),
                  if (p['onDemand'] == true)
                    const Padding(
                      padding: EdgeInsets.only(right: 6),
                      child: StatusChip('PENDING', label: 'On-demand'),
                    ),
                  StatusChip(status, label: status == '${p['status']}' ? '${p['statusLabel'] ?? humanize(status)}' : humanize(status)),
                ],
              ),
              const SizedBox(height: 6),
              Text('${r['name'] ?? ''} · ${phoneText(r['phone'])}', style: const TextStyle(fontWeight: FontWeight.w600)),
              Text(
                '${d['street'] ?? ''}',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: muted),
              ),
              Text([d['area'], d['zone']].where((x) => x != null && '$x'.isNotEmpty).join(' · '), style: const TextStyle(color: muted, fontSize: 12)),
              const SizedBox(height: 6),
              Row(
                children: [
                  if (toNum(p['codAmount']) > 0)
                    Text(
                      'Collect ${taka(p['codAmount'])}',
                      style: const TextStyle(color: good, fontWeight: FontWeight.w800),
                    )
                  else
                    const Text('No cash to collect', style: TextStyle(color: muted)),
                ],
              ),
              if (saved != null && saved.error == null) const Text('Saved · sends when online', style: TextStyle(color: warn, fontSize: 12)),
              if (saved?.error != null) const Text('Refused · check saved actions', style: TextStyle(color: bad, fontSize: 12)),
            ],
          ),
        ),
      ),
    );
  }
}

/// One delivery: recipient (call, map), cash to collect, what's inside, and the actions.
class DeliveryPage extends StatefulWidget {
  const DeliveryPage({super.key, required this.trackingId});
  final String trackingId;
  @override
  State<DeliveryPage> createState() => _DeliveryPageState();
}

class _DeliveryPageState extends State<DeliveryPage> {
  bool _busy = false;

  Map<String, dynamic>? get _parcel {
    for (final p in Tasks.list('deliveries')) {
      if (p['trackingId'] == widget.trackingId) return p;
    }
    return null;
  }

  Future<void> _start() async {
    setState(() => _busy = true);
    try {
      final sent = await Outbox.send(
        Pending(
          id: Outbox.newId(),
          path: '/rider/parcels/${Uri.encodeComponent(widget.trackingId)}/start-delivery',
          body: {},
          label: 'Delivery started',
          trackingId: widget.trackingId,
          kind: 'start',
          createdAt: DateTime.now(),
        ),
      );
      if (sent == Sent.now) await Tasks.load();
      if (mounted) snack(context, sent == Sent.now ? 'Delivery started. The recipient got their code by SMS.' : 'Saved. It starts (and the code is sent) when you are online.');
    } on ApiError catch (e) {
      if (mounted) snack(context, e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _open(Widget page) async {
    final done = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => page));
    if (done == true && mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<List<Pending>>(
      valueListenable: Outbox.items,
      builder: (context, _, _) => ValueListenableBuilder<Map<String, dynamic>?>(
        valueListenable: Tasks.data,
        builder: (context, _, _) {
          final p = _parcel;
          if (p == null) {
            return Scaffold(
              appBar: AppBar(title: Text(widget.trackingId)),
              body: const EmptyView(icon: Icons.check_circle_outline, text: 'This parcel is no longer on your delivery list.'),
            );
          }
          final r = (p['recipient'] as Map?) ?? {};
          final d = (p['delivery'] as Map?) ?? {};
          final status = localStatus(p);
          final cod = toNum(p['codAmount']);
          final finished = status == 'DELIVERED';
          final needsStart = status == 'ASSIGNED' || (status == 'RETRY_SCHEDULED' && p['deliveryCodeSent'] != true && Outbox.of(widget.trackingId)?.kind != 'start');
          return Scaffold(
            appBar: AppBar(
              title: Text(widget.trackingId, style: const TextStyle(fontWeight: FontWeight.w800)),
            ),
            body: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Panel(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        children: [
                          StatusChip(status, label: status == '${p['status']}' ? '${p['statusLabel'] ?? humanize(status)}' : humanize(status)),
                          const Spacer(),
                          if (toNum(p['attemptCount']) > 0) Text('Attempt ${toNum(p['attemptCount']).toInt() + 1}', style: const TextStyle(color: muted)),
                        ],
                      ),
                      const SizedBox(height: 10),
                      Text('${r['name'] ?? ''}', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                      Text(phoneText(r['phone']), style: const TextStyle(fontSize: 15)),
                      const SizedBox(height: 6),
                      Text('${d['street'] ?? ''}'),
                      Text([d['area'], d['zone'], d['district']].where((x) => x != null && '$x'.isNotEmpty).join(' · '), style: const TextStyle(color: muted, fontSize: 12.5)),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton.icon(onPressed: () => callPhone(context, '${r['phone']}'), icon: const Icon(Icons.call_outlined), label: const Text('Call')),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: OutlinedButton.icon(
                              onPressed: () => openMap(context, [d['street'], d['area'], d['zone'], d['district']].where((x) => x != null).join(', ')),
                              icon: const Icon(Icons.directions_outlined),
                              label: const Text('Directions'),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                Panel(
                  child: Column(
                    children: [
                      KeyValue('Cash to collect', cod > 0 ? taka(cod) : 'None', bold: true, color: cod > 0 ? good : muted),
                      KeyValue('From', '${(p['sender'] as Map?)?['name'] ?? '—'}'),
                      if (p['product'] != null) KeyValue('Product', '${p['product']}'),
                      if (p['contents'] != null) KeyValue('Contents', '${p['contents']}'),
                      if (p['weightKg'] != null) KeyValue('Weight', '${p['weightKg']} kg'),
                      if (p['openBox'] == true) const KeyValue('Open box', 'The recipient may check before paying'),
                      if (p['merchantOrderRef'] != null) KeyValue('Order ref.', '${p['merchantOrderRef']}'),
                      if (p['instructions'] != null) KeyValue('Note', '${p['instructions']}'),
                      KeyValue('Proof', ((p['proofMethods'] as List?) ?? []).map((m) => m == 'OTP' ? 'Code' : humanize('$m')).join(' / ')),
                    ],
                  ),
                ),
                if (finished)
                  const Panel(
                    child: Text('Delivered. Saved on the phone and sent when you are online.', style: TextStyle(color: good)),
                  )
                else ...[
                  if (needsStart) ...[
                    BusyButton(label: 'Start delivery', busy: _busy, onPressed: _start, icon: Icons.play_arrow),
                    const Padding(
                      padding: EdgeInsets.fromLTRB(4, 6, 4, 12),
                      child: Text('Starting sends the recipient their delivery code by SMS.', style: TextStyle(color: muted, fontSize: 12.5)),
                    ),
                  ],
                  FilledButton.icon(
                    onPressed: () => _open(DeliverPage(parcel: p)),
                    style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50), backgroundColor: good),
                    icon: const Icon(Icons.check_circle_outline),
                    label: const Text('Delivered', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                  ),
                  const SizedBox(height: 10),
                  OutlinedButton.icon(
                    onPressed: () => _open(FailedPage(parcel: p)),
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size.fromHeight(48),
                      foregroundColor: bad,
                      side: const BorderSide(color: bad),
                    ),
                    icon: const Icon(Icons.report_gmailerrorred_outlined),
                    label: const Text('Could not deliver'),
                  ),
                ],
                const SizedBox(height: 10),
                TextButton.icon(
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) => NewTicketPage(relatedRef: widget.trackingId, category: 'Delivery issue', subject: 'Problem with ${widget.trackingId}'),
                    ),
                  ),
                  icon: const Icon(Icons.support_agent),
                  label: const Text('Report a problem to support'),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

/// Delivered: who received it, the proof (code, signature or photo, as allowed for the parcel) and the cash.
class DeliverPage extends StatefulWidget {
  const DeliverPage({super.key, required this.parcel});
  final Map<String, dynamic> parcel;
  @override
  State<DeliverPage> createState() => _DeliverPageState();
}

class _DeliverPageState extends State<DeliverPage> {
  final _form = GlobalKey<FormState>();
  final _pad = GlobalKey<SignaturePadState>();
  late final _receivedBy = TextEditingController(text: '${(widget.parcel['recipient'] as Map?)?['name'] ?? ''}');
  final _otp = TextEditingController();
  late final _cash = TextEditingController(text: _cod > 0 ? _plain(_cod) : '0');
  final _note = TextEditingController();
  late final List<String> _methods = ((widget.parcel['proofMethods'] as List?) ?? const ['OTP', 'SIGNATURE', 'PHOTO']).map((m) => '$m').toList();
  late String _method = _methods.first;
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
  bool get _started => widget.parcel['deliveryCodeSent'] == true || '${widget.parcel['status']}' == 'OUT_FOR_DELIVERY' || Outbox.of(_id)?.kind == 'start';

  @override
  void initState() {
    super.initState();
    cachedGet('/delivery/receiver-relations')
        .then((r) {
          final list = (((r as Map)['relations'] as List?) ?? []).map((e) => '$e').toList();
          if (list.isNotEmpty && mounted) setState(() => _relations = list);
        })
        .catchError((_) {});
  }

  Future<void> _takePhoto() async {
    final file = await ImagePicker().pickImage(source: ImageSource.camera, maxWidth: 1280, maxHeight: 1280, imageQuality: 60);
    if (file == null) return;
    final bytes = await file.readAsBytes();
    setState(() => _photo = 'data:image/jpeg;base64,${base64Encode(bytes)}');
  }

  Future<void> _resend() async {
    try {
      await Api.post('/rider/parcels/${Uri.encodeComponent(_id)}/resend-code', {});
      if (mounted) snack(context, 'A new code was sent to the recipient.');
    } catch (e) {
      if (mounted) snack(context, errorText(e));
    }
  }

  Future<void> _submit() async {
    setState(() => _error = null);
    if (!_form.currentState!.validate()) return;
    Map<String, dynamic> proof;
    if (_method == 'OTP') {
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
    if (_cod > 0 && !_partial && !_cashConfirmed) return setState(() => _error = 'Confirm that you collected ${taka(_cod)}.');
    setState(() => _busy = true);
    final pos = await Tracker.current();
    try {
      final sent = await Outbox.send(
        Pending(
          id: Outbox.newId(),
          path: '/rider/parcels/${Uri.encodeComponent(_id)}/delivery',
          body: {
            'outcome': 'DELIVERED',
            'receivedBy': _receivedBy.text.trim(),
            'receiverRelation': _relation,
            'proof': proof,
            'codCollected': collected,
            if (_partial) 'partial': true,
            if (_note.text.trim().isNotEmpty) 'note': _note.text.trim(),
            'capture': {
              'capturedAt': DateTime.now().toUtc().toIso8601String(),
              if (pos != null) ...{'lat': pos.latitude, 'lng': pos.longitude, 'accuracy': pos.accuracy.clamp(0, 100000)},
            },
          },
          label: _partial ? 'Partly delivered · ${taka(collected)} collected' : 'Delivered${_cod > 0 ? ' · ${taka(collected)} collected' : ''}',
          trackingId: _id,
          kind: 'delivered',
          createdAt: DateTime.now(),
        ),
      );
      if (sent == Sent.now) await Tasks.load();
      if (!mounted) return;
      snack(context, sent == Sent.now ? '$_id delivered.' : '$_id saved as delivered. It is sent when you are online.');
      Navigator.of(context).pop(true);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final merchantOrder = widget.parcel['merchant'] != null;
    return Scaffold(
      appBar: AppBar(
        title: Text('Deliver $_id', style: const TextStyle(fontWeight: FontWeight.w800)),
      ),
      body: Form(
        key: _form,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
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
                        title: Text(
                          'I collected ${taka(_cod)}',
                          style: const TextStyle(fontWeight: FontWeight.w800, color: good, fontSize: 16),
                        ),
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
                            label: Text(m == 'OTP' ? "Recipient's code" : (m == 'SIGNATURE' ? 'Signature' : 'Photo')),
                            selected: _method == m,
                            onSelected: (_) => setState(() {
                              _method = m;
                              _error = null;
                            }),
                          ),
                      ],
                    ),
                  const SizedBox(height: 10),
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
                    Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton(onPressed: _started ? _resend : null, child: const Text('Send the code again')),
                    ),
                  ],
                  if (_method == 'SIGNATURE') ...[
                    Container(
                      height: 180,
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: const Color(0xFFD0D5DD)),
                      ),
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(10),
                        child: SignaturePad(key: _pad),
                      ),
                    ),
                    Row(
                      children: [
                        const Expanded(
                          child: Text('The recipient signs in the box.', style: TextStyle(color: muted, fontSize: 12.5)),
                        ),
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
            TextFormField(
              controller: _note,
              maxLength: 500,
              decoration: const InputDecoration(labelText: 'Note (optional)', counterText: ''),
            ),
            if (_error != null) ...[const SizedBox(height: 12), ErrorBox(_error!)],
            const SizedBox(height: 16),
            BusyButton(label: 'Confirm delivery', busy: _busy, onPressed: _submit, icon: Icons.check),
          ],
        ),
      ),
    );
  }
}

/// Could not deliver: the reason and what happens next (try again, or back to the hub).
class FailedPage extends StatefulWidget {
  const FailedPage({super.key, required this.parcel});
  final Map<String, dynamic> parcel;
  @override
  State<FailedPage> createState() => _FailedPageState();
}

class _FailedPageState extends State<FailedPage> {
  String? _reason;
  String _next = 'RETRY';
  final _note = TextEditingController();
  bool _busy = false;
  String? _error;

  String get _id => '${widget.parcel['trackingId']}';

  Future<void> _submit() async {
    if (_reason == null) return setState(() => _error = 'Choose why it could not be delivered.');
    if (_reason == 'Other' && _note.text.trim().isEmpty) return setState(() => _error = 'Write what happened.');
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final sent = await Outbox.send(
        Pending(
          id: Outbox.newId(),
          path: '/rider/parcels/${Uri.encodeComponent(_id)}/delivery',
          body: {'outcome': 'FAILED', 'reason': _reason, 'nextAction': _next, if (_note.text.trim().isNotEmpty) 'note': _note.text.trim()},
          label: 'Not delivered: $_reason (${_next == 'RETRY' ? 'try again' : 'back to hub'})',
          trackingId: _id,
          kind: 'failed',
          createdAt: DateTime.now(),
        ),
      );
      if (sent == Sent.now) await Tasks.load();
      if (!mounted) return;
      snack(context, sent == Sent.now ? 'Saved: $_reason.' : 'Saved on the phone. It is sent when you are online.');
      Navigator.of(context).pop(true);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Not delivered: $_id', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Panel(
            title: 'Why?',
            padding: const EdgeInsets.fromLTRB(4, 14, 4, 6),
            child: RadioGroup<String>(
              groupValue: _reason,
              onChanged: (v) => setState(() => _reason = v),
              child: Column(
                children: [for (final r in failureReasons) RadioListTile<String>(value: r, title: Text(r))],
              ),
            ),
          ),
          Panel(
            title: 'What next?',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SegmentedButton<String>(
                  segments: const [
                    ButtonSegment(value: 'RETRY', label: Text('Try again later'), icon: Icon(Icons.replay)),
                    ButtonSegment(value: 'RETURN_TO_HUB', label: Text('Back to hub'), icon: Icon(Icons.warehouse_outlined)),
                  ],
                  selected: {_next},
                  onSelectionChanged: (s) => setState(() => _next = s.first),
                ),
              ],
            ),
          ),
          TextField(
            controller: _note,
            maxLength: 500,
            minLines: 2,
            maxLines: 4,
            decoration: const InputDecoration(labelText: 'Note', counterText: ''),
          ),
          if (_error != null) ...[const SizedBox(height: 12), ErrorBox(_error!)],
          const SizedBox(height: 16),
          BusyButton(label: 'Save', busy: _busy, onPressed: _submit),
        ],
      ),
    );
  }
}
