import 'dart:async';

import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'assign.dart';
import 'cash.dart';
import 'map.dart';
import 'more.dart';
import 'ops.dart';
import 'parcels.dart';
import 'scan.dart';

/// The shell, so a tapped push can switch tabs.
final opsShell = GlobalKey<OpsShellState>();

/// Bumped after the scan desk, assignments or cash changed something (Today and lists reload).
final opsChanged = ValueNotifier<int>(0);

/// Opens what a notification is about: a parcel its details, a support reply the request, cash the Cash tab,
/// new orders / pickup requests the assignment list.
Future<void> openOpsNotification(BuildContext context, Map<String, dynamic> n) async {
  final type = '${n['type'] ?? ''}';
  final ticket = ticketIn(n);
  if (ticket != null) {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => TicketPage(number: ticket)));
    return;
  }
  if (type.startsWith('cash.') || type.contains('transfer')) {
    Navigator.of(context).popUntil((r) => r.isFirst);
    opsShell.currentState?.openTab(3);
    return;
  }
  if (type == 'staff.merchant_order' || type == 'staff.pickup_request') {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const AssignPage(mode: AssignMode.pickup)));
    return;
  }
  final id = trackingIdIn(n);
  if (id != null) {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => ParcelPage(trackingId: id)));
    return;
  }
  final title = '${n['title'] ?? ''}';
  if (title.isEmpty) {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const NotificationsPage(onOpen: openOpsNotification)));
    return;
  }
  await showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: Text('${n['body'] ?? ''}'),
      actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('OK'))],
    ),
  );
}

/// Today, Scan, Map, Cash, More.
class OpsShell extends StatefulWidget {
  const OpsShell({super.key});
  @override
  State<OpsShell> createState() => OpsShellState();
}

class OpsShellState extends State<OpsShell> with WidgetsBindingObserver {
  int _tab = 0;
  bool _loading = true;
  String? _error;

  void openTab(int i) => setState(() => _tab = i);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _start();
    refreshUnread();
    Push.onReceive = (_) {
      refreshUnread();
      opsChanged.value++;
    };
    Push.onOpen = (data) {
      final context = navigatorKey.currentContext;
      if (context == null) return;
      markNotificationRead(data['notificationId'] as String?);
      openOpsNotification(context, data.cast<String, dynamic>());
    };
    Push.register('operations');
  }

  Future<void> _start() async {
    try {
      await Ops.load();
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = null;
      });
      // Several hubs and none chosen yet: ask once.
      if (Ops.hubId == null) WidgetsBinding.instance.addPostFrameCallback((_) => pickHub(context).then((_) => opsChanged.value++));
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
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      refreshUnread();
      opsChanged.value++;
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    if (_error != null) {
      return Scaffold(
        body: ErrorView(message: _error!, onRetry: _start),
      );
    }
    const titles = ['Today', 'Scan desk', 'Live map', 'Cash', 'More'];
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 16,
        title: ValueListenableBuilder<Map<String, dynamic>?>(
          valueListenable: Ops.hub,
          builder: (context, _, _) => InkWell(
            onTap: () => pickHub(context).then((ok) => ok ? opsChanged.value++ : null),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(titles[_tab], style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Flexible(
                      child: Text(
                        Ops.hubName,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12, color: muted),
                      ),
                    ),
                    const Icon(Icons.arrow_drop_down, size: 18, color: muted),
                  ],
                ),
              ],
            ),
          ),
        ),
        actions: [
          IconButton(tooltip: 'Find a parcel', onPressed: () => findParcel(context), icon: const Icon(Icons.search)),
          const NotificationBell(onOpen: openOpsNotification),
          const SizedBox(width: 6),
        ],
      ),
      body: IndexedStack(
        index: _tab,
        children: [
          TodayPage(onOpenTab: openTab),
          const ScanPage(),
          MapPage(visible: _tab == 2),
          const CashPage(),
          const MorePage(),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: openTab,
        destinations: const [
          NavigationDestination(icon: Icon(Icons.today_outlined), selectedIcon: Icon(Icons.today), label: 'Today'),
          NavigationDestination(icon: Icon(Icons.qr_code_scanner), label: 'Scan'),
          NavigationDestination(icon: Icon(Icons.map_outlined), selectedIcon: Icon(Icons.map), label: 'Map'),
          NavigationDestination(icon: Icon(Icons.payments_outlined), selectedIcon: Icon(Icons.payments), label: 'Cash'),
          NavigationDestination(icon: Icon(Icons.menu), label: 'More'),
        ],
      ),
    );
  }
}

/// Today at the hub: work by stage (each opens its list), riders on shift, cash with riders, alerts.
class TodayPage extends StatefulWidget {
  const TodayPage({super.key, required this.onOpenTab});
  final void Function(int tab) onOpenTab;
  @override
  State<TodayPage> createState() => _TodayPageState();
}

