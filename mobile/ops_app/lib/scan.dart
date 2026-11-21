import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'assign.dart';
import 'home.dart';
import 'ops.dart';
import 'parcels.dart';
import 'returns.dart';
import 'rider_op.dart';

/// Why a delivery failed and why a parcel goes back: the super admin's lists (GET /delivery/fail-reasons,
/// GET /returns/reasons, in their order); these until they load.
var failureReasons = <String>['Recipient unavailable', 'Incorrect address', 'Recipient refused', 'Unable to contact recipient', 'Access / safety issue', 'Other'];
var returnReasons = <String>['Recipient refused', 'Recipient unreachable', 'Wrong or incomplete address', 'Recipient asked to cancel', 'Damaged in transit', 'Merchant cancelled the order', 'Delivery attempts exhausted'];

/// Loads both reason lists (quietly keeps the ones above when offline).
Future<void> loadReasons() async {
  try {
    final f = (((await Api.get('/delivery/fail-reasons')) as Map)['reasons'] as List?)?.map((e) => '$e').toList();
    if (f != null && f.isNotEmpty) failureReasons = f;
  } catch (_) {}
  try {
    final r = (((await Api.get('/returns/reasons')) as Map)['reasons'] as List?)?.map((e) => '$e').toList();
    if (r != null && r.isNotEmpty) returnReasons = r;
  } catch (_) {}
}

/// Back from a rider after a failed delivery: follow the rider's choice, or the hub's.
const backDecisions = {'RIDER': 'As the rider chose (deliver again / return)', 'REATTEMPT': 'Deliver again', 'RETURN': 'Return to the sender'};

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

  /// Receive at hub & assign rider in one scan: parcels not received yet (in transit, drop-offs, back from a rider)
  /// are received first. Scanning a parcel for another rider moves it to that rider.
  Future<void> _assign(BuildContext context) async {
    if (!await _needHub(context) || !context.mounted) return;
    final rider = await pickRider(context, title: 'Who takes them?');
    if (rider == null || !context.mounted) return;
    await _session(
      context,
      title: 'Delivery rider assign',
      hint: 'Scan each parcel the rider takes. Not received yet? It is received here and given to the rider.',
      action: (code, source) => deskScan('/ops/hub-assign', {'code': code, 'hubId': Ops.hubId, 'riderId': rider, 'source': source}),
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
      title: 'Hub transfer',
      hint: 'Scan each parcel leaving for another hub.',
      action: (code, source) => deskScan('/hub-desk/transfer', {'code': code, if (dest.isNotEmpty) 'toHubId': dest, 'source': source}),
    );
  }

  Future<void> _returnAssign(BuildContext context) async {
    if (!await _needHub(context) || !context.mounted) return;
    await loadReasons();
    if (!context.mounted) return;
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

  /// Return transfer: returns held here leave for the central hub; counted down as they are scanned.
  Future<void> _returnTransfer(BuildContext context) async {
    if (!await _needHub(context) || !context.mounted) return;
    Map<String, dynamic> summary;
    try {
      summary = await loadReturnsSummary();
    } catch (e) {
      if (context.mounted) snack(context, errorText(e));
      return;
    }
    if (!context.mounted) return;
    final central = summary['centralHub'] as Map?;
    if (central == null) return snack(context, 'No central hub is set yet: a super admin chooses it in Platform settings.');
    if (summary['isCentral'] == true) return snack(context, 'This is the central hub: put the returns on runs with Return rider assign.');
    Future<String> left() async {
      try {
        final n = toNum(((await loadReturnsSummary())['waiting'] as Map?)?['count']).toInt();
        return n == 0 ? 'No return left to send.' : '$n return${n == 1 ? '' : 's'} still held here';
      } catch (_) {
        return '';
      }
    }

    final status = ValueNotifier(await left());
    if (!context.mounted) return;
    var n = 0;
    await scanBarcode(
      context,
      title: 'Hub return',
      hint: 'Scan each return leaving for ${central['name']}. It receives them with Receive at hub.',
      continuous: true,
      status: status,
      onCode: (code, source) async {
        final r = await deskScan('/hub-desk/return-transfer', {'code': code, 'hubId': Ops.hubId, 'source': source == 'KEYBOARD' ? 'KEYBOARD' : 'CAMERA'});
        if (r.ok) status.value = '${++n} sent · ${await left()}';
        return r;
      },
    );
    opsChanged.value++;
  }

  /// Assign pickup rider: new orders and pickup requests to give to a pickup rider (the list, as it was in More).
  Future<void> _assignPickup(BuildContext context) async {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const AssignPage(mode: AssignMode.pickup)));
    opsChanged.value++;
  }

  /// Hub Pickup counter: each scan opens the parcel's hand-over (collection code, who collects, COD).
  Future<void> _collect(BuildContext context) async {
    if (!await _needHub(context) || !context.mounted) return;
    while (true) {
      if (!context.mounted) return;
      final code = await scanBarcode(context, title: 'Hub collection', hint: 'Scan the parcel the customer collects.');
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
        const _Group('At the hub', 'Parcels arriving, leaving and given to riders.'),
        _Task(Icons.move_to_inbox_outlined, good, 'Receive at hub', 'Every arrival: first mile pickups, failed deliveries back, hub transfers and returns.', () => _receive(context)),
        _Task(Icons.swap_horiz, brand, 'Hub transfer', 'Parcels leaving for the hub that delivers them.', () => _transfer(context)),
        _Task(Icons.move_up_outlined, brand, 'Hub return', 'Returns held here leave for the central hub.', () => _returnTransfer(context)),
        _Task(Icons.person_add_alt_1_outlined, good, 'Delivery rider assign', 'Choose the rider, then scan: received (if needed) and given to them.', () => _assign(context)),
        _Task(Icons.assignment_return_outlined, bad, 'Return rider assign', 'Parcels going back join a rider\'s return run.', () => _returnAssign(context)),
        _Task(Icons.fiber_new_outlined, warn, 'Assign pickup rider', 'New orders and pickup requests: choose the parcels, then the rider.', () => _assignPickup(context), scan: false),
        const _Group('Hub collection', 'The recipient collects at the hub.'),
        _Task(Icons.inventory_outlined, brand, 'Hub collection', 'Scan the parcel; collection code, who collects, COD.', () => _collect(context)),
        const _Group('CN labels', 'Pre-printed labels to parcels.'),
        _Task(Icons.qr_code_2, brand, 'CN Assign Merchant', "Choose the merchant, then scan CN labels: they become that merchant's parcels.", () async {
          if (await _needHub(context) && context.mounted) await openCnMerchant(context, hubId: Ops.hubId);
          opsChanged.value++;
        }),
        _Task(Icons.document_scanner_outlined, brand, 'CN Scan Details', 'Camera stays on: CN barcode + recipient in the frame, tap Capture.', () async {
          if (await _needHub(context) && context.mounted) await openCnScan(context, hubId: Ops.hubId);
          opsChanged.value++;
        }),
        const _Group('Rider operation', 'Choose a rider and do their rider app steps for them.'),
        _Task(Icons.two_wheeler, brand, 'Rider operation', 'Pickup from merchant, receive from hub, start deliveries, deliver, could not deliver, returned to merchant.', () => openRiderOperation(context), scan: false),
      ],
    );
  }
}

