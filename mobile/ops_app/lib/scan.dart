import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'home.dart';
import 'ops.dart';
import 'parcels.dart';

/// Why a delivery failed (the API's FAILURE_REASONS) and why a parcel goes back (RETURN_REASONS).
const failureReasons = ['Recipient unavailable', 'Incorrect address', 'Recipient refused', 'Unable to contact recipient', 'Access / safety issue', 'Other'];
const returnReasons = ['Recipient refused', 'Recipient unreachable', 'Incorrect address', 'Repeated failed attempts', 'Merchant requested', 'Damaged in transit', 'Other'];

/// One answer of the hub desk ({ ok, outcome, message }): the scan result. A refusal by the API (403, 422…) too.
Future<ScanFeedback> deskScan(String path, Map<String, dynamic> body) async {
  try {
    final r = await Api.post(path, body);
    return ScanFeedback(r['ok'] == true, '${r['message'] ?? (r['ok'] == true ? 'Done' : 'Not done')}');
  } on ApiError catch (e) {
    return ScanFeedback(false, e.message);
  }
}

/// The scan desk: choose the task, set it up once (rider, reason…), then scan parcel after parcel with the
/// camera or a handheld scanner. Every scan beeps and shows its result; the camera is ready for the next one.
class ScanPage extends StatelessWidget {
  const ScanPage({super.key});

  Future<bool> _needHub(BuildContext context) async {
    if (Ops.hubId != null) return true;
    return pickHub(context);
  }

  /// Runs a scan session; the counts on Today reload afterwards.
  Future<void> _session(BuildContext context, {required String title, required String hint, required Future<ScanFeedback> Function(String code, String source) action}) async {
    final done = ValueNotifier('');
    var n = 0;
    await scanBarcode(
      context,
      title: title,
      hint: hint,
      continuous: true,
      status: done,
      onCode: (code, source) async {
        final r = await action(code, source == 'KEYBOARD' ? 'KEYBOARD' : 'CAMERA');
        if (r.ok) done.value = '${++n} done at ${Ops.hubName}';
        return r;
      },
    );
    opsChanged.value++;
  }

  Future<void> _receive(BuildContext context) async {
    if (!await _needHub(context) || !context.mounted) return;
    await _session(
      context,
      title: 'Receive at ${Ops.hubName}',
      hint: 'Scan every parcel arriving: from pickup riders, drop-offs, transfers, parcels coming back.',
      action: (code, source) => deskScan('/ops/hub-receive', {'code': code, 'hubId': Ops.hubId, 'source': source}),
    );
  }

  Future<void> _dispatch(BuildContext context) async {
    if (!await _needHub(context) || !context.mounted) return;
    final rider = await pickRider(context, title: 'Who is going out?');
    if (rider == null || !context.mounted) return;
    await _session(
      context,
      title: 'Out for delivery',
      hint: 'Scan the parcels as the rider loads them. The recipient gets the delivery code by SMS.',
      action: (code, source) => deskScan('/hub-desk/dispatch', {'code': code, 'riderId': rider, 'source': source}),
    );
  }

  Future<void> _delivered(BuildContext context) async {
    await _session(
      context,
      title: 'Delivery entry',
      hint: 'The rider hands in signed slips: scan each one. The COD stays with the rider for the cash handover.',
      action: (code, source) => deskScan('/hub-desk/deliver', {'code': code, 'source': source}),
    );
  }

  Future<void> _failed(BuildContext context) async {
    if (!await _needHub(context) || !context.mounted) return;
    final choice = await showModalBottomSheet<(String, String)>(context: context, isScrollControlled: true, showDragHandle: true, builder: (_) => const _ReasonSheet());
    if (choice == null || !context.mounted) return;
    final (reason, next) = choice;
    await _session(
      context,
      title: 'Failed delivery entry',
      hint: 'Scan each parcel: $reason (${next == 'RETRY' ? 'try again' : 'back at the hub'}).',
      action: (code, source) => deskScan('/hub-desk/failed', {'code': code, 'reason': reason, 'nextAction': next, 'hubId': Ops.hubId, 'source': source}),
    );
  }

  Future<void> _transfer(BuildContext context) async {
    if (!await _needHub(context) || !context.mounted) return;
    final hubs = Ops.hubs.where((h) => h['id'] != Ops.hubId).toList();
    final dest = await pickFromList(
      context,
      title: 'Send to which hub?',
      items: ['', ...hubs.map((h) => '${h['id']}')],
      selected: '',
      labelOf: (id) => id.isEmpty ? 'The hub serving each parcel\'s delivery area' : '${hubs.firstWhere((h) => h['id'] == id)['name']}',
    );
    if (dest == null || !context.mounted) return;
    await _session(
      context,
      title: 'Transfer out',
      hint: 'Scan each parcel leaving for another hub.',
      action: (code, source) => deskScan('/hub-desk/transfer', {'code': code, if (dest.isNotEmpty) 'toHubId': dest, 'source': source}),
    );
  }

