import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'riders.dart';
import 'scan.dart';
import 'signature_pad.dart';

/// Franchise mode of the Operations app (the franchise hub's account, Role FRANCHISE): everything happens at its own
/// hub, with its own riders only (GET/POST /franchise/…). A smaller app than the company hubs': receive, receive &
/// assign its riders, deliver or record a failed delivery itself (no rider needed, with proof), take returns and cash
/// from its riders together, its riders, its cash and deposits to a Delivery Fast hub.
final franchiseShell = GlobalKey<FranchiseShellState>();
final franchiseChanged = ValueNotifier<int>(0);

class Franchise {
  static Map<String, dynamic>? me;
  static String get name => '${me?['name'] ?? 'Franchise'}';
  static String get hubName => '${(me?['hub'] as Map?)?['name'] ?? ''}';
  static List<Map<String, dynamic>> get depositHubs => ((me?['depositHubs'] as List?) ?? []).cast<Map<String, dynamic>>();
  static Future<void> load() async => me = (await Api.get('/franchise/me') as Map).cast<String, dynamic>();
}

/// The franchise's riders to choose from (active ones).
Future<String?> pickFranchiseRider(BuildContext context, {String title = 'Choose the rider'}) async {
  List<Map<String, dynamic>> riders;
  try {
    riders = ((await Api.get('/franchise/riders')) as List).cast<Map<String, dynamic>>().where((r) => r['active'] == true).toList();
  } catch (e) {
    if (context.mounted) snack(context, errorText(e));
    return null;
  }
  if (!context.mounted) return null;
  if (riders.isEmpty) {
    snack(context, 'No active riders yet. Add one in Riders.');
    return null;
  }
  return pickFromList(
    context,
    title: title,
    items: riders.map((r) => '${r['id']}').toList(),
    labelOf: (id) {
      final r = riders.firstWhere((r) => r['id'] == id);
      return '${r['code']} · ${r['name']} · ${count(r['outForDelivery'])} out';
    },
  );
}

class FranchiseShell extends StatefulWidget {
  const FranchiseShell({super.key});
  @override
  State<FranchiseShell> createState() => FranchiseShellState();
}

class FranchiseShellState extends State<FranchiseShell> {
  int _tab = 0;
  bool _loading = true;
  String? _error;

  void openTab(int i) => setState(() => _tab = i);

  @override
  void initState() {
    super.initState();
    _start();
    refreshUnread();
    Push.onReceive = (_) {
      refreshUnread();
      franchiseChanged.value++;
    };
    Push.register('operations');
    // Where the franchise is, every 2 minutes while the app is open (super admin › Live map).
    Presence.start(path: '/staff/location', every: const Duration(minutes: 2));
  }

  Future<void> _start() async {
    try {
      await Franchise.load();
      loadReasons();
      if (mounted) setState(() => _loading = false);
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = errorText(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    if (_error != null) {
      return Scaffold(
        body: ErrorView(
          message: _error!,
          onRetry: () {
            setState(() {
              _loading = true;
              _error = null;
            });
            _start();
          },
        ),
      );
    }
    const titles = ['Today', 'Scan', 'Parcels', 'Riders', 'Cash'];
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 16,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(titles[_tab], style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
            Text('${Franchise.hubName} · franchise', style: const TextStyle(fontSize: 12, color: muted)),
          ],
        ),
        actions: [
          const NotificationBell(onOpen: _openNotification),
          PopupMenuButton<String>(
            onSelected: (v) async {
              if (v == 'support') {
                await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const SupportPage()));
              } else if (v == 'password') {
                await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const ChangePasswordPage()));
              } else if (v == 'out') {
                if (!await confirm(context, title: 'Sign out?', message: 'You will need your password to sign in again.', yes: 'Sign out')) return;
                await Push.unregister();
                await Session.logout();
                openSignIn();
              }
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'support', child: Text('Help & support')),
              PopupMenuItem(value: 'password', child: Text('Change password')),
              PopupMenuItem(value: 'out', child: Text('Sign out')),
            ],
          ),
        ],
      ),
      body: IndexedStack(
        index: _tab,
        children: [
          _TodayTab(onOpenTab: openTab),
          const _ScanTab(),
          const _ParcelsTab(),
          const _RidersTab(),
          const _CashTab(),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: openTab,
        destinations: const [
          NavigationDestination(icon: Icon(Icons.today_outlined), selectedIcon: Icon(Icons.today), label: 'Today'),
          NavigationDestination(icon: Icon(Icons.qr_code_scanner), label: 'Scan'),
          NavigationDestination(icon: Icon(Icons.inventory_2_outlined), selectedIcon: Icon(Icons.inventory_2), label: 'Parcels'),
          NavigationDestination(icon: Icon(Icons.two_wheeler_outlined), selectedIcon: Icon(Icons.two_wheeler), label: 'Riders'),
          NavigationDestination(icon: Icon(Icons.payments_outlined), selectedIcon: Icon(Icons.payments), label: 'Cash'),
        ],
      ),
    );
  }
}

