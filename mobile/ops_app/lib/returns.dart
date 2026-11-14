import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'home.dart';
import 'ops.dart';

/// The returns at this hub (GET /hub-desk/returns-summary): held here with their next step, on the way to the central
/// hub, and the planned return runs to send out (POST /returns/runs/:id/dispatch), as on Courier Operations › Scan desk.
Future<Map<String, dynamic>> loadReturnsSummary() async =>
    ((await Api.get('/hub-desk/returns-summary', {if (Ops.hubId != null) 'hubId': Ops.hubId})) as Map).cast<String, dynamic>();

/// One line for the Returns group on the Scan tab: "3 held here · next: send to the central hub".
String returnsLine(Map<String, dynamic> s) {
  final waiting = (s['waiting'] as Map?) ?? {};
  final n = toNum(waiting['count']).toInt();
  final coming = toNum((s['coming'] as Map?)?['count']).toInt();
  final runs = toNum(s['plannedRuns']).toInt();
  final parts = <String>[
    n == 0 ? 'No return held here' : '$n held here · next: ${waiting['next'] == 'TRANSFER' ? 'Return transfer' : 'Return rider assign'}',
    if (s['isCentral'] == true && coming > 0) '$coming on the way',
    if (runs > 0) '$runs run${runs == 1 ? '' : 's'} to send out',
  ];
  return parts.join(' · ');
}

class ReturnsHubPage extends StatefulWidget {
  const ReturnsHubPage({super.key});
  @override
  State<ReturnsHubPage> createState() => _ReturnsHubPageState();
}

class _ReturnsHubPageState extends State<ReturnsHubPage> {
  final _loader = GlobalKey<LoaderState<(Map<String, dynamic>, List<Map<String, dynamic>>)>>();
  String? _sending;

  Future<(Map<String, dynamic>, List<Map<String, dynamic>>)> _load() async {
    final summary = await loadReturnsSummary();
    final runs = (((await Api.get('/hub-desk/return-runs', {if (Ops.hubId != null) 'hubId': Ops.hubId})) as Map)['items'] as List? ?? []).cast<Map<String, dynamic>>();
    return (summary, runs);
  }

  Future<void> _sendOut(Map<String, dynamic> run) async {
    if (!await confirm(context, title: 'Send out ${run['number']}?', message: '${count(run['parcels'])} parcel(s) for ${(run['merchant'] as Map?)?['name'] ?? 'the merchant'} leave with ${run['rider'] ?? 'the rider'}.', yes: 'Send out')) return;
    setState(() => _sending = '${run['id']}');
    try {
      await Api.post('/returns/runs/${Uri.encodeComponent('${run['id']}')}/dispatch', {});
      Beep.ok();
      if (mounted) snack(context, '${run['number']} is out with its rider.');
      opsChanged.value++;
      await _loader.currentState?.reload();
    } on ApiError catch (e) {
      Beep.error();
      if (mounted) snack(context, e.message);
    } finally {
      if (mounted) setState(() => _sending = null);
    }
  }

  Widget _count(String label, int n, Color color) => Expanded(
    child: Panel(
      child: Column(
        children: [
          Text('$n', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: n > 0 ? color : muted)),
          Text(label, textAlign: TextAlign.center, style: const TextStyle(color: muted, fontSize: 12)),
        ],
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Returns at ${Ops.hubName}')),
      body: Loader<(Map<String, dynamic>, List<Map<String, dynamic>>)>(
        key: _loader,
        load: _load,
        builder: (context, data, reload) {
          final (s, runs) = data;
          final waiting = (s['waiting'] as Map?) ?? {};
          final items = ((waiting['items'] as List?) ?? []).cast<Map>();
          final coming = ((((s['coming'] as Map?) ?? {})['items'] as List?) ?? []).cast<Map>();
          final central = s['centralHub'] as Map?;
          final toTransfer = waiting['next'] == 'TRANSFER';
          return RefreshIndicator(
            onRefresh: reload,
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Text(
                  central == null ? 'No central hub is set yet (super admin › Platform settings).' : (s['isCentral'] == true ? 'This is the central hub: returns are put on runs here.' : 'Central hub: ${central['name']}. Returns held here go there first.'),
                  style: const TextStyle(color: muted),
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    _count('Held here', items.length, warn),
                    if (s['isCentral'] == true) _count('On the way', coming.length, brand),
                    _count('Runs to send out', runs.length, brand),
                    _count('Out for return', toNum(s['outForReturn']).toInt(), good),
                  ],
                ),
                const SizedBox(height: 8),
                Text('Planned return runs', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
                const SizedBox(height: 6),
                if (runs.isEmpty)
                  const Padding(padding: EdgeInsets.only(bottom: 10), child: Text('No planned run. Return rider assign makes one per merchant and rider.', style: TextStyle(color: muted)))
                else
                  for (final r in runs)
                    Panel(
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text('${r['number']} · ${(r['merchant'] as Map?)?['name'] ?? ''}', style: const TextStyle(fontWeight: FontWeight.w800)),
                                Text('${r['rider'] ?? 'No rider'} · ${count(r['parcels'])} parcel(s)', style: const TextStyle(color: muted)),
                              ],
                            ),
                          ),
                          FilledButton(onPressed: _sending != null || r['rider'] == null ? null : () => _sendOut(r), child: Text(_sending == '${r['id']}' ? 'Sending…' : 'Send out')),
                        ],
                      ),
                    ),
                const SizedBox(height: 8),
                Text(
                  items.isEmpty ? 'Held here' : 'Held here · next: ${toTransfer ? 'Return transfer' : 'Return rider assign'}',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 6),
                if (items.isEmpty) const Text('No return held at this hub.', style: TextStyle(color: muted)),
                for (final p in items) _parcel(p),
                if (coming.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Text('On the way here · receive with Receive at hub', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
                  const SizedBox(height: 6),
                  for (final p in coming) _parcel(p),
                ],
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _parcel(Map p) => Panel(
    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('${p['trackingId']}', style: const TextStyle(fontWeight: FontWeight.w800)),
        Text([p['merchant'], p['reason']].where((x) => x != null && '$x'.isNotEmpty).join(' · '), style: const TextStyle(color: muted)),
      ],
    ),
  );
}
