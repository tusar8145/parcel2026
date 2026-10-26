import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';

import 'api.dart';

// The classic FCM registration token (getToken / onTokenRefresh / deleteToken) is what the server's FCM HTTP v1
// "token" target takes. firebase_messaging 17 deprecates it for the new installation-ID "direct send"; switch
// together with the server (push.service.ts) when that is the documented way.
// ignore_for_file: deprecated_member_use
import 'widgets.dart';

/// Push notifications (Firebase Cloud Messaging). The server sends the user's notifications to every phone
/// registered here; a closed or background app shows them in the phone's notification shade, an open app as
/// a banner. Without Firebase (no Google Play services, tests), the app works without pushes.
class Push {
  static bool _ready = false;
  static String? _app;
  static String? _token;
  static StreamSubscription<String>? _refresh;

  /// What the app does with a notification's data (open the parcel, the task list…).
  static void Function(Map<String, dynamic> data)? onOpen;

  /// A notification arrived while the app is open (reload lists, counts).
  static void Function(RemoteMessage message)? onReceive;

  /// Starts Firebase; call before runApp.
  static Future<void> init(FirebaseOptions options) async {
    try {
      await Firebase.initializeApp(options: options);
      _ready = true;
      FirebaseMessaging.onMessage.listen(_foreground);
      FirebaseMessaging.onMessageOpenedApp.listen((m) => onOpen?.call(m.data));
    } catch (_) {
      _ready = false;
    }
  }

  /// After sign-in: asks to show notifications, registers this phone for the signed-in user, and opens the
  /// notification the app was started from (tapped while the app was closed).
  static Future<void> register(String app) async {
    if (!_ready) return;
    _app = app;
    try {
      final m = FirebaseMessaging.instance;
      await m.requestPermission();
      final token = await m.getToken();
      if (token != null) await _send(token);
      _refresh ??= m.onTokenRefresh.listen(_send);
      final initial = await m.getInitialMessage();
      if (initial != null) onOpen?.call(initial.data);
    } catch (_) {
      // No push this time (offline, no Play services); the next start tries again.
    }
  }

  static Future<void> _send(String token) async {
    _token = token;
    await Api.post('/me/push-devices', {'token': token, 'app': _app ?? 'merchant', 'platform': 'android'});
  }

  /// Before signing out: this phone stops getting the user's notifications.
  static Future<void> unregister() async {
    if (!_ready) return;
    try {
      final token = _token ?? await FirebaseMessaging.instance.getToken();
      if (token != null) await Api.post('/me/push-devices/remove', {'token': token});
      await FirebaseMessaging.instance.deleteToken();
    } catch (_) {}
    _token = null;
    await _refresh?.cancel();
    _refresh = null;
  }

  static void _foreground(RemoteMessage m) {
    onReceive?.call(m);
    final context = navigatorKey.currentContext;
    final n = m.notification;
    if (context == null || n == null) return;
    final messenger = ScaffoldMessenger.maybeOf(context);
    messenger
      ?..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          behavior: SnackBarBehavior.floating,
          duration: const Duration(seconds: 6),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(n.title ?? '', style: const TextStyle(fontWeight: FontWeight.w800)),
              if ((n.body ?? '').isNotEmpty) Text(n.body!, maxLines: 3, overflow: TextOverflow.ellipsis),
            ],
          ),
          action: onOpen == null ? null : SnackBarAction(label: 'Open', textColor: const Color(0xFFF2B705), onPressed: () => onOpen?.call(m.data)),
        ),
      );
  }
}

// ───────────── the user's notifications (bell) ─────────────

/// Unread notifications (the bell's badge).
final unreadCount = ValueNotifier<int>(0);

Future<void> refreshUnread() async {
  try {
    final r = await Api.get('/me/notifications/count');
    unreadCount.value = toNum(r['unread']).toInt();
  } catch (_) {}
}

/// The bell on the app bar: unread badge; opens the notifications list.
class NotificationBell extends StatelessWidget {
  const NotificationBell({super.key, required this.onOpen});
  final Future<void> Function(BuildContext context, Map<String, dynamic> notification) onOpen;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<int>(
      valueListenable: unreadCount,
      builder: (context, n, _) => IconButton(
        tooltip: 'Notifications',
        onPressed: () async {
          await Navigator.of(context).push(MaterialPageRoute(builder: (_) => NotificationsPage(onOpen: onOpen)));
          refreshUnread();
        },
        icon: Badge(isLabelVisible: n > 0, label: Text(n > 99 ? '99+' : '$n'), child: const Icon(Icons.notifications_outlined)),
      ),
    );
  }
}

/// Marks a notification read (when it's opened from the list or from a push).
Future<void> markNotificationRead(String? id) async {
  if (id == null || id.isEmpty) return;
  try {
    final r = await Api.post('/me/notifications/$id/read', {});
    if (r['unread'] != null) unreadCount.value = toNum(r['unread']).toInt();
  } catch (_) {}
}

/// The user's notifications, newest first: unread ones marked; opening one marks it read and [onOpen] shows it.
class NotificationsPage extends StatefulWidget {
  const NotificationsPage({super.key, required this.onOpen});
  final Future<void> Function(BuildContext context, Map<String, dynamic> notification) onOpen;
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

  Future<void> _open(Map<String, dynamic> n) async {
    if (n['readAt'] == null) {
      setState(() => n['readAt'] = DateTime.now().toUtc().toIso8601String());
      if (unreadCount.value > 0) unreadCount.value--;
      markNotificationRead('${n['id']}');
    }
    await widget.onOpen(context, n);
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
              final type = '${n['type']}';
              return Material(
                color: unread ? const Color(0xFFF0F4FF) : Colors.white,
                child: ListTile(
                  onTap: () => _open(n),
                  leading: CircleAvatar(
                    backgroundColor: brand.withValues(alpha: .1),
                    child: Icon(
                      type == 'broadcast'
                          ? Icons.campaign_outlined
                          : type.startsWith('account')
                          ? Icons.account_balance_wallet_outlined
                          : type.startsWith('support')
                          ? Icons.support_agent
                          : Icons.inventory_2_outlined,
                      color: brand,
                      size: 20,
                    ),
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

/// A support request number (DF-SUP-…) or a parcel tracking ID in a notification's text or link.
String? ticketIn(Map<String, dynamic> n) => RegExp(r'\bDF-SUP-\d{6}-\d+\b').firstMatch('${n['title']} ${n['body']} ${n['link']}')?.group(0);
String? trackingIdIn(Map<String, dynamic> n) {
  final text = '${n['title']} ${n['body']} ${n['link']}'.replaceAll(RegExp(r'\bDF-SUP-\d{6}-\d+\b'), '');
  return RegExp(r'\b[A-Z]{2,4}-\d{6}-[0-9A-Z]{4,8}\b').firstMatch(text)?.group(0);
}
