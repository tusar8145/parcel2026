import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'ops.dart';

/// Calls a number with the phone's dialer (+880… numbers are dialled as 01…).
Future<void> callPhone(BuildContext context, String phone) async {
  final number = phone.replaceFirst(RegExp(r'^\+?880'), '0');
  if (!await launchUrl(Uri(scheme: 'tel', path: number)) && context.mounted) snack(context, 'Could not open the dialer. Call $number.');
}

/// "Find a parcel": scan the label (or type the ID) and open its details.
Future<void> findParcel(BuildContext context) async {
  final code = await scanBarcode(
    context,
    title: 'Find a parcel',
    hint: 'Scan the label, or type the tracking ID.',
    onCode: (code, _) async {
      try {
        await Api.get('/parcels/${Uri.encodeComponent(code)}');
        return ScanFeedback(true, code);
      } on ApiError catch (e) {
        return ScanFeedback(false, e.status == 404 ? 'No parcel found for $code.' : e.message);
      }
    },
  );
  if (code == null || !context.mounted) return;
  Navigator.of(context).push(MaterialPageRoute(builder: (_) => ParcelPage(trackingId: code)));
}

/// One parcel: status, where it is and who has it, recipient / sender (call), cash, the full tracking history.
class ParcelPage extends StatelessWidget {
  const ParcelPage({super.key, required this.trackingId});
  final String trackingId;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(trackingId, style: const TextStyle(fontWeight: FontWeight.w800)),
      ),
      body: Loader<Map<String, dynamic>>(
        load: () async => (await Api.get('/parcels/${Uri.encodeComponent(trackingId)}') as Map).cast<String, dynamic>(),
        builder: (context, p, reload) {
          final r = (p['recipient'] as Map?) ?? {};
          final s = (p['sender'] as Map?) ?? {};
          final d = (p['delivery'] as Map?) ?? {};
          final hub = p['currentHub'] as Map?;
          final events = ((p['events'] as List?) ?? []).cast<Map<String, dynamic>>().reversed.toList();
          final status = '${p['status']}';
          final cod = toNum(p['codAmount']);
          Widget person(String label, Map m) => Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(label, style: const TextStyle(color: muted, fontSize: 12.5)),
                    Text('${m['name'] ?? '—'}', style: const TextStyle(fontWeight: FontWeight.w700)),
                    Text(phoneText(m['phone'])),
                  ],
                ),
              ),
              if (m['phone'] != null) IconButton.filledTonal(onPressed: () => callPhone(context, '${m['phone']}'), icon: const Icon(Icons.call)),
            ],
          );
          return RefreshIndicator(
            onRefresh: reload,
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Panel(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      StatusChip(status, label: '${p['statusLabel'] ?? humanize(status)}'),
                      const SizedBox(height: 8),
                      if (hub != null) KeyValue('At hub', '${hub['name']}'),
                      if ((p['pickupRider'] as Map?)?['label'] != null) KeyValue('Pickup rider', '${(p['pickupRider'] as Map)['label']}'),
                      if ((p['deliveryRider'] as Map?)?['label'] != null) KeyValue('Delivery rider', '${(p['deliveryRider'] as Map)['label']}'),
                      KeyValue('Cash to collect', cod > 0 ? taka(cod) : 'None', bold: cod > 0, color: cod > 0 ? good : muted),
                      if ((p['cod'] as Map?)?['state'] != null) KeyValue('COD', humanize('${(p['cod'] as Map)['state']}')),
                      KeyValue('Booked', dateTimeText(p['createdAt'])),
                    ],
                  ),
                ),
                Panel(child: person('Recipient', r)),
                Panel(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('${d['street'] ?? ''}'),
                      Text([d['area'], d['zone'], d['district']].where((x) => x != null && '$x'.isNotEmpty).join(' · '), style: const TextStyle(color: muted, fontSize: 12.5)),
                    ],
                  ),
                ),
                Panel(child: person('Sender${(p['merchant'] as Map?)?['name'] != null ? ' · ${(p['merchant'] as Map)['name']}' : ''}', s)),
                if (['PENDING_CONFIRMATION', 'PICKUP_ASSIGNED', 'PICKUP_CONFIRMED'].contains(status) || ['AT_HUB', 'ASSIGNED', 'RETRY_SCHEDULED'].contains(status))
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: FilledButton.icon(
                      onPressed: () async {
                        final pickup = ['PENDING_CONFIRMATION', 'PICKUP_ASSIGNED', 'PICKUP_CONFIRMED'].contains(status);
                        final rider = await pickRider(context, title: pickup ? 'Pickup rider' : 'Delivery rider', allHubs: pickup && Ops.isManager);
                        if (rider == null || !context.mounted) return;
                        try {
                          await Api.post('/parcels/${Uri.encodeComponent(trackingId)}/assign-${pickup ? 'pickup' : 'delivery'}', {'riderId': rider});
                          if (context.mounted) snack(context, 'Rider assigned.');
                          reload();
                        } on ApiError catch (e) {
                          if (context.mounted) snack(context, e.message);
                        }
                      },
                      style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(46)),
                      icon: const Icon(Icons.person_add_alt),
                      label: Text(['PENDING_CONFIRMATION', 'PICKUP_ASSIGNED', 'PICKUP_CONFIRMED'].contains(status) ? 'Assign pickup rider' : 'Assign delivery rider'),
                    ),
                  ),
                Panel(
                  title: 'Tracking',
                  child: Column(
                    children: [
                      for (final e in events)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 10),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Icon(e['internal'] == true ? Icons.lock_outline : Icons.circle, size: 12, color: e == events.first ? brand : muted),
                              const SizedBox(width: 10),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text('${e['title'] ?? humanize('${e['status']}')}', style: const TextStyle(fontWeight: FontWeight.w700)),
                                    if (e['description'] != null) Text('${e['description']}', style: const TextStyle(color: muted, fontSize: 13)),
                                    Text([dateTimeText(e['at']), if (e['location'] != null) '${e['location']}'].join(' · '), style: const TextStyle(color: Color(0xFF98A2B3), fontSize: 12)),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

/// Parcels at one stage at the hub (GET /parcels?stage=…&forHubIds=…).
class ParcelListPage extends StatelessWidget {
  const ParcelListPage({super.key, required this.title, required this.stage, this.embedded = false});
  final String title;
  final String stage;
  final bool embedded;

  @override
  Widget build(BuildContext context) {
    final list = Loader<List<Map<String, dynamic>>>(
      load: () async => (((await Api.get('/parcels', {'stage': stage, 'forHubIds': Ops.hubId, 'limit': 200}))['items'] as List?) ?? []).cast<Map<String, dynamic>>(),
      builder: (context, items, reload) => RefreshIndicator(
        onRefresh: reload,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(12),
          children: [
            if (items.isEmpty) const EmptyView(icon: Icons.task_alt, text: 'Nothing here.'),
            for (final p in items)
              Panel(
                padding: EdgeInsets.zero,
                child: ListTile(
                  onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ParcelPage(trackingId: '${p['trackingId']}'))),
                  title: Row(
                    children: [
                      Expanded(
                        child: Text('${p['trackingId']}', style: const TextStyle(fontWeight: FontWeight.w800)),
                      ),
                      StatusChip('${p['status']}', label: '${p['statusLabel'] ?? humanize('${p['status']}')}'),
                    ],
                  ),
                  subtitle: Text(
                    '${(p['recipient'] as Map?)?['name'] ?? ''} · ${[(p['delivery'] as Map?)?['area'], (p['delivery'] as Map?)?['zone']].where((x) => x != null).join(', ')}${toNum(p['codAmount']) > 0 ? ' · COD ${taka(p['codAmount'])}' : ''}',
                  ),
                ),
              ),
          ],
        ),
      ),
    );
    if (embedded) return list;
    return Scaffold(
      appBar: AppBar(
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.w800)),
      ),
      body: list,
    );
  }
}

/// Problems at the hub: exceptions, failed deliveries, missing details, late-risk.
class ProblemsPage extends StatelessWidget {
  const ProblemsPage({super.key});

  @override
  Widget build(BuildContext context) {
    const tabs = [('exceptions', 'Exceptions'), ('failed', 'Failed'), ('needs_info', 'Needs info'), ('sla_risk', 'Late-risk')];
    return DefaultTabController(
      length: tabs.length,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Problems', style: TextStyle(fontWeight: FontWeight.w800)),
          bottom: TabBar(isScrollable: true, tabs: [for (final t in tabs) Tab(text: t.$2)]),
        ),
        body: TabBarView(
          children: [for (final t in tabs) ParcelListPage(title: t.$2, stage: t.$1, embedded: true)],
        ),
      ),
    );
  }
}