Future<void> _openNotification(BuildContext context, Map<String, dynamic> n) async {
  final title = '${n['title'] ?? ''}';
  if (title.isEmpty) return;
  await showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: Text('${n['body'] ?? ''}'),
      actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('OK'))],
    ),
  );
}

/// Reloads when something changed in another tab.
class _Reloading extends StatelessWidget {
  const _Reloading({super.key, required this.load, required this.builder});
  final Future<dynamic> Function() load;
  final Widget Function(BuildContext context, dynamic data, Future<void> Function() reload) builder;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<int>(
      valueListenable: franchiseChanged,
      builder: (context, v, _) => Loader<dynamic>(key: ValueKey(v), load: load, builder: builder),
    );
  }
}

class _TodayTab extends StatelessWidget {
  const _TodayTab({required this.onOpenTab});
  final void Function(int) onOpenTab;

  @override
  Widget build(BuildContext context) {
    return _Reloading(
      load: () => Api.get('/franchise/overview'),
      builder: (context, data, reload) {
        final o = (data as Map).cast<String, dynamic>();
        final today = (o['today'] as Map?) ?? {};
        final now = (o['now'] as Map?) ?? {};
        final cash = (o['cash'] as Map?) ?? {};
        return RefreshIndicator(
          onRefresh: reload,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Text(Franchise.name, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
              const SizedBox(height: 10),
              TilePairs(
                tiles: [
                  StatTile(label: 'At the hub', value: count(now['atHub']), icon: Icons.warehouse_outlined, onTap: () => onOpenTab(2)),
                  StatTile(label: 'On the way here', value: count(now['incoming']), icon: Icons.local_shipping_outlined, onTap: () => onOpenTab(2)),
                  StatTile(label: 'Out for delivery', value: count(now['outForDelivery']), icon: Icons.two_wheeler, color: warn, onTap: () => onOpenTab(2)),
                  StatTile(label: 'Riders', value: count(now['riders']), icon: Icons.people_outline, onTap: () => onOpenTab(3)),
                  StatTile(label: 'Delivered today', value: count(today['delivered']), icon: Icons.check_circle_outline, color: good),
                  StatTile(label: 'Failed today', value: count(today['failed']), icon: Icons.report_gmailerrorred_outlined, color: bad),
                  StatTile(label: 'Cash to deposit', value: taka(cash['onHand']), icon: Icons.payments_outlined, color: good, onTap: () => onOpenTab(4)),
                  StatTile(label: 'Cash with riders', value: taka(cash['withRiders']), icon: Icons.account_balance_wallet_outlined, color: warn, onTap: () => onOpenTab(4)),
                ],
              ),
              const SizedBox(height: 10),
              Panel(
                child: Column(
                  children: [
                    KeyValue('Commission today', taka(today['commission'])),
                    KeyValue('Commission this month', taka(o['commissionThisMonth']), bold: true),
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

class _ScanTab extends StatelessWidget {
  const _ScanTab();

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
        if (r.ok) done.value = '${++n} done';
        return r;
      },
    );
    franchiseChanged.value++;
  }

  Future<void> _receive(BuildContext context) => _session(
    context,
    title: 'Receive at ${Franchise.hubName}',
    hint: 'Scan every parcel arriving: transfers, drop-offs, parcels coming back.',
    action: (code, source) => deskScan('/franchise/receive', {'code': code, 'source': source}),
  );

  Future<void> _assign(BuildContext context) async {
    final rider = await pickFranchiseRider(context, title: 'Who takes them?');
    if (rider == null || !context.mounted) return;
    await _session(
      context,
      title: 'Receive & assign rider',
      hint: 'Scan each parcel the rider takes. Not received yet? It is received here and given to the rider.',
      action: (code, source) => deskScan('/franchise/assign-scan', {'code': code, 'riderId': rider, 'source': source}),
    );
  }

  /// Returns and cash from one rider, together: scan what they bring back, then take their cash.
  Future<void> _riderBack(BuildContext context) async {
    final rider = await pickFranchiseRider(context, title: 'Which rider is back?');
    if (rider == null || !context.mounted) return;
    final decision = await pickFromList(context, title: 'Failed deliveries: what next?', items: backDecisions.keys.toList(), selected: 'RIDER', labelOf: (k) => backDecisions[k]!);
    if (decision == null || !context.mounted) return;
    await _session(
      context,
      title: 'Returns from the rider',
      hint: 'Scan each parcel the rider brings back. Then take their cash.',
      action: (code, source) => deskScan('/franchise/receive', {'code': code, 'source': source, 'decision': decision}),
    );
    if (!context.mounted) return;
    await takeRiderCash(context, rider);
  }

  Future<void> _deliver(BuildContext context) async {
    final code = await scanBarcode(context, title: 'Deliver', hint: 'Scan the parcel you hand over.');
    if (code == null || !context.mounted) return;
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => DirectDeliveryPage(trackingId: normalizeScan(code))));
    franchiseChanged.value++;
  }

  Future<void> _failed(BuildContext context) async {
    final code = await scanBarcode(context, title: 'Not delivered', hint: 'Scan the parcel that could not be delivered.');
    if (code == null || !context.mounted) return;
    await directFail(context, normalizeScan(code));
    franchiseChanged.value++;
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
      children: [
        const Padding(
          padding: EdgeInsets.only(bottom: 10),
          child: Text('Choose the task, then scan. Only your hub\'s parcels and your own riders.', style: TextStyle(color: muted)),
        ),
        _Task(Icons.move_to_inbox_outlined, good, 'Receive at hub', 'Transfers, drop-offs, parcels coming back.', () => _receive(context)),
        _Task(Icons.person_add_alt_1_outlined, good, 'Receive & assign rider', 'Choose your rider, then scan what they take.', () => _assign(context)),
        _Task(Icons.check_circle_outline, good, 'Deliver (no rider)', 'Hand it over yourself: proof by photo or signature.', () => _deliver(context)),
        _Task(Icons.report_gmailerrorred_outlined, bad, 'Not delivered (no rider)', 'Deliver again later, or back to the sender.', () => _failed(context)),
        _Task(Icons.keyboard_return, warn, 'Rider back: returns & cash', 'Scan what they bring back, then take their cash.', () => _riderBack(context)),
      ],
    );
  }
}

class _Task extends StatelessWidget {
  const _Task(this.icon, this.color, this.title, this.text, this.onTap);
  final IconData icon;
  final Color color;
  final String title;
  final String text;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Panel(
      padding: EdgeInsets.zero,
      child: ListTile(
        leading: Icon(icon, color: color),
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.w800)),
        subtitle: Text(text),
        trailing: const Icon(Icons.qr_code_scanner, color: Color(0xFF98A2B3)),
        onTap: onTap,
      ),
    );
  }
}

