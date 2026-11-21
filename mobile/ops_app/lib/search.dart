import 'dart:async';

import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'ops.dart';
import 'parcels.dart';

/// The top bar's search, as on the Operations web panel: type or scan a tracking ID, CN or phone and the first
/// parcel's full details open at once, with its status under the box; other matches show as tags, one tap away.
/// A zone or area name shows the hub that serves it.
class SearchPage extends StatefulWidget {
  const SearchPage({super.key});
  @override
  State<SearchPage> createState() => _SearchPageState();
}

class _Place {
  _Place(this.district, this.zone, [this.area]);
  final String district;
  final String zone;
  final String? area;
  String? hub;
}

class _SearchPageState extends State<SearchPage> {
  final _box = TextEditingController();
  final _focus = FocusNode();
  Timer? _timer;
  int _seq = 0;
  bool _busy = false;
  String? _error;
  List<Map<String, dynamic>>? _results;
  String? _picked;
  List<_Place> _places = [];
  Map<String, dynamic>? _catalog;

  @override
  void initState() {
    super.initState();
    _focus.requestFocus();
    _loadCatalog();
  }

  Future<void> _loadCatalog() async {
    try {
      _catalog = (await Api.get('/catalog') as Map).cast<String, dynamic>();
    } catch (_) {}
  }

