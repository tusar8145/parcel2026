import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'api.dart';
import 'home.dart';
import 'widgets.dart';

/// Order list filters: the statuses each one covers.
const orderFilters = <String, (String, String?)>{
  'all': ('All', null),
  'pending': ('Waiting for pickup', 'PENDING_CONFIRMATION,PICKUP_ASSIGNED,PICKUP_CONFIRMED'),
  'transit': ('In transit', 'PICKED_UP,AT_HUB,ASSIGNED,IN_TRANSIT,OUT_FOR_DELIVERY,READY_FOR_COLLECTION'),
  'delivered': ('Delivered', 'DELIVERED'),
  'issue': ('Needs attention', 'EXCEPTION,RETRY_SCHEDULED'),
  'returns': ('Returns', 'RETURN_SCHEDULED,RETURNED'),
  'cancelled': ('Cancelled', 'PICKUP_CANCELLED'),
};

const _periods = {'any': 'Any time', 'today': 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days', 'month': 'This month'};

/// Orders: search (tracking ID, phone, name), status and date filters, more as you scroll.
class OrdersPage extends StatefulWidget {
  const OrdersPage({super.key});
  @override
  State<OrdersPage> createState() => OrdersPageState();
}

class OrdersPageState extends State<OrdersPage> {
  final _search = TextEditingController();
  final _scroll = ScrollController();
  Timer? _debounce;
  String _filter = 'all';
  String _period = 'any';
  final List<Map<String, dynamic>> _items = [];
  String? _cursor;
  bool _loading = false;
  bool _done = false;
  String? _error;
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (_scroll.position.pixels > _scroll.position.maxScrollExtent - 400) _more();
    });
    ordersChanged.addListener(_reload);
    _reload();
  }

  @override
  void dispose() {
    ordersChanged.removeListener(_reload);
    _debounce?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  void setFilter(String filter) {
    if (_filter == filter) return;
    setState(() => _filter = filter);
    _reload();
  }

  (DateTime?, DateTime?) _range() {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    switch (_period) {
      case 'today':
        return (today, null);
      case '7d':
        return (today.subtract(const Duration(days: 6)), null);
      case '30d':
        return (today.subtract(const Duration(days: 29)), null);
      case 'month':
        return (DateTime(now.year, now.month), null);
      default:
        return (null, null);
    }
  }

  Future<void> _reload() async {
    _items.clear();
    _cursor = null;
    _done = false;
    _error = null;
    _loading = false;
    await _more();
  }

  Future<void> _more() async {
    if (_loading || _done) return;
    final seq = ++_seq;
    setState(() => _loading = true);
    final (from, to) = _range();
    try {
      final r = await Api.get('/parcels', {
        'limit': 30,
        'cursor': _cursor,
        'q': _search.text.trim(),
        'status': orderFilters[_filter]!.$2,
        'from': from?.toUtc().toIso8601String(),
        'to': to?.toUtc().toIso8601String(),
      });
      if (seq != _seq || !mounted) return;
      setState(() {
        _items.addAll(((r['items'] as List?) ?? []).cast<Map<String, dynamic>>());
        _cursor = r['nextCursor'] as String?;
        _done = _cursor == null;
        _loading = false;
      });
    } catch (e) {
      if (seq != _seq || !mounted) return;
      setState(() {
        _error = errorText(e);
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          color: Colors.white,
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 8),
          child: Column(
            children: [
              TextField(
                controller: _search,
                textInputAction: TextInputAction.search,
                decoration: InputDecoration(
                  isDense: true,
                  prefixIcon: const Icon(Icons.search),
                  hintText: 'Tracking ID, phone or name',
                  suffixIcon: _search.text.isEmpty
                      ? null
                      : IconButton(
                          icon: const Icon(Icons.close),
                          onPressed: () {
                            _search.clear();
                            _reload();
                          },
                        ),
                ),
                onChanged: (_) {
                  setState(() {});
                  _debounce?.cancel();
                  _debounce = Timer(const Duration(milliseconds: 450), _reload);
                },
              ),
              const SizedBox(height: 8),
              SizedBox(
                height: 36,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  children: [
                    ActionChip(
                      avatar: const Icon(Icons.calendar_today_outlined, size: 16),
                      label: Text(_periods[_period]!),
                      onPressed: () async {
                        final v = await pickFromList(context, title: 'Booked', items: _periods.keys.toList(), selected: _period, labelOf: (k) => _periods[k]!);
                        if (v != null && v != _period) {
                          setState(() => _period = v);
                          _reload();
                        }
                      },
                    ),
                    const SizedBox(width: 8),
                    for (final e in orderFilters.entries) ...[ChoiceChip(label: Text(e.value.$1), selected: _filter == e.key, onSelected: (_) => setFilter(e.key)), const SizedBox(width: 6)],
                  ],
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _reload,
            child: ListView.builder(
              controller: _scroll,
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 96),
              itemCount: _items.length + 1,
              itemBuilder: (context, i) {
                if (i < _items.length) return OrderCard(parcel: _items[i]);
                if (_error != null) return ErrorView(message: _error!, onRetry: _more);
                if (_loading) {
                  return const Padding(
                    padding: EdgeInsets.all(24),
                    child: Center(child: CircularProgressIndicator()),
                  );
                }
                if (_items.isEmpty) return const EmptyView(icon: Icons.inventory_2_outlined, text: 'No orders here yet.');
                return const SizedBox(height: 8);
              },
            ),
          ),
        ),
      ],
    );
  }
}