/// A failed delivery recorded by the franchise: the reason and what next.
Future<void> directFail(BuildContext context, String trackingId) async {
  await loadReasons();
  if (!context.mounted) return;
  final reason = await pickFromList(context, title: 'Why could it not be delivered?', items: failureReasons);
  if (reason == null || !context.mounted) return;
  final decision = await pickFromList(context, title: 'What next?', items: const ['REATTEMPT', 'RETURN'], selected: 'REATTEMPT', labelOf: (k) => k == 'RETURN' ? 'Return to the sender' : 'Deliver again later');
  if (decision == null || !context.mounted) return;
  try {
    await Api.post('/franchise/parcels/${Uri.encodeComponent(trackingId)}/fail', {'reason': reason, 'decision': decision});
    if (context.mounted) snack(context, '$trackingId: $reason · ${decision == 'RETURN' ? 'back to the sender' : 'to deliver again'}.');
  } on ApiError catch (e) {
    if (context.mounted) snack(context, e.message);
  }
}

/// The rider's cash with them (COD of their deliveries): take it all at the counter.
Future<void> takeRiderCash(BuildContext context, String riderId) async {
  Map<String, dynamic>? entry;
  try {
    final cash = (await Api.get('/franchise/cash') as Map).cast<String, dynamic>();
    final list = ((cash['riders'] as List?) ?? []).cast<Map<String, dynamic>>();
    entry = list.where((r) => r['riderId'] == riderId).firstOrNull;
  } catch (e) {
    if (context.mounted) snack(context, errorText(e));
    return;
  }
  if (!context.mounted) return;
  if (entry == null || toNum(entry['amount']) <= 0) {
    snack(context, 'The rider has no cash to hand over.');
    return;
  }
  final parcels = ((entry['parcels'] as List?) ?? []).length;
  if (!await confirm(context, title: 'Take ${taka(entry['amount'])}?', message: 'Cash on delivery of $parcels parcel(s). Count it before you confirm.', yes: 'Cash received')) return;
  try {
    await Api.post('/franchise/cash/handovers', {'riderId': riderId, 'collectionIds': entry['collectionIds'], 'amountReceived': entry['amount']});
    if (context.mounted) snack(context, '${taka(entry['amount'])} received.');
    franchiseChanged.value++;
  } on ApiError catch (e) {
    if (context.mounted) snack(context, e.message);
  }
}