/// A group heading on the scan desk: the work in the order it happens.
class _Group extends StatelessWidget {
  const _Group(this.title, this.text);
  final String title;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 16, 2, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title.toUpperCase(), style: const TextStyle(fontWeight: FontWeight.w800, color: brand, fontSize: 12.5, letterSpacing: .6)),
          Text(text, style: const TextStyle(color: muted, fontSize: 12.5)),
        ],
      ),
    );
  }
}

class _Task extends StatelessWidget {
  const _Task(this.icon, this.color, this.title, this.text, this.onTap, {this.scan = true});
  final IconData icon;
  final Color color;
  final String title;
  final String text;
  final VoidCallback onTap;
  /// Opens a scanner (else a list).
  final bool scan;

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
              Icon(scan ? Icons.qr_code_scanner : Icons.chevron_right, color: const Color(0xFF98A2B3)),
            ],
          ),
        ),
      ),
    );
  }
}

/// Hub Pickup counter: the customer gives their collection code; who collects; the COD paid at the counter.
class CollectPage extends StatefulWidget {
  const CollectPage({super.key, required this.trackingId, this.base = '/parcels'});
  final String trackingId;

  /// Where the parcel is read and handed over: /parcels (operations) or /franchise/parcels (a franchise hub).
  final String base;
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
      await Api.post('${widget.base}/${Uri.encodeComponent(widget.trackingId)}/collect', {if (_code.text.trim().isNotEmpty) 'code': _code.text.trim(), 'receivedBy': _name.text.trim(), 'codCollected': cod});
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
        load: () async => (await Api.get('${widget.base}/${Uri.encodeComponent(widget.trackingId)}') as Map).cast<String, dynamic>(),
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
              // Operations staff: the full parcel page (a franchise account has no access to it).
              if (widget.base == '/parcels')
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