class _TodayPageState extends State<TodayPage> {
  Map<String, dynamic>? _counts;
  String? _error;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    opsChanged.addListener(_load);
    Ops.hub.addListener(_load);
    _load();
    _timer = Timer.periodic(const Duration(minutes: 1), (_) => _load());
  }

  @override
  void dispose() {
    opsChanged.removeListener(_load);
    Ops.hub.removeListener(_load);
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([
        Api.get('/ops/stage-counts', {'forHubIds': Ops.hubId}),
        Ops.load(),
      ]);
      if (!mounted) return;
      setState(() {
        _counts = (results[0] as Map).cast<String, dynamic>();
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  void _open(Widget page) => Navigator.of(context).push(MaterialPageRoute(builder: (_) => page)).then((_) => _load());

  @override
  Widget build(BuildContext context) {
    if (_counts == null && _error != null) return ErrorView(message: _error!, onRetry: _load);
    if (_counts == null) return const Center(child: CircularProgressIndicator());
    final d = (_counts!['detail'] as Map?) ?? {};
    final o = Ops.overview ?? {};
    final riders = (o['riders'] as Map?) ?? {};
    final cash = (o['cash'] as Map?) ?? {};
    final alerts = ((o['alerts'] as List?) ?? []).cast<Map<String, dynamic>>();
    final problems = toNum(d['problems']);
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
        children: [
          TilePairs(
            tiles: [
              StatTile(
                label: 'New orders to assign',
                value: count(d['newOrders']),
                icon: Icons.fiber_new_outlined,
                color: warn,
                onTap: () => _open(const AssignPage(mode: AssignMode.pickup)),
              ),
              StatTile(label: 'Riders picking up', value: count(d['pickingUp']), icon: Icons.storefront_outlined),
              StatTile(
                label: 'At the hub',
                value: count(d['hub']),
                icon: Icons.warehouse_outlined,
                onTap: () => _open(const ParcelListPage(title: 'At the hub', stage: 'hub')),
              ),
              StatTile(
                label: 'Waiting for a delivery rider',
                value: count(d['deliveryWaiting']),
                icon: Icons.person_search_outlined,
                color: warn,
                onTap: () => _open(const AssignPage(mode: AssignMode.delivery)),
              ),
              StatTile(
                label: 'Out for delivery',
                value: count(d['delivery']),
                icon: Icons.local_shipping_outlined,
                onTap: () => _open(const ParcelListPage(title: 'Out for delivery', stage: 'delivery')),
              ),
              StatTile(
                label: 'Transfers',
                value: count(d['transfers']),
                icon: Icons.swap_horiz,
                onTap: () => _open(const ParcelListPage(title: 'Transfers', stage: 'transfers')),
              ),
              StatTile(label: 'Problems', value: count(problems), icon: Icons.error_outline, color: problems > 0 ? bad : good, onTap: () => _open(const ProblemsPage())),
              StatTile(
                label: 'Returns',
                value: count(toNum(d['returnRequests']) + toNum(d['returnsScheduled'])),
                icon: Icons.undo,
                onTap: () => _open(const ParcelListPage(title: 'Returns', stage: 'returns')),
              ),
            ],
          ),
          Panel(
            title: 'Riders',
            trailing: TextButton(onPressed: () => widget.onOpenTab(2), child: const Text('Map')),
            child: Row(
              children: [
                _Mini('On shift', count(riders['online']), good),
                _Mini('On a break', count(riders['onBreak']), warn),
                _Mini('Offline', count(riders['offline']), muted),
                _Mini('With work', count(riders['withOpenTasks']), brand),
              ],
            ),
          ),
          Panel(
            title: 'Cash with riders',
            trailing: TextButton(onPressed: () => widget.onOpenTab(3), child: const Text('Cash')),
            child: KeyValue('${count(cash['collections'])} collection(s) not handed over yet', taka(cash['withRiders']), bold: true),
          ),
          for (final a in alerts)
            Panel(
              child: Row(
                children: [
                  Icon(Icons.notifications_active_outlined, color: a['tone'] == 'red' ? bad : warn),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('${a['title'] ?? ''}', style: const TextStyle(fontWeight: FontWeight.w700)),
                        Text('${a['text'] ?? ''}'.trim(), style: const TextStyle(color: muted)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _Mini extends StatelessWidget {
  const _Mini(this.label, this.value, this.color);
  final String label;
  final String value;
  final Color color;
  @override
  Widget build(BuildContext context) => Expanded(
    child: Column(
      children: [
        Text(
          value,
          style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: color),
        ),
        Text(
          label,
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 12, color: muted),
        ),
      ],
    ),
  );
}