  @override
  void dispose() {
    _timer?.cancel();
    _box.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// Tracking ID, CN or phone → matching parcels (the web panel's findParcels).
  Future<List<Map<String, dynamic>>> _find(String raw) async {
    final code = normalizeScan(raw).replaceAll(RegExp(r'\s+'), '').toUpperCase();
    if (RegExp(r'^[A-Z0-9-]{4,}$').hasMatch(code) && !RegExp(r'^\d+$').hasMatch(code)) {
      try {
        return [(await Api.get('/parcels/${Uri.encodeComponent(code)}') as Map).cast<String, dynamic>()];
      } on ApiError catch (e) {
        if (e.status != 404) rethrow;
      }
    }
    final page = await Api.get('/parcels', {'limit': 20, 'q': raw.trim()}) as Map;
    return ((page['items'] as List?) ?? []).cast<Map<String, dynamic>>();
  }

  Future<List<Map<String, dynamic>>> _run(String raw) async {
    final text = raw.trim();
    final mine = ++_seq;
    if (text.length < 3) {
      setState(() => (_results = null, _picked = null, _error = null, _busy = false));
      return [];
    }
    setState(() => _busy = true);
    try {
      final found = await _find(text);
      if (mine == _seq && mounted) setState(() => (_results = found, _picked = found.firstOrNull?['trackingId'] as String?, _error = null));
      return found;
    } on ApiError catch (e) {
      if (mine == _seq && mounted) setState(() => _error = e.message);
      return [];
    } finally {
      if (mine == _seq && mounted) setState(() => _busy = false);
    }
  }

  void _changed(String value) {
    _timer?.cancel();
    _timer = Timer(const Duration(milliseconds: 350), () {
      _run(value);
      _findPlaces(value);
    });
  }

  /// A zone or area name: which hub serves it.
  Future<void> _findPlaces(String value) async {
    final t = value.trim().toLowerCase();
    final c = _catalog;
    if (t.length < 3 || RegExp(r'\d').hasMatch(t) || c == null) return setState(() => _places = []);
    final districts = ((c['districts'] as List?) ?? []).map((d) => '$d');
    final zonesBy = (c['zonesByDistrict'] as Map?) ?? {};
    final areasBy = (c['areasByZone'] as Map?) ?? {};
    final found = <_Place>[];
    for (final d in districts) {
      for (final z in ((zonesBy[d] as List?) ?? []).map((z) => '$z')) {
        if (z.toLowerCase().contains(t)) found.add(_Place(d, z));
      }
    }
    for (final d in districts) {
      for (final z in ((zonesBy[d] as List?) ?? []).map((z) => '$z')) {
        for (final a in ((areasBy[z] as List?) ?? []).map((a) => '$a')) {
          if (a.toLowerCase().contains(t) && !found.any((p) => p.zone == z && p.district == d && p.area == null)) found.add(_Place(d, z, a));
        }
      }
    }
    final top = found.take(6).toList();
    await Future.wait(top.map((p) async {
      try {
        final page = await Api.get('/zones', {'limit': 20, 'district': p.district, 'q': p.zone}) as Map;
        final z = ((page['items'] as List?) ?? []).cast<Map>().where((z) => '${z['name']}'.toLowerCase() == p.zone.toLowerCase() && z['hub'] != null).firstOrNull;
        p.hub = (z?['hub'] as Map?)?['name'] as String?;
      } catch (_) {}
      p.hub ??= Ops.hubs.where((h) => h['active'] != false && h['district'] == p.district && '${h['zone'] ?? ''}'.toLowerCase() == p.zone.toLowerCase()).firstOrNull?['name'] as String?;
    }));
    if (mounted && _box.text.trim().toLowerCase() == t) setState(() => _places = top);
  }

  Future<void> _scan() async {
    final code = await scanBarcode(context, title: 'Search', hint: 'Scan the label: the parcel opens here.');
    if (code == null || !mounted) return;
    _box.text = normalizeScan(code);
    _timer?.cancel();
    final found = await _run(_box.text);
    if (found.isEmpty && mounted) snack(context, 'No parcel found for “${_box.text}”.');
  }

  @override
  Widget build(BuildContext context) {
    final text = _box.text.trim();
    final list = _results ?? [];
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: TextField(
          controller: _box,
          focusNode: _focus,
          textInputAction: TextInputAction.search,
          decoration: InputDecoration(
            hintText: 'Tracking ID, CN, phone or zone…',
            isDense: true,
            prefixIcon: const Icon(Icons.search),
            suffixIcon: _busy
                ? const Padding(padding: EdgeInsets.all(12), child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)))
                : text.isEmpty
                ? null
                : IconButton(
                    tooltip: 'Clear',
                    icon: const Icon(Icons.close),
                    onPressed: () {
                      _box.clear();
                      _seq++;
                      setState(() => (_results = null, _picked = null, _places = [], _error = null));
                      _focus.requestFocus();
                    },
                  ),
          ),
          onChanged: (v) {
            setState(() {});
            _changed(v);
          },
          onSubmitted: (v) async {
            _timer?.cancel();
            if (v.trim().isEmpty) return;
            final found = await _run(v);
            _findPlaces(v);
            if (found.isEmpty && context.mounted && v.trim().length >= 3) snack(context, 'No parcel found for “${v.trim()}”.');
          },
        ),
        actions: [
          IconButton(tooltip: 'Scan the label', onPressed: _scan, icon: const Icon(Icons.qr_code_scanner)),
          const SizedBox(width: 4),
        ],
      ),
      body: _picked != null
          ? Loader<Map<String, dynamic>>(
              key: ValueKey(_picked),
              load: () async => (await Api.get('/parcels/${Uri.encodeComponent(_picked!)}') as Map).cast<String, dynamic>(),
              builder: (context, p, reload) => RefreshIndicator(
                onRefresh: reload,
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(12, 12, 12, 24),
                  children: [
                    _StatusLine(p),
                    if (list.length > 1) _matches(list),
                    const SizedBox(height: 10),
                    ...parcelSections(context, p, reload),
                  ],
                ),
              ),
            )
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(_error!, style: const TextStyle(color: bad))),
                if (text.isEmpty)
                  const _Empty(icon: Icons.search, title: 'Find a parcel', text: 'Type or scan a tracking ID or CN, or a phone number: the parcel opens here. A zone or area name shows the hub that serves it.')
                else if (text.length < 3)
                  const _Empty(text: 'Type at least 3 characters.')
                else if (_busy || _results == null)
                  const _Empty(text: 'Searching…')
                else if (_places.isEmpty)
                  _Empty(title: 'No parcel found', text: 'Nothing matches “$text”. Check the tracking ID, CN or phone number.'),
                if (_places.isNotEmpty && !_busy) ...[
                  const Padding(
                    padding: EdgeInsets.fromLTRB(2, 4, 2, 8),
                    child: Text('WHICH HUB SERVES IT', style: TextStyle(fontWeight: FontWeight.w800, color: muted, fontSize: 12, letterSpacing: .6)),
                  ),
                  for (final p in _places)
                    Panel(
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(p.area ?? p.zone, style: const TextStyle(fontWeight: FontWeight.w700)),
                                Text(p.area != null ? '${p.zone}, ${p.district}' : p.district, style: const TextStyle(color: muted, fontSize: 12.5)),
                              ],
                            ),
                          ),
                          p.hub != null
                              ? Text(p.hub!, style: const TextStyle(fontWeight: FontWeight.w700))
                              : const Text('No hub set for this zone', style: TextStyle(color: muted, fontSize: 12.5)),
                        ],
                      ),
                    ),
                ],
              ],
            ),
    );
  }

  Widget _matches(List<Map<String, dynamic>> list) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Wrap(
      spacing: 6,
      runSpacing: 6,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Text('${list.length} matches:', style: const TextStyle(color: muted, fontSize: 12.5)),
        for (final m in list.take(12))
          ChoiceChip(
            label: Text('${m['trackingId']}'),
            selected: m['trackingId'] == _picked,
            visualDensity: VisualDensity.compact,
            onSelected: (_) => setState(() => _picked = m['trackingId'] as String?),
          ),
      ],
    ),
  );
}

