import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'actions.dart';
import 'home.dart';
import 'offline.dart';
import 'phone.dart';

/// Pickups: the stops (one per merchant / sender) with their parcels, and the parcels carried until a hub
/// scans them in ("Hand over at hub").
class PickupsPage extends StatelessWidget {
  const PickupsPage({super.key});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<Map<String, dynamic>?>(
      valueListenable: Tasks.data,
      builder: (context, data, _) {
        if (data == null) {
          return ValueListenableBuilder<String?>(
            valueListenable: Tasks.error,
            builder: (_, e, _) => e == null ? const Center(child: CircularProgressIndicator()) : ErrorView(message: e, onRetry: Tasks.load),
          );
        }
        final stops = <String, List<Map<String, dynamic>>>{};
        for (final p in Tasks.list('pickups')) {
          stops.putIfAbsent('${(p['pickupStop'] as Map?)?['key']}', () => []).add(p);
        }
        final carrying = Tasks.list('carrying');
        return RefreshIndicator(
          onRefresh: Tasks.load,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
            children: [
              if (stops.isEmpty) const EmptyView(icon: Icons.storefront_outlined, text: 'No pickups assigned to you right now.'),
              for (final e in stops.entries) _StopCard(stopKey: e.key, parcels: e.value),
              if (carrying.isNotEmpty) ...[
                const SizedBox(height: 6),
                Panel(
                  title: 'Carrying: ${carrying.length} parcel(s)',
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text('${carrying.where((p) => p['handover'] != null).length} handed over, waiting for the hub to scan them in.', style: const TextStyle(color: muted)),
                      const SizedBox(height: 10),
                      FilledButton.icon(
                        onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const HandoverPage())),
                        style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(46)),
                        icon: const Icon(Icons.warehouse_outlined),
                        label: const Text('Hand over at hub'),
                      ),
                    ],
                  ),
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}

class _StopCard extends StatelessWidget {
  const _StopCard({required this.stopKey, required this.parcels});
  final String stopKey;
  final List<Map<String, dynamic>> parcels;

