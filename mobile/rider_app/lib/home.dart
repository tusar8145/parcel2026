import 'dart:async';

import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'account.dart';
import 'cash.dart';
import 'deliveries.dart';
import 'offline.dart';
import 'pickups.dart';
import 'returns.dart';
import 'scan.dart';

/// The rider's tasks (GET /rider/tasks: pickups, deliveries, parcels carried), shared by the tabs and
/// reloaded after every action and when the outbox has sent what was saved offline.
class Tasks {
  static final data = ValueNotifier<Map<String, dynamic>?>(null);
  static final error = ValueNotifier<String?>(null);
  static Future<void>? _loading;

  static Future<void> load() => _loading ??= _load().whenComplete(() => _loading = null);

  static Future<void> _load() async {
    try {
      data.value = (await cachedGet('/rider/tasks') as Map).cast<String, dynamic>();
      error.value = null;
    } catch (e) {
      error.value = errorText(e);
    }
  }

  static List<Map<String, dynamic>> list(String key) => ((data.value?[key] as List?) ?? []).cast<Map<String, dynamic>>();
}

/// The shell, so a tapped push can switch tabs.
final riderShell = GlobalKey<RiderShellState>();

/// Opens what a notification is about: new pickups / deliveries their tab, a return run the returns, a support
/// reply its request; a message from the company shows its full text.
Future<void> openRiderNotification(BuildContext context, Map<String, dynamic> n) async {
  final link = '${n['link'] ?? ''}';
  final type = '${n['type'] ?? ''}';
  final ticket = ticketIn(n);
  if (ticket != null) {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => TicketPage(number: ticket)));
    return;
  }
  void tab(int i) {
    Navigator.of(context).popUntil((r) => r.isFirst);
    riderShell.currentState?.openTab(i);
    Tasks.load();
  }

  // About one parcel (e.g. "New pickup: PP-…"): open it — its delivery, or its pickup stop — when it is the rider's.
  final trackingId = trackingIdIn(n);
  if (trackingId != null) {
    await Tasks.load();
    if (!context.mounted) return;
    if (Tasks.list('deliveries').any((p) => p['trackingId'] == trackingId)) {
      await Navigator.of(context).push(MaterialPageRoute(builder: (_) => DeliveryPage(trackingId: trackingId)));
      return;
    }
    final pickup = Tasks.list('pickups').where((p) => p['trackingId'] == trackingId).firstOrNull;
    final stopKey = (pickup?['pickupStop'] as Map?)?['key'];
    if (stopKey != null) {
      await Navigator.of(context).push(MaterialPageRoute(builder: (_) => PickupStopPage(stopKey: '$stopKey')));
      return;
    }
  }

  if (type == 'rider.pickup_assigned' || link.contains('Pickup')) return tab(1);
  if (type == 'rider.delivery_assigned' || link.contains('Deliveries')) return tab(3);
  if (type == 'rider.return_run') {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const ReturnsPage()));
    return;
  }
  if (type.startsWith('cash.')) return openCash(context);
  final title = '${n['title'] ?? ''}';
  if (title.isEmpty) {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const NotificationsPage(onOpen: openRiderNotification)));
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

/// Today, Pickups, Scan, Deliveries, Account.
class RiderShell extends StatefulWidget {
  const RiderShell({super.key});
  @override
  State<RiderShell> createState() => RiderShellState();
}

class RiderShellState extends State<RiderShell> with WidgetsBindingObserver {
  int _tab = 0;