class OrderCard extends StatelessWidget {
  const OrderCard({super.key, required this.parcel});
  final Map<String, dynamic> parcel;

  @override
  Widget build(BuildContext context) {
    final p = parcel;
    final r = (p['recipient'] as Map?) ?? {};
    final d = (p['delivery'] as Map?) ?? {};
    final cod = toNum(p['codAmount']);
    final places = [d['area'], d['zone'], d['district']].where((x) => x != null && '$x'.isNotEmpty).join(' · ');
    return Card(
      elevation: 0,
      margin: const EdgeInsets.only(bottom: 10),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: const BorderSide(color: line),
      ),
      color: Colors.white,
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => OrderDetailPage(trackingId: '${p['trackingId']}'))),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      '${p['trackingId']}',
                      style: const TextStyle(fontWeight: FontWeight.w800, color: ink),
                    ),
                  ),
                  StatusChip(p['status'] as String?, label: p['statusLabel'] as String?),
                ],
              ),
              const SizedBox(height: 8),
              Text('${r['name'] ?? '—'} · ${phoneText(r['phone'])}', style: const TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 2),
              Text(
                '${d['street'] ?? ''}',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: muted),
              ),
              if (places.isNotEmpty) Text(places, style: const TextStyle(color: muted, fontSize: 12)),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      [dateTimeText(p['createdAt']), if (p['merchantOrderRef'] != null) 'Ref ${p['merchantOrderRef']}'].join('  ·  '),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 12, color: muted),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text.rich(
                    TextSpan(
                      children: [
                        if (cod > 0)
                          TextSpan(
                            text: 'COD ${taka(cod)}   ',
                            style: const TextStyle(fontWeight: FontWeight.w700, color: good, fontSize: 13.5),
                          ),
                        TextSpan(
                          text: 'Charge ${taka((p['charges'] as Map?)?['total'])}',
                          style: const TextStyle(fontSize: 12.5, color: muted),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// One order: status, recipient, parcel, charges and COD, proof of delivery, the tracking timeline; cancel while pending.
class OrderDetailPage extends StatefulWidget {
  const OrderDetailPage({super.key, required this.trackingId});
  final String trackingId;
  @override
  State<OrderDetailPage> createState() => _OrderDetailPageState();
}

class _OrderDetailPageState extends State<OrderDetailPage> {
  final _loader = GlobalKey<LoaderState<Map<String, dynamic>>>();
  bool _busy = false;

  Future<void> _cancel() async {
    final reason = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Cancel this order?'),
        content: TextField(
          controller: reason,
          maxLength: 300,
          decoration: const InputDecoration(labelText: 'Reason (optional)'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Keep it')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: bad),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Cancel order'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() => _busy = true);
    try {
      await Api.post('/parcels/${Uri.encodeComponent(widget.trackingId)}/cancel', {if (reason.text.trim().isNotEmpty) 'reason': reason.text.trim()});
      ordersChanged.value++;
      if (!mounted) return;
      snack(context, 'Order cancelled.');
      _loader.currentState?.reload();
    } catch (e) {
      if (mounted) snack(context, errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.trackingId, style: const TextStyle(fontWeight: FontWeight.w800)),
      ),
      body: Loader<Map<String, dynamic>>(
        key: _loader,
        load: () async => await Api.get('/parcels/${Uri.encodeComponent(widget.trackingId)}') as Map<String, dynamic>,
        builder: (context, p, reload) {
          final r = (p['recipient'] as Map?) ?? {};
          final d = (p['delivery'] as Map?) ?? {};
          final charges = (p['charges'] as Map?) ?? {};
          final cod = (p['cod'] as Map?) ?? {};
          final svc = (p['service'] as Map?) ?? {};
          final proof = p['proof'] as Map?;
          final events = ((p['events'] as List?) ?? []).cast<Map<String, dynamic>>().where((e) => e['internal'] != true).toList().reversed.toList();
          final doc = p['type'] == 'DOCUMENT' || Session.isDocument;
          return RefreshIndicator(
            onRefresh: reload,
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 32),
              children: [
                Panel(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: SelectableText('${p['trackingId']}', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                          ),
                          IconButton(
                            tooltip: 'Copy tracking ID',
                            icon: const Icon(Icons.copy, size: 20),
                            onPressed: () {
                              Clipboard.setData(ClipboardData(text: '${p['trackingId']}'));
                              snack(context, 'Tracking ID copied.');
                            },
                          ),
                        ],
                      ),
                      StatusChip(p['status'] as String?, label: p['statusLabel'] as String?),
                      const SizedBox(height: 8),
                      KeyValue('Booked', dateTimeText(p['createdAt'])),
                      if (p['estimatedDeliveryAt'] != null && p['deliveredAt'] == null) KeyValue('Expected delivery', dateText(p['estimatedDeliveryAt'])),
                      if (p['pickedUpAt'] != null) KeyValue('Picked up', dateTimeText(p['pickedUpAt'])),
                      if (p['deliveredAt'] != null) KeyValue('Delivered', dateTimeText(p['deliveredAt']), color: good),
                      if (p['cancelledAt'] != null) KeyValue('Cancelled', dateTimeText(p['cancelledAt']), color: bad),
                      if (toNum(p['attemptCount']) > 0) KeyValue('Delivery attempts', count(p['attemptCount'])),
                    ],
                  ),
                ),
                Panel(
                  title: 'Recipient',
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('${r['name'] ?? '—'}', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                      const SizedBox(height: 2),
                      SelectableText(phoneText(r['phone'])),
                      const SizedBox(height: 6),
                      Text('${d['street'] ?? ''}'),
                      const SizedBox(height: 4),
                      KeyValue('Area', '${d['area'] ?? '—'}'),
                      KeyValue('Zone', '${d['zone'] ?? '—'}'),
                      KeyValue('District', '${d['district'] ?? '—'}'),
                    ],
                  ),
                ),
                Panel(
                  title: doc ? 'Consignment' : 'Parcel',
                  child: Column(
                    children: [
                      if (p['product'] != null) KeyValue('Product', '${p['product']}'),
                      if (!doc) KeyValue('Weight', '${p['weightKg'] ?? '—'} kg'),
                      KeyValue('Service', '${svc['speedLabel'] ?? p['serviceLevelLabel'] ?? '—'}'),
                      if (svc['firstMileLabel'] != null) KeyValue('Pickup', '${svc['firstMileLabel']}'),
                      if (svc['lastMileLabel'] != null) KeyValue('Delivery', '${svc['lastMileLabel']}'),
                      if (p['openBox'] == true) const KeyValue('Open box', 'Allowed'),
                      if (p['merchantOrderRef'] != null) KeyValue('Reference', '${p['merchantOrderRef']}'),
                      if (p['contents'] != null) KeyValue('Contents', '${p['contents']}'),
                      if (p['declaredValue'] != null && toNum(p['declaredValue']) > 0) KeyValue('Declared value', taka(p['declaredValue'])),
                      if (p['instructions'] != null) KeyValue('Instructions', '${p['instructions']}'),
                    ],
                  ),
                ),
                Panel(
                  title: 'Charges',
                  child: Column(
                    children: [
                      for (final l in ((charges['lines'] as List?) ?? []).cast<Map>()) KeyValue('${l['label']}', taka(l['amount'])),
                      if (((charges['lines'] as List?) ?? []).isEmpty) ...[
                        KeyValue('Delivery', taka(toNum(charges['base']) + toNum(charges['weight']) + toNum(charges['service']))),
                        if (toNum(charges['codFee']) > 0) KeyValue('COD fee', taka(charges['codFee'])),
                        if (toNum(charges['discount']) > 0) KeyValue('Discount', '-${taka(charges['discount'])}'),
                      ],
                      const Divider(),
                      KeyValue('Total charge', taka(charges['total']), bold: true),
                      if (!doc && toNum(p['codAmount']) > 0) ...[
                        const SizedBox(height: 6),
                        KeyValue('Cash to collect (COD)', taka(p['codAmount']), bold: true, color: good),
                        if (cod['state'] != null) KeyValue('COD status', humanize('${cod['state']}')),
                        if (cod['collectedAt'] != null) KeyValue('Collected', dateTimeText(cod['collectedAt'])),
                      ],
                    ],
                  ),
                ),
                if (proof != null)
                  Panel(
                    title: 'Proof of delivery',
                    child: Column(
                      children: [
                        KeyValue('Method', humanize('${proof['method']}')),
                        if (proof['receivedBy'] != null) KeyValue('Received by', '${proof['receivedBy']}'),
                        KeyValue('Recorded', dateTimeText(proof['recordedAt'])),
                      ],
                    ),
                  ),
                Panel(
                  title: 'Tracking',
                  child: events.isEmpty
                      ? const Text('No updates yet.', style: TextStyle(color: muted))
                      : Column(
                          children: [for (var i = 0; i < events.length; i++) _TimelineRow(event: events[i], first: i == 0, last: i == events.length - 1)],
                        ),
                ),
                if (p['canCancel'] == true)
                  OutlinedButton.icon(
                    onPressed: _busy ? null : _cancel,
                    style: OutlinedButton.styleFrom(
                      foregroundColor: bad,
                      side: const BorderSide(color: bad),
                      minimumSize: const Size.fromHeight(48),
                    ),
                    icon: const Icon(Icons.cancel_outlined),
                    label: const Text('Cancel order'),
                  ),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _TimelineRow extends StatelessWidget {
  const _TimelineRow({required this.event, required this.first, required this.last});
  final Map<String, dynamic> event;
  final bool first;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final c = first ? statusColor(event['status'] as String?) : const Color(0xFF98A2B3);
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: 22,
            child: Column(
              children: [
                Container(
                  width: 12,
                  height: 12,
                  margin: const EdgeInsets.only(top: 3),
                  decoration: BoxDecoration(color: c, shape: BoxShape.circle),
                ),
                if (!last) Expanded(child: Container(width: 2, color: line)),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${event['title'] ?? humanize(event['status'] as String?)}',
                    style: TextStyle(fontWeight: FontWeight.w700, color: first ? ink : const Color(0xFF475467)),
                  ),
                  if (event['description'] != null) Text('${event['description']}', style: const TextStyle(color: muted, fontSize: 13)),
                  const SizedBox(height: 2),
                  Text([dateTimeText(event['at']), if (event['location'] != null) '${event['location']}'].join(' · '), style: const TextStyle(color: Color(0xFF98A2B3), fontSize: 12)),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