class _ParcelsTab extends StatefulWidget {
  const _ParcelsTab();
  @override
  State<_ParcelsTab> createState() => _ParcelsTabState();
}

class _ParcelsTabState extends State<_ParcelsTab> {
  static const views = {'at-hub': 'At the hub', 'incoming': 'On the way', 'out': 'Out for delivery', 'returns': 'Returns', 'delivered': 'Delivered (7 days)'};
  String _view = 'at-hub';

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        SizedBox(
          height: 52,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
            children: [
              for (final e in views.entries)
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: ChoiceChip(label: Text(e.value), selected: _view == e.key, onSelected: (_) => setState(() => _view = e.key)),
                ),
            ],
          ),
        ),
        Expanded(
          child: _Reloading(
            key: ValueKey(_view),
            load: () => Api.get('/franchise/parcels', {'view': _view}),
            builder: (context, data, reload) {
              final items = (((data as Map)['items'] as List?) ?? []).cast<Map<String, dynamic>>();
              if (items.isEmpty) return RefreshIndicator(onRefresh: reload, child: ListView(children: const [SizedBox(height: 80), EmptyView(icon: Icons.inventory_2_outlined, text: 'No parcels here.')]));
              return RefreshIndicator(
                onRefresh: reload,
                child: ListView.builder(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
                  itemCount: items.length,
                  itemBuilder: (context, i) => _ParcelCard(p: items[i], deliverable: _view == 'at-hub' || _view == 'out'),
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _ParcelCard extends StatelessWidget {
  const _ParcelCard({required this.p, required this.deliverable});
  final Map<String, dynamic> p;
  final bool deliverable;

  @override
  Widget build(BuildContext context) {
    final id = '${p['trackingId']}';
    final rider = (p['deliveryRider'] as Map?)?['label'];
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(id, style: const TextStyle(fontWeight: FontWeight.w800))),
              StatusChip('${p['status']}', label: '${p['statusLabel'] ?? humanize('${p['status']}')}'),
            ],
          ),
          const SizedBox(height: 4),
          Text('${p['recipient'] ?? ''} · ${phoneText(p['recipientPhone'])}', style: const TextStyle(color: muted)),
          Text('${p['destination'] ?? ''}${toNum(p['codAmount']) > 0 ? ' · COD ${taka(p['codAmount'])}' : ''}', style: const TextStyle(color: muted)),
          if (rider != null) Text('Rider: $rider', style: const TextStyle(color: muted)),
          if (deliverable) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () async {
                      await Navigator.of(context).push(MaterialPageRoute(builder: (_) => DirectDeliveryPage(trackingId: id, parcel: p)));
                      franchiseChanged.value++;
                    },
                    child: const Text('Deliver'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton(
                    style: OutlinedButton.styleFrom(foregroundColor: bad),
                    onPressed: () async {
                      await directFail(context, id);
                      franchiseChanged.value++;
                    },
                    child: const Text('Not delivered'),
                  ),
                ),
              ],
            ),
            if ('${p['status']}' == 'AT_HUB')
              TextButton.icon(
                onPressed: () async {
                  final rider = await pickFranchiseRider(context, title: 'Give $id to');
                  if (rider == null || !context.mounted) return;
                  try {
                    await Api.post('/franchise/parcels/${Uri.encodeComponent(id)}/assign', {'riderId': rider, 'task': 'DELIVERY'});
                    if (context.mounted) snack(context, '$id assigned.');
                    franchiseChanged.value++;
                  } on ApiError catch (e) {
                    if (context.mounted) snack(context, e.message);
                  }
                },
                icon: const Icon(Icons.person_add_alt_1_outlined),
                label: const Text('Assign rider'),
              ),
          ],
        ],
      ),
    );
  }
}

