import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'home.dart';
import 'ops.dart';

const payMethods = ['BANK', 'BKASH', 'NAGAD', 'ROCKET', 'CASH', 'OTHER'];

/// Cash at the hub: riders' COD (receive their handover slips HS-), the hub's cash, and transfers (HT-) to the
/// central hub - sent from here, received at the central hub.
class CashPage extends StatelessWidget {
  const CashPage({super.key});

  @override
  Widget build(BuildContext context) {
    if (!Ops.allowed('receiveCash')) return const EmptyView(icon: Icons.lock_outline, text: 'Your role doesn\'t handle cash.');
    return DefaultTabController(
      length: 3,
      child: Column(
        children: [
          const Material(
            color: Colors.white,
            child: TabBar(
              tabs: [
                Tab(text: 'Riders'),
                Tab(text: 'Hub cash'),
                Tab(text: 'Transfers'),
              ],
            ),
          ),
          const Expanded(child: TabBarView(children: [_RidersCash(), _HubCash(), _Transfers()])),
        ],
      ),
    );
  }
}

/// Counts the cash for a slip or a transfer: the expected amount, what was counted (less = recorded as due).
Future<num?> countCash(BuildContext context, {required String title, required String detail, required num expected}) {
  final c = TextEditingController(text: expected == expected.roundToDouble() ? '${expected.round()}' : '$expected');
  return showDialog<num>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(detail),
          const SizedBox(height: 6),
          Text('Expected ${taka(expected)}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
          const SizedBox(height: 10),
          TextField(
            controller: c,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(labelText: 'Cash counted', prefixText: '৳ '),
          ),
          const SizedBox(height: 4),
          const Text('Less than expected is recorded as due.', style: TextStyle(color: muted, fontSize: 12.5)),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(
          onPressed: () {
            final n = num.tryParse(c.text.trim());
            if (n != null && n >= 0) Navigator.pop(context, n);
          },
          child: const Text('Confirm received'),
        ),
      ],
    ),
  );
}

class _RidersCash extends StatefulWidget {
  const _RidersCash();
  @override
  State<_RidersCash> createState() => _RidersCashState();
}

