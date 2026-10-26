import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'home.dart';
import 'orders.dart';

/// In-app notifications (newest first): unread ones marked; opening one marks it read.
class NotificationsPage extends StatefulWidget {
  const NotificationsPage({super.key});
  @override
  State<NotificationsPage> createState() => _NotificationsPageState();
}

class _NotificationsPageState extends State<NotificationsPage> {
  final List<Map<String, dynamic>> _items = [];
  String? _cursor;
  bool _loading = false;
  bool _done = false;
  String? _error;

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
      final r = await Api.get('/me/notifications', {'limit': 30, 'cursor': _cursor});
      if (!mounted) return;
      setState(() {
        _items.addAll(((r['items'] as List?) ?? []).cast<Map<String, dynamic>>());
        _cursor = r['nextCursor'] as String?;
        _done = _cursor == null;
        if (r['unread'] != null) unreadCount.value = toNum(r['unread']).toInt();
      });
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _readAll() async {
    try {
      await Api.post('/me/notifications/read-all', {});
      final now = DateTime.now().toUtc().toIso8601String();
      setState(() {
        for (final n in _items) {
          n['readAt'] ??= now;
        }
      });
      unreadCount.value = 0;
    } catch (e) {
      if (mounted) snack(context, errorText(e));
    }
  }

  /// A tracking ID in the notification (PP-261025-5PTW8, EC-…): opening it shows the order.
  String? _trackingIdOf(Map<String, dynamic> n) {
    final m = RegExp(r'\b[A-Z]{2,4}-\d{6}-[0-9A-Z]{4,8}\b').firstMatch('${n['title']} ${n['body']} ${n['link']}');
    return m?.group(0);
  }

  Future<void> _open(Map<String, dynamic> n) async {
    if (n['readAt'] == null) {
      setState(() => n['readAt'] = DateTime.now().toUtc().toIso8601String());
      if (unreadCount.value > 0) unreadCount.value--;
      Api.post('/me/notifications/${n['id']}/read', {}).catchError((_) => <String, dynamic>{});
    }
    // A support reply (DF-SUP-…) opens the request; a parcel's tracking ID opens the order.
    final ticket = RegExp(r'\bDF-SUP-\d{6}-\d+\b').firstMatch('${n['title']} ${n['body']} ${n['link']}')?.group(0);
    if (ticket != null) {
      await Navigator.of(context).push(MaterialPageRoute(builder: (_) => TicketPage(number: ticket)));
      return;
    }
    final id = _trackingIdOf(n);
    if (id != null) await Navigator.of(context).push(MaterialPageRoute(builder: (_) => OrderDetailPage(trackingId: id)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Notifications', style: TextStyle(fontWeight: FontWeight.w800)),
        actions: [
          ValueListenableBuilder<int>(
            valueListenable: unreadCount,
            builder: (_, n, _) => n > 0 ? TextButton(onPressed: _readAll, child: const Text('Mark all read')) : const SizedBox.shrink(),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _reload,
        child: NotificationListener<ScrollNotification>(
          onNotification: (s) {
            if (s.metrics.pixels > s.metrics.maxScrollExtent - 300) _more();
            return false;
          },
          child: ListView.builder(
            physics: const AlwaysScrollableScrollPhysics(),
            itemCount: _items.length + 1,
            itemBuilder: (context, i) {
              if (i == _items.length) {
                if (_error != null) return ErrorView(message: _error!, onRetry: _more);
                if (_loading) {
                  return const Padding(
                    padding: EdgeInsets.all(24),
                    child: Center(child: CircularProgressIndicator()),
                  );
                }
                if (_items.isEmpty) return const EmptyView(icon: Icons.notifications_none, text: 'No notifications yet.');
                return const SizedBox(height: 16);
              }
              final n = _items[i];
              final unread = n['readAt'] == null;
              return Material(
                color: unread ? const Color(0xFFF0F4FF) : Colors.white,
                child: ListTile(
                  onTap: () => _open(n),
                  leading: CircleAvatar(
                    backgroundColor: brand.withValues(alpha: .1),
                    child: Icon('${n['type']}'.startsWith('account') ? Icons.account_balance_wallet_outlined : Icons.inventory_2_outlined, color: brand, size: 20),
                  ),
                  title: Text('${n['title'] ?? ''}', style: TextStyle(fontWeight: unread ? FontWeight.w800 : FontWeight.w600)),
                  subtitle: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (n['body'] != null) Text('${n['body']}'),
                      Text(dateTimeText(n['createdAt']), style: const TextStyle(fontSize: 12, color: muted)),
                    ],
                  ),
                  trailing: unread
                      ? Container(
                          width: 9,
                          height: 9,
                          decoration: const BoxDecoration(color: brand, shape: BoxShape.circle),
                        )
                      : null,
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}
