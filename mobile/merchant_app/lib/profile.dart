import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Account: the merchant's details and code, the pickup address and hub, plan and payment account;
/// change password and sign out. Details are changed on the merchant panel.
class ProfilePage extends StatelessWidget {
  const ProfilePage({super.key});

  Future<void> _signOut(BuildContext context) async {
    if (!await confirm(context, title: 'Sign out?', message: 'You will need your password to sign in again.', yes: 'Sign out')) return;
    await Push.unregister();
    await Session.logout();
    if (!context.mounted) return;
    Navigator.of(context).pushAndRemoveUntil(MaterialPageRoute(builder: (_) => const LoginPage()), (_) => false);
  }

  @override
  Widget build(BuildContext context) {
    return Loader<Map<String, dynamic>>(
      load: () async => await Api.get('/merchants/me') as Map<String, dynamic>,
      builder: (context, m, reload) {
        final pickup = (m['pickup'] as Map?) ?? {};
        final hub = m['pickupHub'] as Map?;
        final plan = m['plan'] as Map?;
        final payout = m['payoutAccount'] as Map?;
        final kyc = m['kyc'] as Map?;
        final user = Session.user ?? {};
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
                        '${m['name'] ?? 'M'}'.trim().characters.first.toUpperCase(),
                        style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w800),
                      ),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('${m['name'] ?? ''}', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
                          Text(m['type'] == 'BANKING_FINANCIAL' ? 'Banking & Financial merchant' : 'E-commerce merchant', style: const TextStyle(color: muted)),
                          const SizedBox(height: 6),
                          Row(
                            children: [
                              InkWell(
                                onTap: () {
                                  Clipboard.setData(ClipboardData(text: '${m['code']}'));
                                  snack(context, 'Merchant code copied.');
                                },
                                child: Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                                  decoration: BoxDecoration(color: brand.withValues(alpha: .1), borderRadius: BorderRadius.circular(6)),
                                  child: Text(
                                    '${m['code'] ?? ''}  ⧉',
                                    style: const TextStyle(color: brand, fontWeight: FontWeight.w800),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 8),
                              StatusChip(m['status'] == 'ACTIVE' ? 'DELIVERED' : 'PENDING', label: humanize('${m['status']}')),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              Panel(
                padding: EdgeInsets.zero,
                child: ListTile(
                  leading: const Icon(Icons.support_agent, color: brand),
                  title: const Text('Help & support', style: TextStyle(fontWeight: FontWeight.w700)),
                  subtitle: const Text('Ask about a parcel, a payment or your account'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const SupportPage())),
                ),
              ),
              Panel(
                title: 'Contact',
                child: Column(children: [KeyValue('Name', '${m['contactName'] ?? '—'}'), KeyValue('Phone', phoneText(m['contactPhone'])), KeyValue('Email', '${m['contactEmail'] ?? '—'}')]),
              ),
              Panel(
                title: 'Pickup',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${pickup['street'] ?? m['pickupAddress'] ?? '—'}'),
                    const SizedBox(height: 4),
                    KeyValue('Area', '${pickup['area'] ?? '—'}'),
                    KeyValue('Zone', '${pickup['zone'] ?? '—'}'),
                    KeyValue('District', '${pickup['district'] ?? '—'}'),
                    KeyValue('Contact', '${m['pickupContactName'] ?? ''} ${phoneText(m['pickupContactPhone'])}'),
                    if (hub != null) KeyValue('Pickup hub', '${hub['name']}'),
                  ],
                ),
              ),
              Panel(
                title: 'Plan & payment',
                child: Column(
                  children: [
                    if (plan != null) KeyValue('Plan', '${plan['name']}${toNum(plan['discountPct']) > 0 ? ' · ${plan['discountPct']}% off' : ''}'),
                    if (payout != null) KeyValue('Payment account', '${humanize('${payout['method']}')} · ${payout['account'] ?? ''}'),
                    if (kyc != null) KeyValue('Verification (KYC)', humanize('${kyc['status']}')),
                    KeyValue('Your role', humanize('${m['myRole'] ?? ''}'.replaceFirst('MERCHANT_', ''))),
                  ],
                ),
              ),
              Panel(
                title: 'Sign-in',
                child: Column(
                  children: [
                    KeyValue('Signed in as', '${user['name'] ?? ''}'),
                    if (user['phone'] != null) KeyValue('Phone', phoneText(user['phone'])),
                    if (user['email'] != null) KeyValue('Email', '${user['email']}'),
                    const SizedBox(height: 8),
                    OutlinedButton.icon(
                      style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(46)),
                      onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const ChangePasswordPage())),
                      icon: const Icon(Icons.lock_reset),
                      label: const Text('Change password'),
                    ),
                    const SizedBox(height: 8),
                    OutlinedButton.icon(
                      style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(46), foregroundColor: bad),
                      onPressed: () => _signOut(context),
                      icon: const Icon(Icons.logout),
                      label: const Text('Sign out'),
                    ),
                  ],
                ),
              ),
              const Text(
                'To change these details, use Settings on the merchant panel.',
                textAlign: TextAlign.center,
                style: TextStyle(color: muted, fontSize: 12.5),
              ),
              const SizedBox(height: 4),
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