class _RidersCashState extends State<_RidersCash> with AutomaticKeepAliveClientMixin {
  final _loader = GlobalKey<LoaderState<List<Map<String, dynamic>>>>();

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    opsChanged.addListener(_reload);
  }

  @override
  void dispose() {
    opsChanged.removeListener(_reload);
    super.dispose();
  }

  void _reload() => _loader.currentState?.reload();

  /// Receives a slip: its number scanned (barcode on the rider's phone or the printed slip) or typed.
  Future<void> _scanSlip() async {
    Map<String, dynamic>? slip;
    final code = await scanBarcode(
      context,
      title: 'Rider\'s cash slip',
      hint: 'Scan the HS- barcode on the rider\'s phone or printed slip.',
      onCode: (code, _) async {
        try {
          slip = (await Api.get('/cash/slips/${Uri.encodeComponent(code)}') as Map).cast<String, dynamic>();
          if (slip!['status'] != 'OPEN') return ScanFeedback(false, '$code is ${humanize('${slip!['status']}').toLowerCase()} already.');
          return ScanFeedback(true, code);
        } on ApiError catch (e) {
          return ScanFeedback(false, e.status == 404 ? 'No cash slip $code.' : e.message);
        }
      },
    );
    if (code == null || slip == null || !mounted) return;
    await _receive(slip!);
  }

  Future<void> _receive(Map<String, dynamic> slip) async {
    final rider = (slip['rider'] as Map?) ?? {};
    final counted = await countCash(
      context,
      title: 'Receive ${slip['number']}',
      detail: '${rider['code'] ?? ''} · ${rider['name'] ?? ''} · ${count(slip['parcels'])} parcel(s)',
      expected: toNum(slip['expected']),
    );
    if (counted == null || !mounted) return;
    try {
      await Api.post('/cash/slips/${slip['id']}/receive', {'received': counted, 'hubId': Ops.hubId});
      Beep.ok();
      if (mounted) snack(context, 'Cash received: ${taka(counted)}.');
      opsChanged.value++;
    } on ApiError catch (e) {
      Beep.error();
      if (mounted) snack(context, e.message);
    }
  }

  /// A rider without the app: make their slip here, then receive it.
  Future<void> _slipFor(Map<String, dynamic> r) async {
    try {
      final slip = await Api.post('/cash/riders/${r['id']}/slip', {});
      if (mounted) await _receive(slip);
    } on ApiError catch (e) {
      if (mounted) snack(context, e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return Loader<List<Map<String, dynamic>>>(
      key: _loader,
      load: () async {
        final all = (((await Api.get('/cash/riders')) as Map)['items'] as List? ?? []).cast<Map<String, dynamic>>();
        return all.where((r) => Ops.hubId == null || (r['hub'] as Map?)?['id'] == Ops.hubId).toList();
      },
      builder: (context, riders, reload) => RefreshIndicator(
        onRefresh: reload,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(16),
          children: [
            FilledButton.icon(
              onPressed: _scanSlip,
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50)),
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('Scan a rider\'s cash slip', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
            ),
            const SizedBox(height: 12),
            if (riders.isEmpty) const EmptyView(icon: Icons.payments_outlined, text: 'No rider of this hub holds cash.'),
            for (final r in riders)
              Panel(
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('${r['code']} · ${r['name']}', style: const TextStyle(fontWeight: FontWeight.w800)),
                          Text('${count(r['parcels'])} parcel(s)${toNum(r['due']) > 0 ? ' · due ${taka(r['due'])}' : ''}', style: const TextStyle(color: muted)),
                        ],
                      ),
                    ),
                    Text(
                      taka(r['total']),
                      style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16, color: good),
                    ),
                    PopupMenuButton<String>(
                      onSelected: (_) => _slipFor(r),
                      itemBuilder: (_) => const [PopupMenuItem(value: 'slip', child: Text('Receive without the app (make the slip here)'))],
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _HubCash extends StatefulWidget {
  const _HubCash();
  @override
  State<_HubCash> createState() => _HubCashState();
}

class _HubCashState extends State<_HubCash> with AutomaticKeepAliveClientMixin {
  final _loader = GlobalKey<LoaderState<Map<String, dynamic>>>();

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    opsChanged.addListener(_reload);
  }

  @override
  void dispose() {
    opsChanged.removeListener(_reload);
    super.dispose();
  }

  void _reload() => _loader.currentState?.reload();

  Future<void> _send(Map<String, dynamic> mine, String? centralName) async {
    var method = 'BANK';
    final ref = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, set) => AlertDialog(
          title: Text('Send ${taka(mine['toSend'])} to ${centralName ?? 'the central hub'}'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('How is it sent?'),
              Wrap(
                spacing: 6,
                children: [for (final m in payMethods) ChoiceChip(label: Text(humanize(m)), selected: method == m, onSelected: (_) => set(() => method = m))],
              ),
              const SizedBox(height: 8),
              TextField(
                controller: ref,
                decoration: const InputDecoration(labelText: 'Reference (deposit slip, transaction ID)'),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Send')),
          ],
        ),
      ),
    );
    if (ok != true || !mounted) return;
    try {
      final t = await Api.post('/cash/transfers', {'fromHubId': Ops.hubId, 'method': method, if (ref.text.trim().isNotEmpty) 'reference': ref.text.trim()});
      if (mounted) snack(context, 'Transfer ${t['number']} sent: ${taka(t['amount'])}.');
      opsChanged.value++;
    } on ApiError catch (e) {
      if (mounted) snack(context, e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return Loader<Map<String, dynamic>>(
      key: _loader,
      load: () async => (await Api.get('/cash/on-hand', {'hubId': Ops.hubId}) as Map).cast<String, dynamic>(),
      builder: (context, data, reload) {
        final items = ((data['items'] as List?) ?? []).cast<Map<String, dynamic>>();
        final mine = items.where((i) => (i['hub'] as Map?)?['id'] == Ops.hubId).firstOrNull;
        final central = data['centralHubId'];
        final centralName = Ops.hubs.where((h) => h['id'] == central).firstOrNull?['name'];
        if (mine == null) return const EmptyView(icon: Icons.warehouse_outlined, text: 'Choose your hub to see its cash.');
        final slips = ((mine['slips'] as List?) ?? []).cast<Map<String, dynamic>>();
        final counter = (mine['counter'] as Map?) ?? {};
        final inTransit = ((mine['inTransit'] as List?) ?? []).cast<Map<String, dynamic>>();
        final isCentral = mine['central'] == true;
        return RefreshIndicator(
          onRefresh: reload,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(16),
            children: [
              Panel(
                child: Column(
                  children: [
                    Text(isCentral ? 'Cash at the central hub' : 'Cash to send to the central hub', style: const TextStyle(color: muted)),
                    Text(
                      taka(mine['toSend']),
                      style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w800, color: good),
                    ),
                    Text('${slips.length} rider slip(s) · counter ${taka(counter['amount'])} · dues ${taka(mine['due'])}', style: const TextStyle(color: muted)),
                  ],
                ),
              ),
              if (!isCentral && toNum(mine['toSend']) > 0)
                BusyButton(label: 'Send to ${centralName ?? 'the central hub'}', busy: false, onPressed: () => _send(mine, centralName as String?), icon: Icons.send),
              if (isCentral)
                const Panel(
                  child: Text('This is the central hub: receive the hubs\' transfers on the Transfers tab.', style: TextStyle(color: muted)),
                ),
              const SizedBox(height: 12),
              if (inTransit.isNotEmpty)
                Panel(
                  title: 'On the way',
                  child: Column(children: [for (final t in inTransit) KeyValue('${t['number'] ?? ''}', taka(t['amount']))]),
                ),
              if (slips.isNotEmpty)
                Panel(
                  title: 'Received slips',
                  child: Column(children: [for (final s in slips) KeyValue('${s['number']} · ${(s['rider'] as Map?)?['code'] ?? ''}', taka(s['received'] ?? s['expected']))]),
                ),
            ],
          ),
        );
      },
    );
  }
}

