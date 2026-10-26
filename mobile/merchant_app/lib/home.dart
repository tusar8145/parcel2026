import 'dart:async';

import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'balance.dart';
import 'create_order.dart';
import 'notifications.dart';
import 'orders.dart';
import 'pickups.dart';
import 'profile.dart';

/// Bumped after a booking or a cancel, so open lists and the dashboard reload.
final ordersChanged = ValueNotifier<int>(0);

/// Opens the order form; after a booking, the new order's page.
Future<void> openCreateOrder(BuildContext context) async {
  final trackingId = await Navigator.of(context).push<String>(MaterialPageRoute(builder: (_) => const CreateOrderPage()));
  if (trackingId == null || !context.mounted) return;
  ordersChanged.value++;
  Navigator.of(context).push(MaterialPageRoute(builder: (_) => OrderDetailPage(trackingId: trackingId)));
}

/// The signed-in app: Home, Orders, Pickups, Balance and Account tabs.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});
  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> with WidgetsBindingObserver {
  int _tab = 0;
  Timer? _timer;
  final _ordersKey = GlobalKey<OrdersPageState>();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    refreshUnread();
    _timer = Timer.periodic(const Duration(seconds: 60), (_) => refreshUnread());
    // Pushes: a new one refreshes the bell and the lists; a tapped one opens what it is about.
    Push.onReceive = (_) {
      refreshUnread();
      ordersChanged.value++;
    };
    Push.onOpen = (data) {
      final context = navigatorKey.currentContext;
      if (context == null) return;
      markNotificationRead(data['notificationId'] as String?);
      openMerchantNotification(context, data.cast<String, dynamic>());
    };
    Push.register('merchant');
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) refreshUnread();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    super.dispose();
  }

  /// Opens the Orders tab with a status filter (from the dashboard's tiles).
  void showOrders(String filter) {
    setState(() => _tab = 1);
    WidgetsBinding.instance.addPostFrameCallback((_) => _ordersKey.currentState?.setFilter(filter));
  }

  @override
  Widget build(BuildContext context) {
    final tabs = [DashboardPage(onShowOrders: showOrders, onOpenTab: (i) => setState(() => _tab = i)), OrdersPage(key: _ordersKey), const PickupsPage(), const BalancePage(), const ProfilePage()];
    const titles = ['Home', 'Orders', 'Pickups', 'Balance', 'Account'];
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 16,
        title: _tab == 0
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    Session.merchantName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17),
                  ),
                  Text(Session.isDocument ? 'Banking & Financial merchant' : 'E-commerce merchant', style: const TextStyle(fontSize: 12, color: muted)),
                ],
              )
            : Text(titles[_tab], style: const TextStyle(fontWeight: FontWeight.w800)),
        actions: const [
          NotificationBell(onOpen: openMerchantNotification),
          SizedBox(width: 6),
        ],
      ),
      body: IndexedStack(index: _tab, children: tabs),
      floatingActionButton: _tab <= 1
          ? FloatingActionButton.extended(heroTag: 'order', onPressed: () => openCreateOrder(context), icon: const Icon(Icons.add), label: Text(Session.isDocument ? 'New consignment' : 'New order'))
          : null,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.dashboard_outlined), selectedIcon: Icon(Icons.dashboard), label: 'Home'),
          NavigationDestination(icon: Icon(Icons.inventory_2_outlined), selectedIcon: Icon(Icons.inventory_2), label: 'Orders'),
          NavigationDestination(icon: Icon(Icons.local_shipping_outlined), selectedIcon: Icon(Icons.local_shipping), label: 'Pickups'),
          NavigationDestination(icon: Icon(Icons.account_balance_wallet_outlined), selectedIcon: Icon(Icons.account_balance_wallet), label: 'Balance'),
          NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: 'Account'),
        ],
      ),
    );
  }
}

/// Home: today's numbers, parcels by stage, this month's money and the last 7 days.
class DashboardPage extends StatefulWidget {
  const DashboardPage({super.key, required this.onShowOrders, required this.onOpenTab});
  final void Function(String filter) onShowOrders;
  final void Function(int tab) onOpenTab;
  @override
  State<DashboardPage> createState() => _DashboardPageState();
}