  Future<void> _pickupEntry(BuildContext context) async {
    if (!await _needHub(context) || !context.mounted) return;
    await _session(
      context,
      title: 'Pickup entry',
      hint: 'A pickup rider brings what they collected: scan each parcel. It is picked up and received here.',
      action: (code, source) => deskScan('/hub-desk/pickup', {'code': code, 'hubId': Ops.hubId, 'source': source}),
    );
  }

  Future<void> _returnAssign(BuildContext context) async {
    if (!await _needHub(context) || !context.mounted) return;
    final rider = await pickRider(context, title: 'Who takes the returns?');
    if (rider == null || !context.mounted) return;
    final reason = await pickFromList(context, title: 'Reason (for parcels without one)', items: returnReasons, selected: returnReasons.first);
    if (reason == null || !context.mounted) return;
    await _session(
      context,
      title: 'Return rider assign',
      hint: 'Scan each parcel going back. It joins the rider\'s return run for its merchant.',
      action: (code, source) => deskScan('/hub-desk/return-assign', {'code': code, 'riderId': rider, 'hubId': Ops.hubId, 'reason': reason, 'source': source}),
    );
  }

  Future<void> _returnEntry(BuildContext context) async {
    final name = TextEditingController();
    final go = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Return entry'),
        content: TextField(
          controller: name,
          decoration: const InputDecoration(labelText: 'Who took them back? (optional)'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Start scanning')),
        ],
      ),
    );
    if (go != true || !context.mounted) return;
    await _session(
      context,
      title: 'Return entry',
      hint: 'Scan each parcel the merchant took back.',
      action: (code, source) => deskScan('/hub-desk/return', {'code': code, if (name.text.trim().isNotEmpty) 'receivedBy': name.text.trim(), 'source': source}),
    );
  }

  /// Hub Pickup counter: each scan opens the parcel's hand-over (collection code, who collects, COD).
  Future<void> _collect(BuildContext context) async {
    if (!await _needHub(context) || !context.mounted) return;
    while (true) {
      if (!context.mounted) return;
      final code = await scanBarcode(context, title: 'Collect from hub', hint: 'Scan the parcel the customer collects.');
      if (code == null || !context.mounted) return;
      final done = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => CollectPage(trackingId: code)));
      opsChanged.value++;
      if (done != true) return;
    }
  }

  @override
  Widget build(BuildContext context) {
    final canDispatch = Ops.allowed('dispatch');
    if (!canDispatch) return const EmptyView(icon: Icons.lock_outline, text: 'Your role can\'t use the scan desk.');
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
      children: [
        const Padding(
          padding: EdgeInsets.only(bottom: 10),
          child: Text('Choose the task, then scan the parcels one after another with the camera or a handheld scanner.', style: TextStyle(color: muted)),
        ),
        _Task(Icons.move_to_inbox_outlined, good, 'Receive at hub', 'Every arrival: pickups, drop-offs, transfers, parcels coming back.', () => _receive(context)),
        _Task(Icons.local_shipping_outlined, brand, 'Out for delivery', 'Choose the rider, then scan what they take.', () => _dispatch(context)),
        _Task(Icons.storefront_outlined, warn, 'Pickup entry', 'A pickup rider brings what they collected.', () => _pickupEntry(context)),
        _Task(Icons.swap_horiz, brand, 'Transfer out', 'Parcels leaving for another hub.', () => _transfer(context)),
        _Task(Icons.check_circle_outline, good, 'Delivery entry', 'Signed slips a rider hands in.', () => _delivered(context)),
        _Task(Icons.report_gmailerrorred_outlined, bad, 'Failed delivery entry', 'Choose the reason once, then scan.', () => _failed(context)),
        _Task(Icons.inventory_outlined, brand, 'Collect from hub', 'Hub Pickup counter: code, who collects, COD.', () => _collect(context)),
        _Task(Icons.assignment_return_outlined, bad, 'Return rider assign', 'Parcels going back join a rider\'s return run.', () => _returnAssign(context)),
        _Task(Icons.undo, bad, 'Return entry', 'Parcels the merchant took back.', () => _returnEntry(context)),
      ],
    );
  }
}