  void openTab(int i) => setState(() => _tab = i);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    Outbox.synced.addListener(Tasks.load);
    Outbox.load().then((_) => Outbox.flush());
    Tasks.load();
    refreshUnread();
    // Pushes: new work reloads the lists; a tapped one opens it.
    Push.onReceive = (_) {
      refreshUnread();
      Tasks.load();
    };
    Push.onOpen = (data) {
      final context = navigatorKey.currentContext;
      if (context == null) return;
      markNotificationRead(data['notificationId'] as String?);
      openRiderNotification(context, data.cast<String, dynamic>());
    };
    Push.register('rider');
    // Back on shift after the app was closed: location sharing starts again.
    cachedGet('/rider/shift')
        .then((s) {
          if (s is Map && s['checkedIn'] == true) Tracker.start();
        })
        .catchError((_) {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      Outbox.flush();
      Tasks.load();
      refreshUnread();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    Outbox.synced.removeListener(Tasks.load);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final rider = Session.rider ?? {};
    final tabs = [TodayPage(onOpenTab: openTab), const PickupsPage(), const ScanPage(), const DeliveriesPage(), const AccountPage()];
    const titles = ['Today', 'Pickups', 'Scan', 'Deliveries', 'Account'];
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 16,
        title: _tab == 0
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    Session.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17),
                  ),
                  Text('Rider ${rider['code'] ?? ''}', style: const TextStyle(fontSize: 12, color: muted)),
                ],
              )
            : Text(titles[_tab], style: const TextStyle(fontWeight: FontWeight.w800)),
        actions: const [
          NotificationBell(onOpen: openRiderNotification),
          SyncButton(),
          SizedBox(width: 6),
        ],
      ),
      body: Column(
        children: [
          const OfflineBar(),
          Expanded(
            child: IndexedStack(index: _tab, children: tabs),
          ),
        ],
      ),
      bottomNavigationBar: ValueListenableBuilder<Map<String, dynamic>?>(
        valueListenable: Tasks.data,
        builder: (context, _, _) {
          final pickups = Tasks.list('pickups').length;
          final deliveries = Tasks.list('deliveries').length;
          return NavigationBar(
            selectedIndex: _tab,
            onDestinationSelected: openTab,
            destinations: [
              const NavigationDestination(icon: Icon(Icons.today_outlined), selectedIcon: Icon(Icons.today), label: 'Today'),
              NavigationDestination(
                icon: Badge(isLabelVisible: pickups > 0, label: Text('$pickups'), child: const Icon(Icons.storefront_outlined)),
                selectedIcon: const Icon(Icons.storefront),
                label: 'Pickups',
              ),
              const NavigationDestination(icon: Icon(Icons.qr_code_scanner), label: 'Scan'),
              NavigationDestination(
                icon: Badge(isLabelVisible: deliveries > 0, label: Text('$deliveries'), child: const Icon(Icons.local_shipping_outlined)),
                selectedIcon: const Icon(Icons.local_shipping),
                label: 'Deliveries',
              ),
              const NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: 'Account'),
            ],
          );
        },
      ),
    );
  }
}

/// My cash, opened from Today and Account.
void openCash(BuildContext context) => Navigator.of(context).push(
  MaterialPageRoute(
    builder: (_) => Scaffold(
      appBar: AppBar(
        title: const Text('My cash', style: TextStyle(fontWeight: FontWeight.w800)),
      ),
      body: const CashPage(),
    ),
  ),
);

/// "Offline · showing what was saved at 10:42" while the server can't be reached.
class OfflineBar extends StatelessWidget {
  const OfflineBar({super.key});
  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<DateTime?>(
      valueListenable: savedAt,
      builder: (context, at, _) => at == null
          ? const SizedBox.shrink()
          : Container(
              width: double.infinity,
              color: const Color(0xFFFFF4E5),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
              child: Text('Offline · showing what was saved at ${dateTimeText(at)}. Your work is saved and sent when you are online.', style: const TextStyle(color: warn, fontSize: 12.5)),
            ),
    );
  }
}

/// The outbox on the app bar: how many actions wait to be sent (red when one was refused).
class SyncButton extends StatelessWidget {
  const SyncButton({super.key});
  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<List<Pending>>(
      valueListenable: Outbox.items,
      builder: (context, items, _) {
        final refused = items.where((p) => p.error != null).length;
        final waiting = items.length - refused;
        return IconButton(
          tooltip: 'Saved actions',
          onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const OutboxPage())),
          icon: Badge(
            isLabelVisible: items.isNotEmpty,
            backgroundColor: refused > 0 ? bad : warn,
            label: Text('${items.length}'),
            child: Icon(waiting > 0 ? Icons.cloud_upload_outlined : (refused > 0 ? Icons.cloud_off_outlined : Icons.cloud_done_outlined)),
          ),
        );
      },
    );
  }
}