class _DashboardPageState extends State<DashboardPage> {
  final _loader = GlobalKey<LoaderState<Map<String, dynamic>>>();

  @override
  void initState() {
    super.initState();
    ordersChanged.addListener(_reload);
  }

  @override
  void dispose() {
    ordersChanged.removeListener(_reload);
    super.dispose();
  }

  void _reload() => _loader.currentState?.reload();

  Future<Map<String, dynamic>> _load() async {
    final stats = await Api.get('/merchants/me/stats') as Map<String, dynamic>;
    Map<String, dynamic>? account;
    try {
      final list = await Api.get('/my-accounts');
      if (list is List && list.isNotEmpty) account = list.first as Map<String, dynamic>;
    } catch (_) {}
    return {'stats': stats, 'account': account};
  }

  @override
  Widget build(BuildContext context) {
    return Loader<Map<String, dynamic>>(
      key: _loader,
      load: _load,
      builder: (context, data, reload) {
        final s = data['stats'] as Map<String, dynamic>;
        final p = (s['parcels'] as Map?) ?? {};
        final today = (s['today'] as Map?) ?? {};
        final month = (s['thisMonth'] as Map?) ?? {};
        final account = data['account'] as Map<String, dynamic>?;
        final doc = Session.isDocument;
        return RefreshIndicator(
          onRefresh: reload,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 96),
            children: [
              _QuickCreate(onTap: () => openCreateOrder(context)),
              const SizedBox(height: 12),
              Panel(
                title: 'Today',
                child: Row(
                  children: [
                    _Mini(label: 'Booked', value: count(today['created'])),
                    _Mini(label: 'Picked up', value: count(today['pickedUp'])),
                    _Mini(label: 'Delivered', value: count(today['delivered'])),
                    _Mini(label: 'Completion', value: today['completionRate'] == null ? '—' : '${toNum(today['completionRate']).round()}%'),
                  ],
                ),
              ),
              TilePairs(
                tiles: [
                  StatTile(
                    label: 'Waiting for pickup',
                    value: count(toNum(p['awaitingPickup']) + toNum(p['awaitingDropOff'])),
                    icon: Icons.schedule,
                    color: warn,
                    onTap: () => widget.onShowOrders('pending'),
                  ),
                  StatTile(label: 'In transit', value: count(p['inTransit']), icon: Icons.local_shipping_outlined, onTap: () => widget.onShowOrders('transit')),
                  StatTile(label: 'Delivered', value: count(p['delivered']), icon: Icons.check_circle_outline, color: good, onTap: () => widget.onShowOrders('delivered')),
                  StatTile(label: 'Needs attention', value: count(p['needsAttention']), icon: Icons.error_outline, color: bad, onTap: () => widget.onShowOrders('issue')),
                  StatTile(label: 'Returned', value: count(p['returned']), icon: Icons.undo, color: bad, onTap: () => widget.onShowOrders('returns')),
                  StatTile(label: 'All orders', value: count(p['total']), icon: Icons.inventory_2_outlined, onTap: () => widget.onShowOrders('all')),
                ],
              ),
              const SizedBox(height: 12),
              Panel(
                title: 'This month',
                child: Column(
                  children: [
                    KeyValue('Orders booked', count(month['created'])),
                    KeyValue('Delivered', count(month['delivered'])),
                    KeyValue('Returned', count(month['returned'])),
                    KeyValue('Delivery success', month['deliverySuccessRate'] == null ? '—' : '${toNum(month['deliverySuccessRate']).round()}%'),
                    if (!doc) KeyValue('Cash on delivery (COD)', taka(month['codValue'])),
                    KeyValue('Delivery charges', taka(month['deliveryCharges'])),
                  ],
                ),
              ),
              if (account != null) _AccountSummary(account: account, onOpen: () => widget.onOpenTab(3)),
              _Series(series: s['series'] as Map<String, dynamic>?),
            ],
          ),
        );
      },
    );
  }
}

