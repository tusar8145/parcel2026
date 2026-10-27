import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'assign.dart';
import 'home.dart';
import 'ops.dart';
import 'parcels.dart';

/// More: assign riders, problems, find a parcel, hub, support, password, sign out.
class MorePage extends StatelessWidget {
  const MorePage({super.key});

  Widget _item(BuildContext context, IconData icon, String title, String subtitle, VoidCallback onTap) => Panel(
    padding: EdgeInsets.zero,
    child: ListTile(
      leading: Icon(icon, color: brand),
      title: Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
      subtitle: Text(subtitle),
      trailing: const Icon(Icons.chevron_right),
      onTap: onTap,
    ),
  );

  void _open(BuildContext context, Widget page) => Navigator.of(context).push(MaterialPageRoute(builder: (_) => page));

  @override
  Widget build(BuildContext context) {
    final user = Session.user ?? {};
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Panel(
          child: Row(
            children: [
              CircleAvatar(
                radius: 26,
                backgroundColor: brand,
                child: Text(
                  Session.name.trim().isEmpty ? 'D' : Session.name.trim().characters.first.toUpperCase(),
                  style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w800),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(Session.name, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
                    Text(((user['roles'] as List?) ?? []).map((r) => humanize('$r')).join(', '), style: const TextStyle(color: muted)),
                    ValueListenableBuilder<Map<String, dynamic>?>(
                      valueListenable: Ops.hub,
                      builder: (_, _, _) => Text('Hub: ${Ops.hubName}', style: const TextStyle(color: muted)),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        if (Ops.allowed('dispatch')) ...[
          _item(context, Icons.fiber_new_outlined, 'Assign pickup riders', 'New orders and pickup requests', () => _open(context, const AssignPage(mode: AssignMode.pickup))),
          _item(context, Icons.person_search_outlined, 'Assign delivery riders', 'Parcels at the hub waiting for a rider', () => _open(context, const AssignPage(mode: AssignMode.delivery))),
        ],
        _item(context, Icons.error_outline, 'Problems', 'Exceptions, failed deliveries, needs info, late-risk', () => _open(context, const ProblemsPage())),
        _item(context, Icons.search, 'Find a parcel', 'Scan or type the tracking ID', () => findParcel(context)),
        _item(context, Icons.warehouse_outlined, 'Change hub', 'The hub this phone works at', () => pickHub(context).then((ok) => ok ? opsChanged.value++ : null)),
        _item(context, Icons.support_agent, 'Help & support', Branding.name.isEmpty ? 'Ask our team' : 'Ask the ${Branding.name} team', () => _open(context, const SupportPage())),
        _item(context, Icons.lock_reset, 'Change password', 'Use a new password to sign in', () => _open(context, const ChangePasswordPage())),
        const SizedBox(height: 6),
        OutlinedButton.icon(
          style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(46), foregroundColor: bad),
          onPressed: () async {
            if (!await confirm(context, title: 'Sign out?', message: 'You will need your password to sign in again.', yes: 'Sign out')) return;
            await Push.unregister();
            await Session.logout();
            Ops.reset();
            openSignIn();
          },
          icon: const Icon(Icons.logout),
          label: const Text('Sign out'),
        ),
        const SizedBox(height: 10),
        Text(
          '${[Branding.name, AppConfig.appName].where((s) => s.isNotEmpty).join(' ')} ${AppConfig.version} · ${Uri.parse(apiBase).host}',
          textAlign: TextAlign.center,
          style: const TextStyle(color: Color(0xFF98A2B3), fontSize: 12),
        ),
      ],
    );
  }
}
