import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'offline.dart';

/// My cash: the COD collected and still with the rider, dues, and the handover slip (HS-) the hub scans
/// when the rider hands the cash over.
class CashPage extends StatefulWidget {
  const CashPage({super.key});
  @override
  State<CashPage> createState() => _CashPageState();
}

class _CashPageState extends State<CashPage> {
  final _loader = GlobalKey<LoaderState<Map<String, dynamic>>>();
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    Outbox.synced.addListener(_reload);
  }

  @override
  void dispose() {
    Outbox.synced.removeListener(_reload);
    super.dispose();
  }

  void _reload() => _loader.currentState?.reload();

  Future<void> _slip({bool cancel = false}) async {
    if (cancel && !await confirm(context, title: 'Cancel the slip?', message: 'Make a new one when you are at the hub.', yes: 'Cancel slip', danger: true)) return;
    setState(() => _busy = true);
    try {
      await Api.post('/rider/my-cash/slip${cancel ? '/cancel' : ''}', {});
      _reload();
    } catch (e) {
      if (mounted) snack(context, errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Loader<Map<String, dynamic>>(
      key: _loader,
      load: () async => (await cachedGet('/rider/my-cash') as Map).cast<String, dynamic>(),
      builder: (context, c, reload) {
        final slip = c['slip'] as Map?;
        final parcels = ((c['parcels'] as List?) ?? []).cast<Map<String, dynamic>>();
        final dues = ((c['dues'] as List?) ?? []).cast<Map<String, dynamic>>();
        final total = toNum(c['total']);
        return RefreshIndicator(
          onRefresh: reload,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(16),
            children: [
              Panel(
                child: Column(
                  children: [
                    const Text('Cash to hand over', style: TextStyle(color: muted)),
                    Text(
                      taka(total),
                      style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w800, color: good),
                    ),
                    Text('COD ${taka(c['cod'])}${toNum(c['due']) > 0 ? ' + dues ${taka(c['due'])}' : ''} · ${parcels.length} parcel(s)', style: const TextStyle(color: muted)),
                    if ((c['rider'] as Map?)?['hub'] != null) Text('Hub: ${((c['rider'] as Map)['hub'] as Map)['name']}', style: const TextStyle(color: muted)),
                  ],
                ),
              ),
              if (slip != null)
                Panel(
                  title: 'Handover slip ${slip['number']}',
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      StatusChip('${slip['status']}' == 'OPEN' ? 'PENDING' : '${slip['status']}', label: humanize('${slip['status']}')),
                      const SizedBox(height: 10),
                      Code128Barcode('${slip['number']}'),
                      Center(
                        child: Text('${slip['number']}', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800, letterSpacing: 1)),
                      ),
                      const SizedBox(height: 8),
                      KeyValue('Amount', taka(slip['expected']), bold: true),
                      KeyValue('Parcels', count(slip['parcels'])),
                      if (slip['hub'] != null) KeyValue('Hub', '${(slip['hub'] as Map)['name']}'),
                      const SizedBox(height: 4),
                      const Text('Show this barcode at the hub with the cash. The hub scans it and counts the cash.', style: TextStyle(color: muted, fontSize: 12.5)),
                      if (c['slipOutdated'] == true) ...[
                        const SizedBox(height: 8),
                        const Text('You collected more cash since this slip was made. Update it before handing over.', style: TextStyle(color: warn)),
                      ],
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton(onPressed: _busy ? null : () => _slip(cancel: true), child: const Text('Cancel slip')),
                          ),
                          if (c['slipOutdated'] == true) ...[
                            const SizedBox(width: 10),
                            Expanded(
                              child: FilledButton(onPressed: _busy ? null : _slip, child: const Text('Update slip')),
                            ),
                          ],
                        ],
                      ),
                    ],
                  ),
                )
              else if (total > 0)
                BusyButton(label: 'Make handover slip', busy: _busy, onPressed: _slip, icon: Icons.receipt_long_outlined),
              const SizedBox(height: 12),
              if (parcels.isEmpty && dues.isEmpty) const EmptyView(icon: Icons.payments_outlined, text: 'No cash with you. COD you collect shows here until you hand it over.'),
              if (parcels.isNotEmpty)
                Panel(
                  title: 'Collected',
                  child: Column(children: [for (final p in parcels) KeyValue('${p['trackingId']} · ${p['recipient'] ?? ''}${p['partial'] == true ? ' (partial)' : ''}', taka(p['amount']))]),
                ),
              if (dues.isNotEmpty)
                Panel(
                  title: 'Dues',
                  child: Column(children: [for (final d in dues) KeyValue(humanize('${d['source']}'), taka(d['amount']))]),
                ),
            ],
          ),
        );
      },
    );
  }
}
