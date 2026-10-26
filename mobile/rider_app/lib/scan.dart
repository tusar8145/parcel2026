import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'actions.dart';
import 'deliveries.dart';
import 'home.dart';
import 'offline.dart';

/// Scan: the rider chooses what to do, sets its context once (the pickup stop, the reason, the return run),
/// then scans parcel after parcel. Each scan beeps, does the task for that parcel and shows the result, and
/// the camera is ready for the next one (as the web rider panel's "Scan parcel" page).
class ScanPage extends StatelessWidget {
  const ScanPage({super.key});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<Map<String, dynamic>?>(
      valueListenable: Tasks.data,
      builder: (context, _, _) {
        final deliveries = Tasks.list('deliveries');
        final toStart = deliveries.where((p) => p['status'] != 'OUT_FOR_DELIVERY' && Outbox.of('${p['trackingId']}')?.kind != 'start').length;
        return RefreshIndicator(
          onRefresh: Tasks.load,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
            children: [
              const Padding(
                padding: EdgeInsets.only(bottom: 10),
                child: Text('Choose what you are doing, then scan the parcels one after another.', style: TextStyle(color: muted)),
              ),
              _TaskCard(
                icon: Icons.storefront_outlined,
                color: warn,
                title: 'Pickup from merchant',
                text: 'At a merchant: choose the pickup, then scan each parcel they hand you.',
                count: Tasks.list('pickups').length,
                onTap: () => _pickup(context),
              ),
              _TaskCard(
                icon: Icons.warehouse_outlined,
                color: brand,
                title: 'Hand over at hub',
                text: 'At the hub: scan each parcel you collected as you hand it over.',
                count: Tasks.list('carrying').where((p) => p['handover'] == null).length,
                onTap: () => _handover(context),
              ),
              _TaskCard(
                icon: Icons.play_circle_outline,
                color: brand,
                title: 'Start deliveries',
                text: 'Before you leave: scan each parcel as you load it. The recipient gets the delivery code by SMS.',
                count: toStart,
                onTap: () => _start(context),
              ),
              _TaskCard(
                icon: Icons.check_circle_outline,
                color: good,
                title: 'Deliver',
                text: 'At the door: scan the parcel, then collect the cash and the proof.',
                count: deliveries.length,
                onTap: () => _deliver(context),
              ),
              _TaskCard(
                icon: Icons.report_gmailerrorred_outlined,
                color: bad,
                title: 'Could not deliver',
                text: 'Choose the reason and what happens next once, then scan each parcel it applies to.',
                count: deliveries.length,
                onTap: () => _failed(context),
              ),
              _TaskCard(icon: Icons.undo, color: bad, title: 'Return to merchant', text: 'Choose the return run, then scan each parcel the merchant takes back.', onTap: () => _return(context)),
            ],
          ),
        );
      },
    );
  }

  /// One scan session: the same task for every parcel; a parcel done once in the session isn't done again.
  Future<void> _session(
    BuildContext context, {
    required String title,
    required String hint,
    required Future<ScanFeedback> Function(String code, String source) action,
    ValueNotifier<String>? status,
    void Function(int done)? onDone,
  }) async {
    final done = <String>{};
    await scanBarcode(
      context,
      title: title,
      hint: hint,
      continuous: true,
      status: status,
      onCode: (code, source) async {
        if (done.contains(code)) return ScanFeedback(false, '$code is already done.');
        final r = await action(code, source);
        if (r.ok) {
          done.add(code);
          onDone?.call(done.length);
        }
        return r;
      },
    );
    Tasks.load();
  }

  Future<void> _pickup(BuildContext context) async {
    final stops = <String, Map<String, dynamic>>{};
    final counts = <String, int>{};
    for (final p in Tasks.list('pickups')) {
      final s = ((p['pickupStop'] as Map?) ?? {}).cast<String, dynamic>();
      stops['${s['key']}'] = s;
      counts['${s['key']}'] = (counts['${s['key']}'] ?? 0) + 1;
    }
    if (stops.isEmpty) return snack(context, 'No pickups assigned to you right now.');
    final key = stops.length == 1 ? stops.keys.first : await pickFromList(context, title: 'Which pickup?', items: stops.keys.toList(), labelOf: (k) => '${stops[k]!['name']} · ${counts[k]} parcel(s)');
    if (key == null || !context.mounted) return;
    final stop = stops[key]!;
    final expected = counts[key]!;
    final status = ValueNotifier('0 of $expected collected');
    await _session(
      context,
      title: 'Pickup: ${stop['name']}',
      hint: 'Scan each parcel the merchant hands you ($expected expected).',
      status: status,
      onDone: (n) => status.value = '$n of $expected collected${n >= expected ? ' · all done' : ''}',
      action: (code, _) => collectParcel(stop, code),
    );
  }

  Future<void> _handover(BuildContext context) async {
    Map<String, dynamic>? hub;
    try {
      hub = (((await cachedGet('/rider/me')) as Map)['hub'] as Map?)?.cast<String, dynamic>();
    } catch (_) {}
    if (!context.mounted) return;
    if (hub == null) return snack(context, 'Your hub is not known yet. Try again when online.');
    final status = ValueNotifier('Hub: ${hub['name']}');
    await _session(
      context,
      title: 'Hand over: ${hub['name']}',
      hint: 'Scan each parcel you give to the hub.',
      status: status,
      onDone: (n) => status.value = '$n handed over at ${hub!['name']}',
      action: (code, source) => handOver(hub!, code, source),
    );
  }

  Future<void> _start(BuildContext context) async {
    final status = ValueNotifier('');
    await _session(
      context,
      title: 'Start deliveries',
      hint: 'Scan each parcel as you load it.',
      status: status,
      onDone: (n) => status.value = '$n out for delivery',
      action: (code, _) => startDelivery(code),
    );
  }

  /// Deliver: each scan opens that parcel's delivery screen (cash and proof); then the camera comes back.
  Future<void> _deliver(BuildContext context) async {
    while (true) {
      if (!context.mounted) return;
      final code = await scanBarcode(
        context,
        title: 'Deliver',
        hint: 'Scan the parcel at the door.',
        onCode: (code, _) async => findTask('deliveries', code) == null ? ScanFeedback(false, '$code is not one of your deliveries.') : ScanFeedback(true, code),
      );
      if (code == null || !context.mounted) return;
      final done = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => DeliverPage(parcel: findTask('deliveries', code)!)));
      await Tasks.load();
      if (done != true) return;
    }
  }

  Future<void> _failed(BuildContext context) async {
    final choice = await showModalBottomSheet<(String, String)>(context: context, isScrollControlled: true, showDragHandle: true, builder: (_) => const _FailureChoice());
    if (choice == null || !context.mounted) return;
    final (reason, next) = choice;
    final status = ValueNotifier('$reason · ${next == 'RETRY' ? 'try again later' : 'back to hub'}');
    await _session(
      context,
      title: 'Could not deliver',
      hint: 'Scan each parcel: $reason.',
      status: status,
      onDone: (n) => status.value = '$n saved · $reason',
      action: (code, _) => failDelivery(code, reason: reason, nextAction: next),
    );
  }

  Future<void> _return(BuildContext context) async {
    List<Map<String, dynamic>> runs;
    try {
      runs = ((((await cachedGet('/rider/return-runs')) as Map)['items'] as List?) ?? []).cast<Map<String, dynamic>>();
    } catch (e) {
      if (context.mounted) snack(context, errorText(e));
      return;
    }
    if (!context.mounted) return;
    if (runs.isEmpty) return snack(context, 'No return runs assigned to you.');
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
    final total = ((run['parcels'] as List?) ?? []).length;
    final status = ValueNotifier('0 of $total returned');
    await _session(
      context,
      title: 'Return ${run['number']}',
      hint: 'Scan each parcel ${(run['merchant'] as Map?)?['name'] ?? 'the merchant'} takes back.',
      status: status,
      onDone: (n) => status.value = '$n of $total returned${n >= total ? ' · run complete' : ''}',
      action: (code, source) => returnParcel(run, code, source, ''),
    );
  }
}

class _TaskCard extends StatelessWidget {
  const _TaskCard({required this.icon, required this.color, required this.title, required this.text, required this.onTap, this.count});
  final IconData icon;
  final Color color;
  final String title;
  final String text;
  final int? count;
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
                    const SizedBox(height: 2),
                    Text(text, style: const TextStyle(color: muted, fontSize: 12.5)),
                  ],
                ),
              ),
              if (count != null && count! > 0) ...[const SizedBox(width: 8), Badge(label: Text('$count'), backgroundColor: color)],
              const Icon(Icons.qr_code_scanner, color: Color(0xFF98A2B3)),
            ],
          ),
        ),
      ),
    );
  }
}

/// Could not deliver: the reason and the next step, chosen once for the scan session.
class _FailureChoice extends StatefulWidget {
  const _FailureChoice();
  @override
  State<_FailureChoice> createState() => _FailureChoiceState();
}

class _FailureChoiceState extends State<_FailureChoice> {
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
                children: [for (final r in failureReasons.where((r) => r != 'Other')) RadioListTile<String>(dense: true, value: r, title: Text(r))],
              ),
            ),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'RETRY', label: Text('Try again later')),
                ButtonSegment(value: 'RETURN_TO_HUB', label: Text('Back to hub')),
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