class _Task extends StatelessWidget {
  const _Task(this.icon, this.color, this.title, this.text, this.onTap);
  final IconData icon;
  final Color color;
  final String title;
  final String text;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Panel(
      padding: EdgeInsets.zero,
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: color.withValues(alpha: .1), borderRadius: BorderRadius.circular(12)),
                child: Icon(icon, color: color),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15.5)),
                    Text(text, style: const TextStyle(color: muted, fontSize: 12.5)),
                  ],
                ),
              ),
              const Icon(Icons.qr_code_scanner, color: Color(0xFF98A2B3)),
            ],
          ),
        ),
      ),
    );
  }
}

/// Failed delivery entry: the reason and the next step, chosen once for the session.
class _ReasonSheet extends StatefulWidget {
  const _ReasonSheet();
  @override
  State<_ReasonSheet> createState() => _ReasonSheetState();
}

class _ReasonSheetState extends State<_ReasonSheet> {
  String? _reason;
  String _next = 'RETRY';

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('Why could they not be delivered?', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
            RadioGroup<String>(
              groupValue: _reason,
              onChanged: (v) => setState(() => _reason = v),
              child: Column(
                children: [for (final r in failureReasons) RadioListTile<String>(dense: true, value: r, title: Text(r))],
              ),
            ),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'RETRY', label: Text('Try again')),
                ButtonSegment(value: 'RETURN_TO_HUB', label: Text('Back at the hub')),
              ],
              selected: {_next},
              onSelectionChanged: (s) => setState(() => _next = s.first),
            ),
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: _reason == null ? null : () => Navigator.pop(context, (_reason!, _next)),
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('Start scanning'),
            ),
          ],
        ),
      ),
    );
  }
}

/// Hub Pickup counter: the customer gives their collection code; who collects; the COD paid at the counter.
class CollectPage extends StatefulWidget {
  const CollectPage({super.key, required this.trackingId});
  final String trackingId;
  @override
  State<CollectPage> createState() => _CollectPageState();
}

class _CollectPageState extends State<CollectPage> {
  final _code = TextEditingController();
  final _name = TextEditingController();
  bool _cash = false;
  bool _busy = false;
  String? _error;

  Future<void> _submit(Map<String, dynamic> p) async {
    final cod = toNum(p['codAmount']);
    if (_name.text.trim().isEmpty) return setState(() => _error = 'Enter who collects it.');
    if (cod > 0 && !_cash) return setState(() => _error = 'Confirm that you took ${taka(cod)}.');
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await Api.post('/parcels/${Uri.encodeComponent(widget.trackingId)}/collect', {if (_code.text.trim().isNotEmpty) 'code': _code.text.trim(), 'receivedBy': _name.text.trim(), 'codCollected': cod});
      Beep.ok();
      if (!mounted) return;
      snack(context, '${widget.trackingId} handed over.');
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
    return Scaffold(
      appBar: AppBar(
        title: Text('Collect ${widget.trackingId}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
      ),
      body: Loader<Map<String, dynamic>>(
        load: () async => (await Api.get('/parcels/${Uri.encodeComponent(widget.trackingId)}') as Map).cast<String, dynamic>(),
        builder: (context, p, _) {
          final r = (p['recipient'] as Map?) ?? {};
          if (_name.text.isEmpty) _name.text = '${r['name'] ?? ''}';
          final cod = toNum(p['codAmount']);
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Panel(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    StatusChip('${p['status']}', label: '${p['statusLabel'] ?? humanize('${p['status']}')}'),
                    const SizedBox(height: 8),
                    Text('${r['name'] ?? ''}', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                    Text(phoneText(r['phone'])),
                    if (cod > 0)
                      Padding(
                        padding: const EdgeInsets.only(top: 6),
                        child: Text(
                          'Take ${taka(cod)} (COD)',
                          style: const TextStyle(color: good, fontWeight: FontWeight.w800, fontSize: 16),
                        ),
                      ),
                  ],
                ),
              ),
              TextField(
                controller: _code,
                keyboardType: TextInputType.number,
                maxLength: 8,
                decoration: const InputDecoration(labelText: 'Collection code from the customer\'s SMS', counterText: ''),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _name,
                decoration: const InputDecoration(labelText: 'Collected by'),
              ),
              if (cod > 0)
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  value: _cash,
                  onChanged: (v) => setState(() => _cash = v ?? false),
                  title: Text('I took ${taka(cod)}', style: const TextStyle(fontWeight: FontWeight.w700)),
                ),
              if (_error != null) ...[const SizedBox(height: 8), ErrorBox(_error!)],
              const SizedBox(height: 16),
              BusyButton(label: 'Hand over', busy: _busy, onPressed: () => _submit(p), icon: Icons.check),
              TextButton(
                onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ParcelPage(trackingId: widget.trackingId))),
                child: const Text('Parcel details'),
              ),
            ],
          );
        },
      ),
    );
  }
}