/// Actions saved on the phone: waiting ones (sent in order when online) and refused ones to review.
class OutboxPage extends StatelessWidget {
  const OutboxPage({super.key});
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Saved actions', style: TextStyle(fontWeight: FontWeight.w800)),
        actions: [TextButton(onPressed: () => Outbox.flush(), child: const Text('Send now'))],
      ),
      body: ValueListenableBuilder<List<Pending>>(
        valueListenable: Outbox.items,
        builder: (context, items, _) => ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const Panel(
              child: Text('Work you do without a connection is saved here and sent by itself, in order, when the phone is online again.', style: TextStyle(color: muted)),
            ),
            if (items.isEmpty) const EmptyView(icon: Icons.cloud_done_outlined, text: 'Everything is sent.'),
            for (final p in items)
              Panel(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(p.trackingId, style: const TextStyle(fontWeight: FontWeight.w800)),
                        ),
                        StatusChip(p.error == null ? 'PENDING' : 'REJECTED', label: p.error == null ? 'Waiting' : 'Refused'),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(p.label),
                    Text('Saved ${dateTimeText(p.createdAt)}', style: const TextStyle(color: muted, fontSize: 12.5)),
                    if (p.error != null) ...[
                      const SizedBox(height: 6),
                      Text(p.error!, style: const TextStyle(color: bad)),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          TextButton(
                            onPressed: () async {
                              if (await confirm(context, title: 'Remove this action?', message: 'It will not be sent. Do it again from the parcel if needed.', yes: 'Remove', danger: true)) {
                                await Outbox.remove(p);
                              }
                            },
                            child: const Text('Remove'),
                          ),
                          FilledButton.tonal(onPressed: () => Outbox.retry(p), child: const Text('Send again')),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// Today: shift and location, today's work, cash in hand, return runs.
class TodayPage extends StatefulWidget {
  const TodayPage({super.key, required this.onOpenTab});
  final void Function(int tab) onOpenTab;
  @override
  State<TodayPage> createState() => _TodayPageState();
}

class _TodayPageState extends State<TodayPage> {
  Map<String, dynamic>? _summary;
  Map<String, dynamic>? _shift;
  List<Map<String, dynamic>> _runs = [];
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    Outbox.synced.addListener(_load);
    _load();
  }

  @override
  void dispose() {
    Outbox.synced.removeListener(_load);
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await Future.wait([cachedGet('/rider/summary'), cachedGet('/rider/shift'), cachedGet('/rider/return-runs').catchError((_) => <String, dynamic>{})]);
      if (!mounted) return;
      setState(() {
        _summary = (r[0] as Map).cast<String, dynamic>();
        _shift = (r[1] as Map).cast<String, dynamic>();
        _runs = (((r[2] as Map?)?['items'] as List?) ?? []).cast<Map<String, dynamic>>();
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
    await Tasks.load();
  }

  Future<void> _toggleShift() async {
    final on = _shift?['checkedIn'] == true;
    if (on && !await confirm(context, title: 'End your shift?', message: 'Location sharing stops and you go offline.', yes: 'End shift')) return;
    setState(() => _busy = true);
    try {
      if (!on) await Tracker.permission();
      final pos = await Tracker.current();
      await Api.post('/rider/shift/${on ? 'check-out' : 'check-in'}', {if (pos != null) 'lat': pos.latitude, if (pos != null) 'lng': pos.longitude});
      if (on) {
        await Tracker.stop();
      } else {
        await Tracker.start();
      }
      await _load();
      if (mounted) snack(context, on ? 'Shift ended.' : 'Shift started. Have a safe ride!');
    } catch (e) {
      if (mounted) snack(context, errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _setBreak(bool onBreak) async {
    try {
      await Api.patch('/rider/me/status', {'status': onBreak ? 'ON_BREAK' : 'ONLINE'});
      await _load();
    } catch (e) {
      if (mounted) snack(context, errorText(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_summary == null && _error != null) return ErrorView(message: _error!, onRetry: _load);
    if (_summary == null) return const Center(child: CircularProgressIndicator());
    final s = _summary!;
    final today = (s['today'] as Map?) ?? {};
    final month = (s['month'] as Map?) ?? {};
    final cash = (s['cash'] as Map?) ?? {};
    final riderStatus = '${(s['rider'] as Map?)?['status'] ?? ''}';
    final on = _shift?['checkedIn'] == true;
    final since = (_shift?['current'] as Map?)?['checkInAt'];
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
        children: [
          Panel(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Icon(on ? Icons.circle : Icons.circle_outlined, color: on ? good : muted, size: 14),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        on ? (riderStatus == 'ON_BREAK' ? 'On a break' : 'On shift since ${dateTimeText(since)}') : 'Off shift',
                        style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                ValueListenableBuilder<String>(
                  valueListenable: Tracker.status,
                  builder: (_, t, _) => Text(t, style: const TextStyle(color: muted, fontSize: 12.5)),
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: on
                          ? OutlinedButton.icon(
                              onPressed: _busy ? null : _toggleShift,
                              style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(46), foregroundColor: bad),
                              icon: const Icon(Icons.logout),
                              label: const Text('End shift'),
                            )
                          : BusyButton(label: 'Start shift', busy: _busy, onPressed: _toggleShift, icon: Icons.play_arrow),
                    ),
                    if (on) ...[
                      const SizedBox(width: 10),
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: () => _setBreak(riderStatus != 'ON_BREAK'),
                          style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(46)),
                          icon: Icon(riderStatus == 'ON_BREAK' ? Icons.play_arrow : Icons.free_breakfast_outlined),
                          label: Text(riderStatus == 'ON_BREAK' ? 'Back to work' : 'Take a break'),
                        ),
                      ),
                    ],
                  ],
                ),
              ],
            ),
          ),
          ValueListenableBuilder<Map<String, dynamic>?>(
            valueListenable: Tasks.data,
            builder: (context, _, _) => TilePairs(
              tiles: [
                StatTile(label: 'Pickups to do', value: count(Tasks.list('pickups').length), icon: Icons.storefront_outlined, color: warn, onTap: () => widget.onOpenTab(1)),
                StatTile(label: 'Deliveries to do', value: count(Tasks.list('deliveries').length), icon: Icons.local_shipping_outlined, onTap: () => widget.onOpenTab(3)),
                StatTile(label: 'Carrying (to hand over)', value: count(Tasks.list('carrying').length), icon: Icons.inventory_2_outlined, onTap: () => widget.onOpenTab(1)),
                StatTile(label: 'Cash in hand', value: taka(cash['inHand']), icon: Icons.payments_outlined, color: good, onTap: () => openCash(context)),
              ],
            ),
          ),
          if (_runs.isNotEmpty)
            Panel(
              padding: EdgeInsets.zero,
              child: ListTile(
                leading: const Icon(Icons.undo, color: bad),
                title: Text('${_runs.length} return run(s) to merchants', style: const TextStyle(fontWeight: FontWeight.w700)),
                subtitle: Text('${_runs.fold<int>(0, (a, r) => a + ((r['parcels'] as List?)?.length ?? 0))} parcel(s) to give back'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () async {
                  await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const ReturnsPage()));
                  _load();
                },
              ),
            ),
          Panel(
            title: 'Today',
            child: Column(
              children: [
                KeyValue('Delivered', count(today['delivered'])),
                KeyValue('Failed attempts', count(today['failed'])),
                KeyValue('Pickups completed', count(today['pickupsCompleted'])),
                KeyValue('COD still to collect', taka(today['codToCollect'])),
              ],
            ),
          ),
          Panel(
            title: 'This month',
            child: Column(
              children: [
                KeyValue('Delivered', count(month['delivered'])),
                KeyValue('Success rate', month['successRate'] == null ? '—' : '${toNum(month['successRate']).round()}%'),
                KeyValue('On time', month['onTimeRate'] == null ? '—' : '${toNum(month['onTimeRate']).round()}%'),
                KeyValue('On-time streak', count(s['onTimeStreak'])),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