class _Empty extends StatelessWidget {
  const _Empty({this.icon, this.title, required this.text});
  final IconData? icon;
  final String? title;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 40, horizontal: 12),
    child: Column(
      children: [
        if (icon != null)
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: brand.withValues(alpha: .08), shape: BoxShape.circle),
            child: Icon(icon, size: 28, color: brand),
          ),
        if (icon != null) const SizedBox(height: 12),
        if (title != null) Text(title!, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
        if (title != null) const SizedBox(height: 4),
        Text(text, textAlign: TextAlign.center, style: const TextStyle(color: muted)),
      ],
    ),
  );
}

// ── The parcel's details, in the web panel's order (one column on a phone) ──

String _riderOf(Map p) {
  final status = '${p['status']}';
  final pickup = (p['pickupRider'] as Map?)?['label'] as String?;
  final delivery = (p['deliveryRider'] as Map?)?['label'] as String?;
  if (status == 'PENDING_CONFIRMATION' && p['intake'] == 'DROP_OFF') return 'Drop-off · ${(p['dropOffHub'] as Map?)?['name'] ?? 'hub'}';
  return switch (status) {
    'PENDING_CONFIRMATION' => 'Unassigned',
    'PICKUP_ASSIGNED' || 'PICKUP_CONFIRMED' || 'PICKED_UP' => pickup ?? 'Unassigned',
    'AT_HUB' || 'IN_TRANSIT' => delivery ?? 'Unassigned',
    'EXCEPTION' => delivery ?? pickup ?? 'Unassigned',
    'RETURN_SCHEDULED' => 'Return to sender',
    'RETURNED' => 'Returned to sender',
    'PICKUP_CANCELLED' => '—',
    _ => delivery ?? pickup ?? 'Unassigned',
  };
}

String _slaOf(Map p) {
  final promised = DateTime.tryParse('${p['estimatedDeliveryAt'] ?? ''}');
  final delivered = DateTime.tryParse('${p['deliveredAt'] ?? ''}');
  switch ('${p['status']}') {
    case 'DELIVERED':
      return promised != null && delivered != null && delivered.isAfter(promised) ? 'Late' : 'Met';
    case 'PICKUP_CANCELLED':
      return 'Cancelled';
    case 'RETURNED':
      return 'Returned';
    case 'RETURN_SCHEDULED':
      return 'Return scheduled';
    case 'EXCEPTION':
      return 'At risk';
    case 'PENDING_CONFIRMATION':
      return p['intake'] == 'DROP_OFF' ? 'Awaiting drop-off' : 'Awaiting review';
  }
  if (promised != null && promised.isBefore(DateTime.now())) return 'At risk';
  if (_riderOf(p) == 'Unassigned') return 'Assign now';
  if (p['status'] == 'PICKUP_ASSIGNED' || p['status'] == 'PICKUP_CONFIRMED') return 'Pickup scheduled';
  return 'On track';
}

Widget _pill(String text, Color color) => Container(
  padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
  decoration: BoxDecoration(color: color.withValues(alpha: .1), borderRadius: BorderRadius.circular(20)),
  child: Text(text, style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w700)),
);

/// The status under the search box: status, SLA, failed attempts, merchant · hub.
class _StatusLine extends StatelessWidget {
  const _StatusLine(this.p);
  final Map<String, dynamic> p;