/// Delivered by the franchise itself: who received it, the cash, and the proof (photo or signature).
class DirectDeliveryPage extends StatefulWidget {
  const DirectDeliveryPage({super.key, required this.trackingId, this.parcel});
  final String trackingId;
  final Map<String, dynamic>? parcel;
  @override
  State<DirectDeliveryPage> createState() => _DirectDeliveryPageState();
}

class _DirectDeliveryPageState extends State<DirectDeliveryPage> {
  final _receivedBy = TextEditingController();
  final _note = TextEditingController();
  final _sign = GlobalKey<SignaturePadState>();
  List<String> _relations = const ['Self'];
  String _relation = 'Self';
  String _method = 'PHOTO';
  String? _photo;
  bool _busy = false;
  String? _error;
  Map<String, dynamic>? _parcel;

  @override
  void initState() {
    super.initState();
    _parcel = widget.parcel;
    if (_parcel == null) {
      Api.get('/franchise/parcels', {'view': 'all', 'q': widget.trackingId, 'limit': '5'})
          .then((r) {
            final items = (((r as Map)['items'] as List?) ?? []).cast<Map<String, dynamic>>();
            final match = items.where((p) => '${p['trackingId']}'.toUpperCase() == widget.trackingId.toUpperCase()).firstOrNull;
            if (mounted) setState(() => _parcel = match ?? (items.isNotEmpty ? items.first : null));
          })
          .catchError((_) {});
    }
    Api.get('/delivery/receiver-relations')
        .then((r) {
          final list = ((r as Map)['relations'] as List?)?.map((x) => '$x').toList();
          if (list != null && list.isNotEmpty && mounted) setState(() => _relations = list);
        })
        .catchError((_) {});
  }

