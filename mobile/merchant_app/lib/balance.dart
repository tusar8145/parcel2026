import 'package:flutter/material.dart';

import 'api.dart';
import 'widgets.dart';

/// Balance: E-commerce merchants see their COD on its way (rider → hub → central), ready / being paid / paid,
/// and their settlements (ST-); Banking & Financial merchants their bills (INV-), payments (PAY-) and due.
/// Both have the account statement.
class BalancePage extends StatelessWidget {
  const BalancePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Loader<Map<String, dynamic>?>(
      load: () async {
        final list = await Api.get('/my-accounts');
        return list is List && list.isNotEmpty ? list.first as Map<String, dynamic> : null;
      },
      builder: (context, account, reload) {
        if (account == null) return const EmptyView(icon: Icons.account_balance_wallet_outlined, text: 'Your account opens with your first delivered order.');
        final ecom = account['cod'] != null;
        final tabs = ecom ? const ['Summary', 'Settlements', 'Statement'] : const ['Summary', 'Bills', 'Payments', 'Statement'];
        return DefaultTabController(
          length: tabs.length,
          child: Column(
            children: [
              Material(
                color: Colors.white,
                child: TabBar(isScrollable: false, tabs: [for (final t in tabs) Tab(text: t)]),
              ),
              Expanded(
                child: TabBarView(
                  children: [
                    RefreshIndicator(
                      onRefresh: reload,
                      child: ecom ? _EcomSummary(account: account) : _FinancialSummary(account: account),
                    ),
                    if (ecom) const _Paged(path: '/payouts', kind: _Kind.settlement) else ...const [_Paged(path: '/bills', kind: _Kind.bill), _Paged(path: '/payments', kind: _Kind.payment)],
                    _Statement(accountId: '${account['id']}'),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _EcomSummary extends StatelessWidget {
  const _EcomSummary({required this.account});
  final Map<String, dynamic> account;

  @override
  Widget build(BuildContext context) {
    final c = (account['cod'] as Map?) ?? {};
    final payTo = account['payTo'] as Map?;
    final last = c['lastPayout'] as Map?;
    final onTheWay = toNum(c['withRider']) + toNum(c['atHubs']) + toNum(c['atCentral']);
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(16),
      children: [
        TilePairs(
          tiles: [
            StatTile(label: 'Ready to be paid', value: taka(c['ready']), icon: Icons.savings_outlined, color: good),
            StatTile(label: 'Being paid', value: taka(c['inSettlement']), icon: Icons.hourglass_top, color: warn),
            StatTile(label: 'COD on the way to us', value: taka(onTheWay), icon: Icons.local_shipping_outlined),
            StatTile(label: 'Paid this month', value: taka(c['paidThisMonth']), icon: Icons.check_circle_outline, color: good),
          ],
        ),
        const SizedBox(height: 12),
        Panel(
          title: 'Where your COD is',
          child: Column(
            children: [
              KeyValue('With riders', taka(c['withRider'])),
              KeyValue('At hubs', taka(c['atHubs'])),
              KeyValue('At the central hub', taka(c['atCentral'])),
              const Divider(),
              KeyValue('COD collected (all time)', taka(c['collected'])),
              KeyValue('Delivery charges', '-${taka(c['charges'])}'),
              if (toNum(c['adjustments']) != 0) KeyValue('Adjustments', taka(c['adjustments'])),
              KeyValue('Paid to you', taka(c['settled'])),
              KeyValue('Balance', taka(c['balance']), bold: true),
            ],
          ),
        ),
        Panel(
          title: 'Payment account',
          child: Column(
            children: [
              KeyValue('Paid to', payTo == null ? 'Not set' : '${humanize('${payTo['method']}')} · ${payTo['account'] ?? ''}'),
              if (last != null) KeyValue('Last settlement', '${last['number']} · ${taka(last['amount'])}'),
              if (last != null) KeyValue('Paid on', dateText(last['paidAt'])),
            ],
          ),
        ),
      ],
    );
  }
}

class _FinancialSummary extends StatelessWidget {
  const _FinancialSummary({required this.account});
  final Map<String, dynamic> account;

  @override
  Widget build(BuildContext context) {
    final f = (account['financial'] as Map?) ?? {};
    final unpaid = (f['unpaidBills'] as Map?) ?? {};
    final pending = (f['pending'] as Map?) ?? {};
    final last = f['lastPayment'] as Map?;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(16),
      children: [
        TilePairs(
          tiles: [
            StatTile(label: 'Due', value: taka(f['due']), icon: Icons.receipt_long_outlined, color: toNum(f['due']) > 0 ? bad : good),
            StatTile(label: 'Unpaid bills (${count(unpaid['count'])})', value: taka(unpaid['amount']), icon: Icons.description_outlined, color: warn),
            StatTile(label: 'Not billed yet', value: taka(f['notBilled']), icon: Icons.pending_actions_outlined),
            StatTile(label: 'Paid this month', value: taka(f['paidThisMonth']), icon: Icons.check_circle_outline, color: good),
          ],
        ),
        const SizedBox(height: 12),
        Panel(
          title: 'Account',
          child: Column(
            children: [
              KeyValue('Charges (all time)', taka(f['charges'])),
              if (toNum(f['adjustments']) != 0) KeyValue('Adjustments', taka(f['adjustments'])),
              KeyValue('Billed', taka(f['billed'])),
              KeyValue('Paid', taka(f['paid'])),
              if (toNum(f['credit']) > 0) KeyValue('Credit', taka(f['credit']), color: good),
              if (toNum(pending['count']) > 0) KeyValue('Payments being checked', '${count(pending['count'])} · ${taka(pending['amount'])}'),
              KeyValue('Due', taka(f['due']), bold: true),
            ],
          ),
        ),
        if (last != null)
          Panel(
            title: 'Last payment',
            child: Column(
              children: [
                KeyValue('Payment', '${last['number']}'),
                KeyValue('Amount', taka(last['amount'])),
                KeyValue('Method', humanize('${last['method']}')),
                KeyValue('Paid on', dateText(last['paidOn'])),
              ],
            ),
          ),
        const Text('To pay a bill, use Balance on the merchant panel or contact your account manager.', style: TextStyle(color: muted, fontSize: 12.5)),
      ],
    );
  }
}

enum _Kind { settlement, bill, payment }

/// A cursor-paged list of settlements, bills or payments.
class _Paged extends StatefulWidget {
  const _Paged({required this.path, required this.kind});
  final String path;
  final _Kind kind;
  @override
  State<_Paged> createState() => _PagedState();
}

class _PagedState extends State<_Paged> with AutomaticKeepAliveClientMixin {
  final List<Map<String, dynamic>> _items = [];
  String? _cursor;
  bool _loading = false;
  bool _done = false;
  String? _error;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _more();
  }

  Future<void> _reload() async {
    _items.clear();
    _cursor = null;
    _done = false;
    _error = null;
    await _more();
  }

  Future<void> _more() async {
    if (_loading || _done) return;
    setState(() => _loading = true);
    try {
      final r = await Api.get(widget.path, {'limit': 30, 'cursor': _cursor});
      if (!mounted) return;
      setState(() {
        _items.addAll(((r['items'] as List?) ?? []).cast<Map<String, dynamic>>());
        _cursor = r['nextCursor'] as String?;
        _done = _cursor == null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Widget _row(Map<String, dynamic> x) {
    switch (widget.kind) {
      case _Kind.settlement:
        return _MoneyRow(
          number: '${x['number']}',
          status: '${x['status']}',
          amount: taka(x['amount']),
          lines: [
            '${count(x['parcels'])} parcel(s) · COD ${taka(x['codTotal'])} − charges ${taka(x['chargesTotal'])}${toNum(x['adjustmentsTotal']) != 0 ? ' · adj. ${taka(x['adjustmentsTotal'])}' : ''}',
            x['paidAt'] != null
                ? 'Paid ${dateText(x['paidAt'])}${x['method'] != null ? ' by ${humanize('${x['method']}')}' : ''}${x['reference'] != null ? ' · ${x['reference']}' : ''}'
                : 'Created ${dateText(x['createdAt'])}',
          ],
        );
      case _Kind.bill:
        return _MoneyRow(
          number: '${x['number']}',
          status: '${x['status']}',
          amount: taka(x['total']),
          lines: [
            '${dateText(x['from'])} – ${dateText(x['to'])} · ${count(x['parcels'])} consignment(s)',
            'Paid ${taka(x['paid'])} · Due ${taka(x['due'])}',
            if (x['voidReason'] != null) 'Void: ${x['voidReason']}',
          ],
        );
      case _Kind.payment:
        return _MoneyRow(
          number: '${x['number']}',
          status: '${x['status']}',
          amount: taka(x['amount']),
          lines: [
            '${dateText(x['paidOn'])} · ${humanize('${x['method']}')}${x['reference'] != null ? ' · ${x['reference']}' : ''}',
            if (((x['bills'] as List?) ?? []).isNotEmpty) 'For ${((x['bills'] as List).cast<Map>()).map((b) => '${b['number']}').join(', ')}',
            if (toNum(x['credit']) > 0) 'Credit ${taka(x['credit'])}',
            if (x['rejectReason'] != null) 'Rejected: ${x['rejectReason']}',
          ],
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return RefreshIndicator(
      onRefresh: _reload,
      child: NotificationListener<ScrollNotification>(
        onNotification: (n) {
          if (n.metrics.pixels > n.metrics.maxScrollExtent - 300) _more();
          return false;
        },
        child: ListView.builder(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(16),
          itemCount: _items.length + 1,
          itemBuilder: (context, i) {
            if (i < _items.length) return _row(_items[i]);
            if (_error != null) return ErrorView(message: _error!, onRetry: _more);
            if (_loading) {
              return const Padding(
                padding: EdgeInsets.all(24),
                child: Center(child: CircularProgressIndicator()),
              );
            }
            if (_items.isEmpty) return const EmptyView(icon: Icons.receipt_long_outlined, text: 'Nothing here yet.');
            return const SizedBox.shrink();
          },
        ),
      ),
    );
  }
}

class _MoneyRow extends StatelessWidget {
  const _MoneyRow({required this.number, required this.status, required this.amount, required this.lines});
  final String number;
  final String status;
  final String amount;
  final List<String> lines;

  @override
  Widget build(BuildContext context) {
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(number, style: const TextStyle(fontWeight: FontWeight.w800)),
              ),
              Text(amount, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
            ],
          ),
          const SizedBox(height: 6),
          StatusChip(status),
          const SizedBox(height: 6),
          for (final l in lines) Text(l, style: const TextStyle(color: muted, fontSize: 13)),
        ],
      ),
    );
  }
}

/// The account statement: every line with its running balance, for a period.
class _Statement extends StatefulWidget {
  const _Statement({required this.accountId});
  final String accountId;
  @override
  State<_Statement> createState() => _StatementState();
}

class _StatementState extends State<_Statement> with AutomaticKeepAliveClientMixin {
  DateTimeRange? _range;
  Future<Map<String, dynamic>>? _future;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    _range = DateTimeRange(start: DateTime(now.year, now.month), end: DateTime(now.year, now.month, now.day));
    _load();
  }

  void _load() {
    setState(() {
      _future = Api.get('/accounts/${widget.accountId}/statement', {
        if (_range != null) 'from': isoDate(_range!.start),
        if (_range != null) 'to': isoDate(_range!.end),
      }).then((r) => r as Map<String, dynamic>);
    });
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final now = DateTime.now();
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
          child: OutlinedButton.icon(
            style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(44)),
            icon: const Icon(Icons.date_range),
            label: Text(_range == null ? 'All time' : '${dateText(_range!.start)} – ${dateText(_range!.end)}'),
            onPressed: () async {
              final r = await showDateRangePicker(context: context, firstDate: DateTime(2024), lastDate: now, initialDateRange: _range);
              if (r != null) {
                _range = r;
                _load();
              }
            },
          ),
        ),
        Expanded(
          child: FutureBuilder<Map<String, dynamic>>(
            future: _future,
            builder: (context, snap) {
              if (snap.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator());
              if (snap.hasError) return ErrorView(message: errorText(snap.error!), onRetry: _load);
              final s = snap.data!;
              final lines = ((s['lines'] as List?) ?? []).cast<Map<String, dynamic>>();
              return RefreshIndicator(
                onRefresh: () async => _load(),
                child: ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.all(16),
                  children: [
                    Panel(child: Column(children: [KeyValue('Opening balance', taka(s['opening'])), KeyValue('Closing balance', taka(s['closing']), bold: true)])),
                    if (lines.isEmpty) const EmptyView(icon: Icons.list_alt, text: 'No entries in this period.'),
                    for (final l in lines)
                      Container(
                        padding: const EdgeInsets.symmetric(vertical: 10),
                        decoration: const BoxDecoration(
                          border: Border(bottom: BorderSide(color: line)),
                        ),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text('${l['description'] ?? humanize('${l['type']}')}', style: const TextStyle(fontWeight: FontWeight.w600)),
                                  Text(
                                    [dateText(l['date']), if (l['trackingId'] != null) '${l['trackingId']}', if (l['reference'] != null) '${l['reference']}'].join(' · '),
                                    style: const TextStyle(color: muted, fontSize: 12.5),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(width: 10),
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.end,
                              children: [
                                Text(
                                  taka(l['amount']),
                                  style: TextStyle(fontWeight: FontWeight.w800, color: toNum(l['amount']) < 0 ? bad : ink),
                                ),
                                Text(taka(l['balance']), style: const TextStyle(color: muted, fontSize: 12.5)),
                              ],
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}