  @override
  Widget build(BuildContext context) {
    final failed = toNum(p['failedAttempts']).toInt();
    final reason = '${(p['lastFailedAttempt'] as Map?)?['reason'] ?? ''}';
    final meta = [(p['merchant'] as Map?)?['name'] ?? (p['sender'] as Map?)?['name'], (p['currentHub'] as Map?)?['name']].where((x) => x != null && '$x'.isNotEmpty).join(' · ');
    final sla = _slaOf(p);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('${p['trackingId']}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
        const SizedBox(height: 6),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            StatusChip('${p['status']}', label: '${p['statusLabel'] ?? humanize('${p['status']}')}'),
            _pill(sla, sla == 'At risk' || sla == 'Late' || sla == 'Assign now' ? bad : muted),
            if (failed > 0) _pill('Failed ×$failed${reason.isNotEmpty ? ' · ${reason.length > 26 ? reason.substring(0, 26) : reason}' : ''}', bad),
            if (meta.isNotEmpty) Text(meta, style: const TextStyle(color: muted, fontSize: 12.5)),
          ],
        ),
      ],
    );
  }
}

/// Tracking, actions, failed attempts, where it is, price, parcel, proof of delivery.
List<Widget> parcelSections(BuildContext context, Map<String, dynamic> p, Future<void> Function() reload) {
  final status = '${p['status']}';
  final charges = (p['charges'] as Map?) ?? {};
  final cod = toNum(p['codAmount']);
  final failed = toNum(p['failedAttempts']).toInt();
  final last = p['lastFailedAttempt'] as Map?;
  final proof = p['proof'] as Map?;
  final pickupStage = ['PENDING_CONFIRMATION', 'PICKUP_ASSIGNED', 'PICKUP_CONFIRMED'].contains(status);
  final canAssign = pickupStage || ['AT_HUB', 'ASSIGNED', 'RETRY_SCHEDULED'].contains(status);
  final lines = ((charges['lines'] as List?) ?? []).cast<Map>();
  final priceLines = lines.isNotEmpty
      ? lines.map((l) => MapEntry('${l['label']}', toNum(l['amount']))).toList()
      : [
          MapEntry('Base charge', toNum(charges['base'])),
          MapEntry('Weight', toNum(charges['weight'])),
          MapEntry('Service', toNum(charges['service'])),
          MapEntry('COD fee', toNum(charges['codFee'])),
          MapEntry('Re-attempt', toNum(charges['reattempt'])),
          MapEntry('Discount', -toNum(charges['discount']).abs()),
        ].where((e) => e.value != 0).toList();
  String kv(Object? v) => v == null || '$v'.isEmpty ? '' : '$v';
  final rows = <MapEntry<String, String>>[
    MapEntry('Merchant / sender', kv((p['merchant'] as Map?)?['name'] ?? (p['sender'] as Map?)?['name']).ifEmpty('—')),
    MapEntry('Recipient', [kv((p['recipient'] as Map?)?['name']), phoneText((p['recipient'] as Map?)?['phone'])].where((x) => x.isNotEmpty && x != '—').join(' · ').ifEmpty('—')),
    MapEntry('Deliver to', kv((p['delivery'] as Map?)?['label']).ifEmpty('—')),
    MapEntry('Pickup from', p['intake'] == 'DROP_OFF' ? 'Drop-off at ${(p['dropOffHub'] as Map?)?['name'] ?? 'hub'}' : kv((p['pickup'] as Map?)?['label']).ifEmpty('—')),
    MapEntry('Service', [kv(p['serviceLevelLabel']), p['type'] == 'DOCUMENT' ? 'Document' : 'Parcel', if (p['weightKg'] != null) '${p['weightKg']} kg'].where((x) => x.isNotEmpty).join(' · ')),
    MapEntry('Delivery type', kv(p['deliveryType'] ?? (p['service'] as Map?)?['speedLabel'])),
    MapEntry('Priority', kv(p['priority'])),
    MapEntry('Product', kv(p['product'])),
    MapEntry('Rider', _riderOf(p)),
    MapEntry('Hub', kv((p['currentHub'] as Map?)?['name']).ifEmpty('—')),
    MapEntry('Order ref', kv(p['merchantOrderRef'])),
    MapEntry('Booked', dateTimeText(p['createdAt'])),
    MapEntry('Promised by', p['estimatedDeliveryAt'] == null ? '' : dateTimeText(p['estimatedDeliveryAt'])),
    MapEntry('Missing', p['incomplete'] == true ? ((p['missingLabels'] as List?) ?? []).join(', ') : ''),
    MapEntry('Return', p['returnInfo'] is Map ? [kv((p['returnInfo'] as Map)['reason']), (p['returnInfo'] as Map)['runId'] != null ? 'in a return run' : 'awaiting a return run'].where((x) => x.isNotEmpty).join(' · ') : ''),
  ].where((e) => e.value.isNotEmpty).toList();

  return [
    Panel(title: 'Tracking', child: _Tracking(p)),
    if (canAssign)
      Panel(
        title: 'Actions',
        child: FilledButton.icon(
          onPressed: () async {
            final rider = await pickRider(context, title: pickupStage ? 'Pickup rider' : 'Delivery rider', allHubs: pickupStage && Ops.isManager);
            if (rider == null || !context.mounted) return;
            try {
              await Api.post('/parcels/${Uri.encodeComponent('${p['trackingId']}')}/assign-${pickupStage ? 'pickup' : 'delivery'}', {'riderId': rider});
              if (context.mounted) snack(context, 'Rider assigned.');
              await reload();
            } on ApiError catch (e) {
              if (context.mounted) snack(context, e.message);
            }
          },
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(44)),
          icon: const Icon(Icons.person_add_alt),
          label: Text(pickupStage ? 'Assign pickup rider' : 'Assign delivery rider'),
        ),
      ),
    if (failed > 0)
      Panel(
        title: 'Delivery attempts ($failed failed)',
        child: Text(
          [
            if (last != null) 'Last ${dateTimeText(last['at'])}${last['riderName'] != null ? ' by ${last['riderName']}' : ''}${last['reason'] != null ? ': ${last['reason']}' : ''}',
            if (p['returnedAfterFailure'] == true) 'Back at the hub' else if (status == 'RETRY_SCHEDULED') 'Retry scheduled',
          ].join(' · '),
        ),
      ),
    Panel(
      title: 'Where is it now',
      child: Column(
        children: [
          KeyValue('Hub', '${(p['currentHub'] as Map?)?['name'] ?? '—'}'),
          KeyValue('Rider', _riderOf(p)),
        ],
      ),
    ),
    if (p['chargesOff'] != true)
      Panel(
        title: 'Price',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final l in priceLines) KeyValue(l.key, taka(l.value)),
            KeyValue('Total', taka(toNum(charges['total'])), bold: true),
            if (cod > 0)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text('Cash on delivery: ${taka(cod)}${(p['cod'] as Map?)?['state'] != null ? ' · ${humanize('${(p['cod'] as Map)['state']}').toLowerCase()}' : ''}', style: const TextStyle(color: muted)),
              ),
          ],
        ),
      ),
    Panel(
      title: 'Parcel',
      child: Column(children: [for (final r in rows) KeyValue(r.key, r.value)]),
    ),
    Panel(
      title: 'Proof of delivery',
      child: proof == null
          ? Text(status == 'DELIVERED' ? 'No proof of delivery recorded.' : 'Recorded by the rider at delivery.', style: const TextStyle(color: muted))
          : Column(
              children: [
                KeyValue('Method', const {'OTP': 'Delivery code', 'SIGNATURE': 'Signature', 'PHOTO': 'Photo'}['${proof['method']}'] ?? '${proof['method']}'),
                KeyValue('Received by', '${proof['receivedBy'] ?? '—'}${p['receiverRelation'] == 'Self' ? ' (self)' : p['receiverRelation'] != null ? ' (${p['receiverRelation']})' : ''}'),
                KeyValue('Recorded', dateTimeText(proof['recordedAt'])),
              ],
            ),
    ),
    OutlinedButton.icon(
      onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ParcelPage(trackingId: '${p['trackingId']}'))),
      icon: const Icon(Icons.call_outlined),
      label: const Text('Call recipient or sender'),
    ),
  ];
}