  @override
  Widget build(BuildContext context) {
    final stop = (parcels.first['pickupStop'] as Map?) ?? {};
    final sender = (parcels.first['sender'] as Map?) ?? {};
    final onDemand = parcels.any((p) => p['onDemand'] == true);
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text('${stop['name'] ?? 'Sender'}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
              ),
              if (onDemand) const StatusChip('PENDING', label: 'On-demand'),
            ],
          ),
          const SizedBox(height: 4),
          Text('${stop['address'] ?? ''}', style: const TextStyle(color: muted)),
          const SizedBox(height: 4),
          Text('${parcels.length} parcel(s) to collect', style: const TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 10),
          Row(
            children: [
              if (sender['phone'] != null) ...[
                Expanded(
                  child: OutlinedButton.icon(onPressed: () => callPhone(context, '${sender['phone']}'), icon: const Icon(Icons.call_outlined, size: 18), label: const Text('Call')),
                ),
                const SizedBox(width: 8),
              ],
              Expanded(
                child: OutlinedButton.icon(onPressed: () => openMap(context, '${stop['address'] ?? ''}'), icon: const Icon(Icons.map_outlined, size: 18), label: const Text('Map')),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: FilledButton.icon(
                  onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => PickupStopPage(stopKey: stopKey))),
                  icon: const Icon(Icons.qr_code_scanner, size: 18),
                  label: const Text('Collect'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// At a merchant: scan each parcel they hand over. Shows how many are expected, scanned and still missing.
class PickupStopPage extends StatefulWidget {
  const PickupStopPage({super.key, required this.stopKey});
  final String stopKey;
  @override
  State<PickupStopPage> createState() => _PickupStopPageState();
}

class _PickupStopPageState extends State<PickupStopPage> {
  late final List<Map<String, dynamic>> _expected = Tasks.list('pickups').where((p) => (p['pickupStop'] as Map?)?['key'] == widget.stopKey).toList();
  final Map<String, String> _done = {}; // tracking ID → what happened
  final _progress = ValueNotifier<String>('');

  Map<String, dynamic> get _stop => _expected.isEmpty ? {} : ((_expected.first['pickupStop'] as Map?) ?? {}).cast<String, dynamic>();

  @override
  void initState() {
    super.initState();
    // Collected offline earlier (still in the outbox): already done.
    for (final p in _expected) {
      final o = Outbox.of('${p['trackingId']}');
      if (o != null && o.kind == 'pickup') _done['${p['trackingId']}'] = 'Collected · saved';
    }
    _updateProgress();
  }

  void _updateProgress() => _progress.value = '${_done.length} of ${_expected.length} collected';

  Future<ScanFeedback> _collect(String code, {String outcome = 'COLLECTED', String? note}) async {
    if (_done.containsKey(code)) return ScanFeedback(false, '$code is already done.');
    final r = await collectParcel(_stop, code, outcome: outcome, note: note);
    if (!r.ok) return r;
    final saved = Outbox.of(code)?.kind == 'pickup';
    setState(() => _done[code] = outcome == 'EXCEPTION' ? 'Problem reported' : (saved ? 'Collected · saved' : 'Collected'));
    _updateProgress();
    final left = _expected.length - _done.length;
    return ScanFeedback(true, '${r.message}${left > 0 ? ' · $left left' : ' · all done'}');
  }

  Future<void> _problem(String code) async {
    final note = await _askText(context, title: 'What is the problem?', hint: 'e.g. Parcel not ready, merchant closed');
    if (note == null) return;
    final r = await _collect(code, outcome: 'EXCEPTION', note: note);
    if (mounted) snack(context, r.message);
  }

  @override
  Widget build(BuildContext context) {
    final missing = _expected.where((p) => !_done.containsKey(p['trackingId'])).toList();
    return Scaffold(
      appBar: AppBar(
        title: Text('${_stop['name'] ?? 'Pickup'}', style: const TextStyle(fontWeight: FontWeight.w800)),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Panel(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text('${_stop['address'] ?? ''}', style: const TextStyle(color: muted)),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: _Count(label: 'Expected', value: _expected.length),
                    ),
                    Expanded(
                      child: _Count(label: 'Done', value: _done.length, color: good),
                    ),
                    Expanded(
                      child: _Count(label: 'Missing', value: missing.length, color: missing.isEmpty ? muted : warn),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                FilledButton.icon(
                  onPressed: () async {
                    await scanBarcode(context, title: 'Scan parcels', hint: 'Scan each parcel the merchant hands you.', continuous: true, status: _progress, onCode: (code, _) => _collect(code));
                    Tasks.load();
                  },
                  style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50)),
                  icon: const Icon(Icons.qr_code_scanner),
                  label: const Text('Scan parcels', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                ),
              ],
            ),
          ),
          for (final p in _expected) _parcelRow(p),
        ],
      ),
    );
  }

  Widget _parcelRow(Map<String, dynamic> p) {
    final id = '${p['trackingId']}';
    final done = _done[id];
    final r = (p['recipient'] as Map?) ?? {};
    final d = (p['delivery'] as Map?) ?? {};
    return Panel(
      child: Row(
        children: [
          Icon(done == null ? Icons.radio_button_unchecked : Icons.check_circle, color: done == null ? muted : good),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(id, style: const TextStyle(fontWeight: FontWeight.w800)),
                Text('${r['name'] ?? ''} · ${[d['area'], d['zone']].where((x) => x != null).join(', ')}', style: const TextStyle(color: muted, fontSize: 13)),
                if (toNum(p['codAmount']) > 0)
                  Text(
                    'COD ${taka(p['codAmount'])}',
                    style: const TextStyle(color: good, fontWeight: FontWeight.w600, fontSize: 13),
                  ),
                if (done != null) Text(done, style: const TextStyle(color: good, fontSize: 12.5)),
              ],
            ),
          ),
          if (done == null)
            PopupMenuButton<String>(
              onSelected: (v) async {
                if (v == 'collect') {
                  final r = await _collect(id);
                  if (mounted) snack(context, r.message);
                } else if (v == 'direct') {
                  if (!await confirm(context, title: 'Deliver it now?', message: 'Collect $id and take it straight to the recipient (it goes to your deliveries).', yes: 'Collect & deliver')) return;
                  final r = await _collect(id, outcome: 'COLLECTED_DELIVER_DIRECT');
                  if (mounted) snack(context, r.message);
                } else {
                  await _problem(id);
                }
              },
              itemBuilder: (_) => const [
                PopupMenuItem(value: 'collect', child: Text('Collected (no scan)')),
                PopupMenuItem(value: 'direct', child: Text('Collect & deliver now')),
                PopupMenuItem(value: 'problem', child: Text('Report a problem')),
              ],
            ),
        ],
      ),
    );
  }
}

