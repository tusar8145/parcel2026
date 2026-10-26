import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'offline.dart';
import 'phone.dart';

/// Return runs: parcels going back to their merchant. Scan each one as the merchant takes it back.
class ReturnsPage extends StatefulWidget {
  const ReturnsPage({super.key});
  @override
  State<ReturnsPage> createState() => _ReturnsPageState();
}

class _ReturnsPageState extends State<ReturnsPage> {
  final _loader = GlobalKey<LoaderState<List<Map<String, dynamic>>>>();
  final Set<String> _returned = {};

  Future<ScanFeedback> _return(Map<String, dynamic> run, String code, String source, String receivedBy) async {
    final codes = ((run['parcels'] as List?) ?? []).map((p) => '${(p as Map)['trackingId']}').toSet();
    if (_returned.contains(code)) return ScanFeedback(false, '$code is already returned.');
    if (!codes.contains(code)) return ScanFeedback(false, '$code is not on ${run['number']}.');
    try {
      final sent = await Outbox.send(
        Pending(
          id: Outbox.newId(),
          path: '/rider/parcels/${Uri.encodeComponent(code)}/return',
          body: {'runId': run['id'], if (receivedBy.isNotEmpty) 'receivedBy': receivedBy, 'source': source == 'KEYBOARD' ? 'KEYBOARD' : 'CAMERA'},
          label: 'Returned to ${(run['merchant'] as Map?)?['name'] ?? 'the merchant'}',
          trackingId: code,
          kind: 'return',
          createdAt: DateTime.now(),
        ),
      );
      setState(() => _returned.add(code));
      final left = codes.difference(_returned).length;
      return ScanFeedback(true, '$code returned${sent == Sent.later ? ' · saved, sends when online' : ''}${left > 0 ? ' · $left left' : ' · run complete'}');
    } on ApiError catch (e) {
      return ScanFeedback(false, e.message);
    }
  }

  Future<void> _scanRun(Map<String, dynamic> run) async {
    final name = TextEditingController();
    final go = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Who is taking the parcels back?'),
        content: TextField(
          controller: name,
          decoration: const InputDecoration(labelText: 'Name (optional)'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Start scanning')),
        ],
      ),
    );
    if (go != true || !mounted) return;
    await scanBarcode(
      context,
      title: 'Return ${run['number']}',
      hint: 'Scan each parcel the merchant takes back.',
      continuous: true,
      onCode: (code, source) => _return(run, code, source, name.text.trim()),
    );
    _loader.currentState?.reload();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Returns to merchants', style: TextStyle(fontWeight: FontWeight.w800)),
      ),
      body: Loader<List<Map<String, dynamic>>>(
        key: _loader,
        load: () async => ((((await cachedGet('/rider/return-runs')) as Map)['items'] as List?) ?? []).cast<Map<String, dynamic>>(),
        builder: (context, runs, reload) => RefreshIndicator(
          onRefresh: reload,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(16),
            children: [
              if (runs.isEmpty) const EmptyView(icon: Icons.undo, text: 'No return runs assigned to you.'),
              for (final run in runs)
                Panel(
                  title: '${run['number']} · ${(run['merchant'] as Map?)?['name'] ?? ''}',
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text('${(run['merchant'] as Map?)?['address'] ?? ''}', style: const TextStyle(color: muted)),
                      const SizedBox(height: 8),
                      for (final p in ((run['parcels'] as List?) ?? []).cast<Map<String, dynamic>>())
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 3),
                          child: Row(
                            children: [
                              Icon(_returned.contains(p['trackingId']) ? Icons.check_circle : Icons.radio_button_unchecked, size: 18, color: _returned.contains(p['trackingId']) ? good : muted),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text('${p['trackingId']} · ${p['recipientName'] ?? ''}${p['returnReason'] != null ? ' · ${p['returnReason']}' : ''}', style: const TextStyle(fontSize: 13.5)),
                              ),
                            ],
                          ),
                        ),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          if ((run['merchant'] as Map?)?['phone'] != null) ...[
                            Expanded(
                              child: OutlinedButton.icon(
                                onPressed: () => callPhone(context, '${(run['merchant'] as Map)['phone']}'),
                                icon: const Icon(Icons.call_outlined, size: 18),
                                label: const Text('Call'),
                              ),
                            ),
                            const SizedBox(width: 8),
                          ],
                          Expanded(
                            child: OutlinedButton.icon(
                              onPressed: () => openMap(context, '${(run['merchant'] as Map?)?['address'] ?? ''}'),
                              icon: const Icon(Icons.map_outlined, size: 18),
                              label: const Text('Map'),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: FilledButton.icon(onPressed: () => _scanRun(run), icon: const Icon(Icons.qr_code_scanner, size: 18), label: const Text('Return')),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
