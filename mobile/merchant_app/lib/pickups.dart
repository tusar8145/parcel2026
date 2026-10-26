import 'package:flutter/material.dart';

import 'api.dart';
import 'widgets.dart';

/// Pickup requests: the merchant's one-off pickups (and those from recurring schedules); request one, cancel one.
class PickupsPage extends StatefulWidget {
  const PickupsPage({super.key});
  @override
  State<PickupsPage> createState() => _PickupsPageState();
}

class _PickupsPageState extends State<PickupsPage> {
  final _loader = GlobalKey<LoaderState<List<Map<String, dynamic>>>>();

  Future<List<Map<String, dynamic>>> _load() async {
    final r = await Api.get('/merchants/me/pickup-requests', {'limit': 50});
    return ((r['items'] as List?) ?? []).cast<Map<String, dynamic>>();
  }

  Future<void> _new() async {
    final created = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => const PickupRequestPage()));
    if (created == true) _loader.currentState?.reload();
  }

  Future<void> _cancel(Map<String, dynamic> r) async {
    if (!await confirm(context, title: 'Cancel this pickup?', message: '${r['number'] ?? ''} on ${dateText(r['date'])}, ${r['windowStart']}–${r['windowEnd']}.', yes: 'Cancel pickup', danger: true)) {
      return;
    }
    try {
      await Api.post('/merchants/me/pickup-requests/${r['id']}/cancel', {});
      if (!mounted) return;
      snack(context, 'Pickup cancelled.');
      _loader.currentState?.reload();
    } catch (e) {
      if (mounted) snack(context, errorText(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      floatingActionButton: FloatingActionButton.extended(heroTag: 'pickup', onPressed: _new, icon: const Icon(Icons.add), label: const Text('Request pickup')),
      body: Loader<List<Map<String, dynamic>>>(
        key: _loader,
        load: _load,
        builder: (context, items, reload) => RefreshIndicator(
          onRefresh: reload,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 96),
            children: [
              if (items.isEmpty) const EmptyView(icon: Icons.local_shipping_outlined, text: 'No pickup requests yet. Request one and a rider comes to collect your parcels.'),
              for (final r in items)
                Panel(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text('${r['number'] ?? 'Pickup'}', style: const TextStyle(fontWeight: FontWeight.w800)),
                          ),
                          StatusChip(r['status'] as String?),
                        ],
                      ),
                      const SizedBox(height: 6),
                      Text('${dateText(r['date'])} · ${r['windowStart']}–${r['windowEnd']}', style: const TextStyle(fontWeight: FontWeight.w600)),
                      Text('${r['street'] ?? ''}', style: const TextStyle(color: muted)),
                      Text('${r['expectedParcels'] ?? 1} parcel(s) · ${r['contactName'] ?? ''} ${phoneText(r['contactPhone'])}', style: const TextStyle(color: muted, fontSize: 12.5)),
                      if ((r['schedule'] as Map?)?['name'] != null) Text('From schedule: ${(r['schedule'] as Map)['name']}', style: const TextStyle(color: muted, fontSize: 12.5)),
                      if (r['note'] != null) Text('Note: ${r['note']}', style: const TextStyle(color: muted, fontSize: 12.5)),
                      if (r['status'] == 'REQUESTED')
                        Align(
                          alignment: Alignment.centerRight,
                          child: TextButton.icon(
                            onPressed: () => _cancel(r),
                            style: TextButton.styleFrom(foregroundColor: bad),
                            icon: const Icon(Icons.close, size: 18),
                            label: const Text('Cancel'),
                          ),
                        ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A one-off pickup: the day, the time window and how many parcels (the address is the merchant's pickup address).
class PickupRequestPage extends StatefulWidget {
  const PickupRequestPage({super.key});
  @override
  State<PickupRequestPage> createState() => _PickupRequestPageState();
}

class _PickupRequestPageState extends State<PickupRequestPage> {
  late DateTime _date = _firstDay();
  TimeOfDay _start = const TimeOfDay(hour: 10, minute: 0);
  TimeOfDay _end = const TimeOfDay(hour: 13, minute: 0);
  final _parcels = TextEditingController(text: '1');
  final _note = TextEditingController();
  bool _busy = false;
  String? _error;

  /// Today while there is time left for a window, else tomorrow.
  static DateTime _firstDay() {
    final now = DateTime.now();
    final d = DateTime(now.year, now.month, now.day);
    return now.hour >= 17 ? d.add(const Duration(days: 1)) : d;
  }

  String _hhmm(TimeOfDay t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
  int _mins(TimeOfDay t) => t.hour * 60 + t.minute;

  Future<void> _submit() async {
    final n = int.tryParse(_parcels.text.trim());
    if (n == null || n < 1 || n > 5000) return setState(() => _error = 'Enter how many parcels (1 to 5,000).');
    if (_mins(_end) - _mins(_start) < 30) return setState(() => _error = 'The window must end at least 30 minutes after it starts.');
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await Api.post('/merchants/me/pickup-requests', {
        'date': isoDate(_date),
        'windowStart': _hhmm(_start),
        'windowEnd': _hhmm(_end),
        'expectedParcels': n,
        if (_note.text.trim().isNotEmpty) 'note': _note.text.trim(),
      });
      if (!mounted) return;
      snack(context, 'Pickup requested.');
      Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _tile(IconData icon, String label, String value, VoidCallback onTap) => ListTile(
    contentPadding: EdgeInsets.zero,
    leading: Icon(icon, color: brand),
    title: Text(label, style: const TextStyle(color: muted, fontSize: 13)),
    subtitle: Text(
      value,
      style: const TextStyle(color: ink, fontSize: 16, fontWeight: FontWeight.w700),
    ),
    trailing: const Icon(Icons.edit_outlined, size: 18),
    onTap: onTap,
  );

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    return Scaffold(
      appBar: AppBar(
        title: const Text('Request a pickup', style: TextStyle(fontWeight: FontWeight.w800)),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Panel(
            child: Column(
              children: [
                _tile(Icons.event, 'Day', dateText(_date), () async {
                  final d = await showDatePicker(context: context, initialDate: _date, firstDate: DateTime(now.year, now.month, now.day), lastDate: now.add(const Duration(days: 30)));
                  if (d != null) setState(() => _date = d);
                }),
                _tile(Icons.schedule, 'From', _start.format(context), () async {
                  final t = await showTimePicker(context: context, initialTime: _start);
                  if (t != null) setState(() => _start = t);
                }),
                _tile(Icons.schedule, 'To', _end.format(context), () async {
                  final t = await showTimePicker(context: context, initialTime: _end);
                  if (t != null) setState(() => _end = t);
                }),
                const SizedBox(height: 8),
                TextField(
                  controller: _parcels,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'How many parcels', prefixIcon: Icon(Icons.inventory_2_outlined)),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _note,
                  maxLength: 500,
                  decoration: const InputDecoration(labelText: 'Note for the rider (optional)', counterText: ''),
                ),
                const SizedBox(height: 4),
                const Text('The rider comes to your pickup address. To change the address, use Settings on the merchant panel.', style: TextStyle(color: muted, fontSize: 12.5)),
              ],
            ),
          ),
          if (_error != null) ...[ErrorBox(_error!), const SizedBox(height: 12)],
          BusyButton(label: 'Request pickup', busy: _busy, onPressed: _submit),
        ],
      ),
    );
  }
}