extension on String {
  String ifEmpty(String other) => isEmpty ? other : this;
}

/// The steps (Booked → Picked up / at hub → In transit → Out for delivery → Delivered) and the history, newest first.
class _Tracking extends StatefulWidget {
  const _Tracking(this.p);
  final Map<String, dynamic> p;
  @override
  State<_Tracking> createState() => _TrackingState();
}

class _TrackingState extends State<_Tracking> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final p = widget.p;
    final status = '${p['status']}';
    final events = ((p['events'] as List?) ?? []).cast<Map<String, dynamic>>().toList()..sort((a, b) => '${a['at']}'.compareTo('${b['at']}'));
    final end = status == 'RETURNED' || status == 'RETURN_SCHEDULED'
        ? (label: status == 'RETURNED' ? 'Returned' : 'Returning', statuses: ['RETURN_SCHEDULED', 'RETURNED'], color: warn)
        : status == 'PICKUP_CANCELLED'
        ? (label: 'Cancelled', statuses: ['PICKUP_CANCELLED'], color: bad)
        : (label: 'Delivered', statuses: ['DELIVERED'], color: good);
    final steps = [
      (label: 'Booked', statuses: ['PENDING_CONFIRMATION', 'PICKUP_ASSIGNED', 'PICKUP_CONFIRMED'], color: brand),
      (label: 'Picked up / at hub', statuses: ['PICKED_UP', 'AT_HUB'], color: brand),
      (label: 'In transit', statuses: ['IN_TRANSIT'], color: brand),
      (label: 'Out for delivery', statuses: ['ASSIGNED', 'OUT_FOR_DELIVERY', 'RETRY_SCHEDULED'], color: brand),
      end,
    ];
    final at = [for (final s in steps) events.where((e) => s.statuses.contains(e['status'])).firstOrNull];
    var lastDone = -1;
    for (var i = 0; i < at.length; i++) {
      if (at[i] != null) lastDone = i;
    }
    final history = events.reversed.toList();

    Widget row(Map<String, dynamic> e, {bool latest = false}) => Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(padding: const EdgeInsets.only(top: 4), child: Icon(Icons.circle, size: 10, color: latest ? brand : const Color(0xFFD0D5DD))),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(child: Text('${e['title'] ?? humanize('${e['status']}')}', style: const TextStyle(fontWeight: FontWeight.w700))),
                    if (e['internal'] == true) Padding(padding: const EdgeInsets.only(left: 6), child: _pill('internal', muted)),
                  ],
                ),
                if (e['location'] != null || e['description'] != null)
                  Text([e['location'], e['description']].where((x) => x != null && '$x'.isNotEmpty).join(' · '), style: const TextStyle(color: muted, fontSize: 13)),
                Text([dateTimeText(e['at']), if (e['actor'] != null && '${e['actor']}'.isNotEmpty) '${e['actor']}'].join(' · '), style: const TextStyle(color: Color(0xFF98A2B3), fontSize: 12)),
              ],
            ),
          ),
        ],
      ),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < steps.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(
              children: [
                CircleAvatar(
                  radius: 11,
                  backgroundColor: i <= lastDone ? (i == steps.length - 1 && at[i] != null ? steps[i].color : brand) : const Color(0xFFEAECF0),
                  child: Text(i <= lastDone ? '✓' : '${i + 1}', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: i <= lastDone ? Colors.white : muted)),
                ),
                const SizedBox(width: 10),
                Expanded(child: Text(steps[i].label, style: TextStyle(fontWeight: i == lastDone ? FontWeight.w800 : FontWeight.w600, color: i <= lastDone ? ink : muted))),
                Text(at[i] != null ? dateTimeText(at[i]!['at']) : (i < lastDone ? '—' : ''), style: const TextStyle(color: muted, fontSize: 12)),
              ],
            ),
          ),
        const Divider(height: 18),
        if (history.isEmpty) const Text('No tracking events yet.', style: TextStyle(color: muted)),
        if (history.isNotEmpty) row(history.first, latest: true),
        if (_open) for (final e in history.skip(1)) row(e),
        if (history.length > 1)
          Center(
            child: TextButton.icon(
              onPressed: () => setState(() => _open = !_open),
              icon: Icon(_open ? Icons.expand_less : Icons.expand_more),
              label: Text(_open ? 'View less' : 'View more (${history.length - 1})'),
            ),
          ),
      ],
    );
  }
}