class _QuickCreate extends StatelessWidget {
  const _QuickCreate({required this.onTap});
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    return Material(
      color: brand,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(color: Colors.white.withValues(alpha: .18), borderRadius: BorderRadius.circular(10)),
                child: const Text(
                  'AI',
                  style: TextStyle(color: Colors.white, fontWeight: FontWeight.w900),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      Session.isDocument ? 'Book a consignment' : 'Create an order',
                      style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 16),
                    ),
                    const Text("Paste the customer's message and we fill the form", style: TextStyle(color: Color(0xFFDDE5FF), fontSize: 12.5)),
                  ],
                ),
              ),
              const Icon(Icons.arrow_forward, color: Colors.white),
            ],
          ),
        ),
      ),
    );
  }
}

class _Mini extends StatelessWidget {
  const _Mini({required this.label, required this.value});
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) => Expanded(
    child: Column(
      children: [
        Text(
          value,
          style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: ink),
        ),
        const SizedBox(height: 2),
        Text(label, style: const TextStyle(fontSize: 12, color: muted)),
      ],
    ),
  );
}

class _AccountSummary extends StatelessWidget {
  const _AccountSummary({required this.account, required this.onOpen});
  final Map<String, dynamic> account;
  final VoidCallback onOpen;
  @override
  Widget build(BuildContext context) {
    final cod = account['cod'] as Map?;
    final fin = account['financial'] as Map?;
    return Panel(
      title: cod != null ? 'Your money' : 'Your bills',
      trailing: TextButton(onPressed: onOpen, child: const Text('Open')),
      child: Column(
        children: [
          if (cod != null) ...[
            KeyValue('Ready to be paid', taka(cod['ready']), bold: true, color: good),
            KeyValue('Being paid', taka(cod['inSettlement'])),
            KeyValue('COD on the way to us', taka(toNum(cod['withRider']) + toNum(cod['atHubs']) + toNum(cod['atCentral']))),
            KeyValue('Paid this month', taka(cod['paidThisMonth'])),
          ],
          if (fin != null) ...[
            KeyValue('Due', taka(fin['due']), bold: true, color: toNum(fin['due']) > 0 ? bad : good),
            KeyValue('Unpaid bills', '${count((fin['unpaidBills'] as Map?)?['count'])} · ${taka((fin['unpaidBills'] as Map?)?['amount'])}'),
            KeyValue('Not billed yet', taka(fin['notBilled'])),
            KeyValue('Paid this month', taka(fin['paidThisMonth'])),
          ],
        ],
      ),
    );
  }
}

/// Orders booked per day, the last 7 days.
class _Series extends StatelessWidget {
  const _Series({required this.series});
  final Map<String, dynamic>? series;
  @override
  Widget build(BuildContext context) {
    final labels = (series?['labels'] as List?)?.cast<Object?>() ?? [];
    final values = ((series?['current'] as List?) ?? []).map(toNum).toList();
    if (labels.isEmpty || values.isEmpty) return const SizedBox.shrink();
    final top = values.fold<num>(0, (a, b) => b > a ? b : a);
    return Panel(
      title: 'Orders, last 7 days',
      child: SizedBox(
        height: 130,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            for (var i = 0; i < values.length && i < labels.length; i++)
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    Text(count(values[i]), style: const TextStyle(fontSize: 11, color: muted)),
                    const SizedBox(height: 3),
                    Container(
                      height: top == 0 ? 3 : 3 + 82 * values[i] / top,
                      margin: const EdgeInsets.symmetric(horizontal: 5),
                      decoration: BoxDecoration(
                        color: brand.withValues(alpha: i == values.length - 1 ? 1 : .55),
                        borderRadius: BorderRadius.circular(5),
                      ),
                    ),
                    const SizedBox(height: 5),
                    Text('${labels[i]}'.replaceFirst(RegExp(r'^\w+ '), ''), style: const TextStyle(fontSize: 11, color: muted)),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