  @override
  void dispose() {
    _receivedBy.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final who = _receivedBy.text.trim().isEmpty ? '${_parcel?['recipient'] ?? ''}'.trim() : _receivedBy.text.trim();
    if (who.isEmpty) return setState(() => _error = 'Enter who received it.');
    final image = _method == 'PHOTO' ? _photo : await _sign.currentState?.toDataUrl();
    if (image == null) return setState(() => _error = _method == 'PHOTO' ? 'Take a photo as the proof.' : 'Ask the recipient to sign.');
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await Api.post('/franchise/parcels/${Uri.encodeComponent(widget.trackingId)}/deliver', {
        'receivedBy': who,
        'receiverRelation': _relation,
        'codCollected': toNum(_parcel?['codAmount']),
        'proof': {'method': _method, 'image': image},
        if (_note.text.trim().isNotEmpty) 'note': _note.text.trim(),
      });
      if (!mounted) return;
      snack(context, '${widget.trackingId} delivered.');
      Navigator.of(context).pop(true);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final cod = toNum(_parcel?['codAmount']);
    return Scaffold(
      appBar: AppBar(title: Text('Deliver ${widget.trackingId}')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (_parcel != null)
              Panel(
                child: Column(
                  children: [
                    KeyValue('Recipient', '${_parcel!['recipient'] ?? '—'}'),
                    KeyValue('Phone', phoneText(_parcel!['recipientPhone'])),
                    KeyValue('Cash to collect', cod > 0 ? taka(cod) : 'None', bold: true, color: cod > 0 ? warn : null),
                  ],
                ),
              ),
            TextField(controller: _receivedBy, maxLength: 120, decoration: const InputDecoration(labelText: 'Received by (default: the recipient)', counterText: '')),
            const SizedBox(height: 8),
            PickerField(label: 'Relation to the recipient', value: _relation, onTap: () async {
              final v = await pickFromList(context, title: 'Who received it?', items: _relations, selected: _relation);
              if (v != null) setState(() => _relation = v);
            }),
            const SizedBox(height: 12),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'PHOTO', label: Text('Photo'), icon: Icon(Icons.photo_camera_outlined)),
                ButtonSegment(value: 'SIGNATURE', label: Text('Signature'), icon: Icon(Icons.draw_outlined)),
              ],
              selected: {_method},
              onSelectionChanged: (s) => setState(() => _method = s.first),
            ),
            const SizedBox(height: 10),
            if (_method == 'PHOTO')
              OutlinedButton.icon(
                onPressed: () async {
                  final p = await pickPhotoDataUrl(context);
                  if (p != null && mounted) setState(() => _photo = p);
                },
                icon: Icon(_photo == null ? Icons.photo_camera_outlined : Icons.check_circle, color: _photo == null ? null : good),
                label: Text(_photo == null ? 'Take the proof photo' : 'Photo taken (tap to take again)'),
              )
            else
              Container(
                height: 180,
                decoration: BoxDecoration(border: Border.all(color: line), borderRadius: BorderRadius.circular(12), color: Colors.white),
                child: SignaturePad(key: _sign),
              ),
            const SizedBox(height: 10),
            TextField(controller: _note, maxLength: 500, decoration: const InputDecoration(labelText: 'Note (optional)', counterText: '')),
            if (_error != null) ...[const SizedBox(height: 12), ErrorBox(_error!)],
            const SizedBox(height: 16),
            BusyButton(label: cod > 0 ? 'Delivered · ${taka(cod)} collected' : 'Delivered', busy: _busy, onPressed: _submit, icon: Icons.check),
          ],
        ),
      ),
    );
  }
}

class _RidersTab extends StatelessWidget {
  const _RidersTab();

  Future<void> _add(BuildContext context) async {
    final added = await addRiderVia(context, path: '/franchise/riders', note: 'They work only for your hub. No message is sent: share the sign-in details shown next.');
    if (added) franchiseChanged.value++;
  }