class _Count extends StatelessWidget {
  const _Count({required this.label, required this.value, this.color = ink});
  final String label;
  final int value;
  final Color color;
  @override
  Widget build(BuildContext context) => Column(
    children: [
      Text(
        '$value',
        style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: color),
      ),
      Text(label, style: const TextStyle(color: muted, fontSize: 12.5)),
    ],
  );
}

Future<String?> _askText(BuildContext context, {required String title, String? hint}) {
  final c = TextEditingController();
  return showDialog<String>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: TextField(
        controller: c,
        autofocus: true,
        maxLength: 500,
        minLines: 2,
        maxLines: 4,
        decoration: InputDecoration(hintText: hint),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: () => c.text.trim().isEmpty ? null : Navigator.pop(context, c.text.trim()), child: const Text('Send')),
      ],
    ),
  );
}

/// "Hand over at hub": scan the parcels you carry as you give them to the hub (the hub then scans them in).
class HandoverPage extends StatefulWidget {
  const HandoverPage({super.key});
  @override
  State<HandoverPage> createState() => _HandoverPageState();
}

class _HandoverPageState extends State<HandoverPage> {
  Map<String, dynamic>? _hub;
  final Set<String> _handed = {};

  @override
  void initState() {
    super.initState();
    cachedGet('/rider/me')
        .then((r) {
          if (mounted) setState(() => _hub = ((r as Map)['hub'] as Map?)?.cast<String, dynamic>());
        })
        .catchError((_) {});
  }

  Future<ScanFeedback> _handover(String code, String source) async {
    if (_hub?['id'] == null) return const ScanFeedback(false, 'Your hub is not known yet. Try again when online.');
    if (_handed.contains(code)) return ScanFeedback(false, '$code is already handed over.');
    final r = await handOver(_hub!, code, source);
    if (r.ok) setState(() => _handed.add(code));
    return r;
  }

  Future<void> _undo(String code) async {
    try {
      await Outbox.send(
        Pending(
          id: Outbox.newId(),
          path: '/rider/parcels/${Uri.encodeComponent(code)}/handover/withdraw',
          body: {},
          label: 'Handover undone',
          trackingId: code,
          kind: 'handover',
          createdAt: DateTime.now(),
        ),
      );
      _handed.remove(code);
      await Tasks.load();
      if (mounted) setState(() {});
    } on ApiError catch (e) {
      if (mounted) snack(context, e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Hand over at hub', style: TextStyle(fontWeight: FontWeight.w800)),
      ),
      body: ValueListenableBuilder<Map<String, dynamic>?>(
        valueListenable: Tasks.data,
        builder: (context, _, _) {
          final carrying = Tasks.list('carrying');
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Panel(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text('Hub: ${_hub?['name'] ?? '…'}', style: const TextStyle(fontWeight: FontWeight.w700)),
                    const SizedBox(height: 4),
                    const Text('Scan each parcel as you give it to the hub. The hub confirms by scanning it in.', style: TextStyle(color: muted)),
                    const SizedBox(height: 12),
                    FilledButton.icon(
                      onPressed: () async {
                        await scanBarcode(context, title: 'Hand over at hub', hint: 'Scan each parcel you give to the hub.', continuous: true, onCode: _handover);
                        Tasks.load();
                      },
                      style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50)),
                      icon: const Icon(Icons.qr_code_scanner),
                      label: const Text('Scan to hand over', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                    ),
                  ],
                ),
              ),
              if (carrying.isEmpty) const EmptyView(icon: Icons.inventory_2_outlined, text: 'You are not carrying any collected parcels.'),
              for (final p in carrying)
                Panel(
                  child: Row(
                    children: [
                      Icon(
                        p['handover'] != null || _handed.contains(p['trackingId']) ? Icons.check_circle : Icons.inventory_2_outlined,
                        color: p['handover'] != null || _handed.contains(p['trackingId']) ? good : muted,
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('${p['trackingId']}', style: const TextStyle(fontWeight: FontWeight.w800)),
                            Text('From ${(p['pickupStop'] as Map?)?['name'] ?? ''}', style: const TextStyle(color: muted, fontSize: 13)),
                            if (p['handover'] != null) Text('Handed over at ${(p['handover'] as Map)['hubName']} · waiting for the hub scan', style: const TextStyle(color: good, fontSize: 12.5)),
                          ],
                        ),
                      ),
                      if (p['handover'] != null) TextButton(onPressed: () => _undo('${p['trackingId']}'), child: const Text('Undo')),
                    ],
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}