class _Transfers extends StatefulWidget {
  const _Transfers();
  @override
  State<_Transfers> createState() => _TransfersState();
}

class _TransfersState extends State<_Transfers> with AutomaticKeepAliveClientMixin {
  final _loader = GlobalKey<LoaderState<List<Map<String, dynamic>>>>();

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    opsChanged.addListener(_reload);
  }

  @override
  void dispose() {
    opsChanged.removeListener(_reload);
    super.dispose();
  }

  void _reload() => _loader.currentState?.reload();

  Future<void> _receive(Map<String, dynamic> t) async {
    final counted = await countCash(
      context,
      title: 'Receive ${t['number']}',
      detail: 'From ${(t['from'] as Map?)?['name'] ?? ''} · ${humanize('${t['method']}')}${t['reference'] != null ? ' · ${t['reference']}' : ''}',
      expected: toNum(t['amount']),
    );
    if (counted == null || !mounted) return;
    try {
      await Api.post('/cash/transfers/${t['id']}/receive', {'received': counted, 'hubId': Ops.hubId});
      Beep.ok();
      if (mounted) snack(context, '${t['number']} received.');
      opsChanged.value++;
    } on ApiError catch (e) {
      Beep.error();
      if (mounted) snack(context, e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return Loader<List<Map<String, dynamic>>>(
      key: _loader,
      load: () async => ((((await Api.get('/cash/transfers', {'hubId': Ops.hubId})) as Map)['items'] as List?) ?? []).cast<Map<String, dynamic>>(),
      builder: (context, items, reload) => RefreshIndicator(
        onRefresh: reload,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(16),
          children: [
            if (items.isEmpty) const EmptyView(icon: Icons.swap_horiz, text: 'No cash transfers yet.'),
            for (final t in items)
              Panel(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text('${t['number']}', style: const TextStyle(fontWeight: FontWeight.w800)),
                        ),
                        Text(taka(t['amount']), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
                      ],
                    ),
                    const SizedBox(height: 4),
                    StatusChip(t['status'] == 'IN_TRANSIT' ? 'PENDING' : '${t['status'] == 'RECEIVED' ? 'COMPLETED' : t['status']}', label: humanize('${t['status']}')),
                    Text('${(t['from'] as Map?)?['name'] ?? ''} → ${(t['to'] as Map?)?['name'] ?? ''} · ${humanize('${t['method']}')}', style: const TextStyle(color: muted)),
                    Text(
                      'Sent ${dateTimeText(t['sentAt'])} by ${t['sentBy'] ?? ''}${t['receivedAt'] != null ? ' · received ${dateTimeText(t['receivedAt'])}' : ''}',
                      style: const TextStyle(color: muted, fontSize: 12.5),
                    ),
                    if (toNum(t['short']) > 0) Text('Short ${taka(t['short'])}', style: const TextStyle(color: bad)),
                    if (t['status'] == 'IN_TRANSIT' && (t['to'] as Map?)?['id'] == Ops.hubId)
                      Align(
                        alignment: Alignment.centerRight,
                        child: FilledButton.tonal(onPressed: () => _receive(t), child: const Text('Receive')),
                      ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
