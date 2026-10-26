import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'home.dart';
import 'main.dart';
import 'offline.dart';
import 'returns.dart';

/// Account: the rider's profile and hub, location sharing, saved actions, returns, support, password, sign out.
class AccountPage extends StatelessWidget {
  const AccountPage({super.key});

  Future<void> _signOut(BuildContext context) async {
    final waiting = Outbox.items.value.length;
    final ok = await confirm(
      context,
      title: 'Sign out?',
      message: waiting > 0 ? '$waiting saved action(s) have not been sent yet and will be lost. Connect to the internet first to send them.' : 'You will need your password to sign in again.',
      yes: 'Sign out',
      danger: waiting > 0,
    );
    if (!ok) return;
    await riderSignOut();
    if (context.mounted) openSignIn();
  }

  Widget _tile(BuildContext context, IconData icon, String title, String subtitle, Widget page) => Panel(
    padding: EdgeInsets.zero,
    child: ListTile(
      leading: Icon(icon, color: brand),
      title: Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
      subtitle: Text(subtitle),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => page)),
    ),
  );

  @override
  Widget build(BuildContext context) {
    return Loader<Map<String, dynamic>>(
      load: () async => (await cachedGet('/rider/me') as Map).cast<String, dynamic>(),
      builder: (context, r, reload) {
        final hub = r['hub'] as Map?;
        return RefreshIndicator(
          onRefresh: reload,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Panel(
                child: Row(
                  children: [
                    CircleAvatar(
                      radius: 28,
                      backgroundColor: brand,
                      child: Text(
                        '${r['name'] ?? 'R'}'.trim().characters.first.toUpperCase(),
                        style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w800),
                      ),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('${r['name'] ?? ''}', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
                          Text('${r['code'] ?? ''} · ${humanize('${r['vehicle'] ?? ''}')}', style: const TextStyle(color: muted)),
                          Text(phoneText(r['phone']), style: const TextStyle(color: muted)),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              Panel(
                child: Column(
                  children: [
                    KeyValue('Hub', '${hub?['name'] ?? '—'}'),
                    KeyValue('Zone', '${r['zone'] ?? '—'}'),
                    KeyValue('Status', humanize('${r['status'] ?? ''}')),
                    ValueListenableBuilder<String>(valueListenable: Tracker.status, builder: (_, s, _) => KeyValue('Location', s)),
                  ],
                ),
              ),
              Panel(
                padding: EdgeInsets.zero,
                child: ListTile(
                  leading: const Icon(Icons.payments_outlined, color: brand),
                  title: const Text('My cash', style: TextStyle(fontWeight: FontWeight.w700)),
                  subtitle: const Text('COD with you and the handover slip'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => openCash(context),
                ),
              ),
              _tile(context, Icons.cloud_upload_outlined, 'Saved actions', 'Work saved on the phone, waiting to be sent', const OutboxPage()),
              _tile(context, Icons.undo, 'Returns to merchants', 'Return runs assigned to you', const ReturnsPage()),
              _tile(context, Icons.support_agent, 'Help & support', 'Ask about a parcel, cash, pay or safety', const SupportPage()),
              _tile(context, Icons.lock_reset, 'Change password', 'Use a new password to sign in', const ChangePasswordPage()),
              const SizedBox(height: 6),
              OutlinedButton.icon(
                style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(46), foregroundColor: bad),
                onPressed: () => _signOut(context),
                icon: const Icon(Icons.logout),
                label: const Text('Sign out'),
              ),
              const SizedBox(height: 10),
              Text(
                '${AppConfig.appName} ${AppConfig.version} · ${Uri.parse(apiBase).host}',
                textAlign: TextAlign.center,
                style: const TextStyle(color: Color(0xFF98A2B3), fontSize: 12),
              ),
            ],
          ),
        );
      },
    );
  }
}