  @override
  Widget build(BuildContext context) {
    return _Reloading(
      load: () => Api.get('/franchise/riders'),
      builder: (context, data, reload) {
        final riders = (data as List).cast<Map<String, dynamic>>();
        return RefreshIndicator(
          onRefresh: reload,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              FilledButton.icon(onPressed: () => _add(context), icon: const Icon(Icons.person_add_alt_1), label: const Text('Add a rider')),
              const SizedBox(height: 6),
              const Text('Your riders work only for your hub. You pay them yourself.', style: TextStyle(color: muted)),
              const SizedBox(height: 10),
              if (riders.isEmpty) const EmptyView(icon: Icons.two_wheeler, text: 'No riders yet.'),
              for (final r in riders)
                Panel(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(child: Text('${r['code']} · ${r['name']}', style: const TextStyle(fontWeight: FontWeight.w800))),
                          StatusChip(r['active'] == true ? '${r['status']}' : 'INACTIVE', label: r['active'] == true ? humanize('${r['status']}') : 'Inactive'),
                        ],
                      ),
                      Text('Franchise rider · ${phoneText(r['phone'])}', style: const TextStyle(color: muted)),
                      Text('${count(r['outForDelivery'])} out · cash ${taka(r['cashWithRider'])} · unpaid ${taka(r['unpaid'])}', style: const TextStyle(color: muted)),
                      if (toNum(r['cashWithRider']) > 0)
                        TextButton.icon(onPressed: () => takeRiderCash(context, '${r['id']}'), icon: const Icon(Icons.payments_outlined), label: Text('Take ${taka(r['cashWithRider'])}')),
                      TextButton.icon(
                        onPressed: () => resetRiderPasswordVia(context, path: '/franchise/riders/${r['id']}/password', rider: r),
                        icon: const Icon(Icons.lock_reset),
                        label: const Text('New password'),
                      ),
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

class _CashTab extends StatelessWidget {
  const _CashTab();

  Future<void> _deposit(BuildContext context, Map<String, dynamic> cash) async {
    final hubs = Franchise.depositHubs;
    if (hubs.isEmpty) return snack(context, 'No Delivery Fast hub to deposit at.');
    final hub = await pickFromList(context, title: 'Deposit at which hub?', items: hubs.map((h) => '${h['id']}').toList(), labelOf: (id) => '${hubs.firstWhere((h) => h['id'] == id)['name']}');
    if (hub == null || !context.mounted) return;
    final now = (cash['depositNow'] as Map?) ?? {};
    if (!await confirm(context, title: 'Deposit ${taka(now['net'])}?', message: 'Take the cash to the hub; it confirms when it receives it.', yes: 'Send deposit')) return;
    try {
      await Api.post('/franchise/deposits', {'hubId': hub});
      if (context.mounted) snack(context, 'Deposit sent. The hub confirms it when the cash arrives.');
      franchiseChanged.value++;
    } on ApiError catch (e) {
      if (context.mounted) snack(context, e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    return _Reloading(
      load: () => Api.get('/franchise/cash'),
      builder: (context, data, reload) {
        final c = (data as Map).cast<String, dynamic>();
        final now = (c['depositNow'] as Map?) ?? {};
        final remittances = ((c['remittances'] as List?) ?? []).cast<Map<String, dynamic>>();
        final riders = ((c['riders'] as List?) ?? []).cast<Map<String, dynamic>>();
        return RefreshIndicator(
          onRefresh: reload,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Panel(
                title: 'Cash at your hub',
                child: Column(
                  children: [
                    KeyValue('Cash on delivery', taka(c['codOnHand'])),
                    KeyValue('Counter charges', taka(c['counterOnHand'])),
                    KeyValue('Commission kept', taka(now['commissionDeducted'])),
                    KeyValue('To deposit now', taka(now['net']), bold: true, color: good),
                    KeyValue('With your riders', taka(c['withRiders']), color: warn),
                  ],
                ),
              ),
              BusyButton(label: 'Deposit at a Delivery Fast hub', busy: false, onPressed: toNum(now['gross']) > 0 ? () => _deposit(context, c) : null, icon: Icons.account_balance),
              const SizedBox(height: 14),
              if (riders.isNotEmpty) const Text('Riders\' cash', style: TextStyle(fontWeight: FontWeight.w800)),
              for (final r in riders)
                Panel(
                  padding: EdgeInsets.zero,
                  child: ListTile(
                    title: Text(taka(r['amount']), style: const TextStyle(fontWeight: FontWeight.w800)),
                    subtitle: Text('${((r['parcels'] as List?) ?? []).length} parcel(s)'),
                    trailing: TextButton(onPressed: () => takeRiderCash(context, '${r['riderId']}'), child: const Text('Take cash')),
                  ),
                ),
              const SizedBox(height: 10),
              if (remittances.isNotEmpty) const Text('Deposits', style: TextStyle(fontWeight: FontWeight.w800)),
              for (final r in remittances)
                Panel(
                  padding: EdgeInsets.zero,
                  child: ListTile(
                    title: Text('${r['number']} · ${taka(r['net'])}', style: const TextStyle(fontWeight: FontWeight.w700)),
                    subtitle: Text('${(r['hub'] as Map?)?['name'] ?? ''} · ${dateText(r['requestedAt'])}'),
                    trailing: StatusChip('${r['status']}'),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}
