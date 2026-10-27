import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'home.dart';
import 'ops.dart';
import 'parcels.dart';

enum AssignMode { pickup, delivery }

/// Assign riders: new orders / pickup requests waiting for a pickup rider, or parcels at the hub waiting for a
/// delivery rider. Tick the parcels, choose the rider; each one is assigned (the rider gets a push).
class AssignPage extends StatefulWidget {
  const AssignPage({super.key, required this.mode});
  final AssignMode mode;
  @override
  State<AssignPage> createState() => _AssignPageState();
}

class _AssignPageState extends State<AssignPage> {
  final _loader = GlobalKey<LoaderState<List<Map<String, dynamic>>>>();
  final Set<String> _chosen = {};
  bool _busy = false;

  bool get _pickup => widget.mode == AssignMode.pickup;

  Future<List<Map<String, dynamic>>> _load() async {
    final r = await Api.get('/parcels', {'stage': _pickup ? 'new' : 'delivery_waiting', 'forHubIds': Ops.hubId, 'limit': 200});
    return ((r['items'] as List?) ?? []).cast<Map<String, dynamic>>();
  }

  Future<void> _assign() async {
    final rider = await pickRider(context, title: _pickup ? 'Who picks them up?' : 'Who delivers them?', allHubs: _pickup && Ops.isManager);
    if (rider == null || !mounted) return;
    setState(() => _busy = true);
    var ok = 0;
    final errors = <String>[];
    for (final id in [..._chosen]) {
      try {
        await Api.post('/parcels/${Uri.encodeComponent(id)}/assign-${_pickup ? 'pickup' : 'delivery'}', {'riderId': rider});
        ok++;
        _chosen.remove(id);
      } on ApiError catch (e) {
        errors.add('$id: ${e.message}');
      }
    }
    opsChanged.value++;
    if (!mounted) return;
    setState(() => _busy = false);
    snack(context, errors.isEmpty ? '$ok parcel(s) assigned.' : '$ok assigned · ${errors.length} not: ${errors.first}');
    _loader.currentState?.reload();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_pickup ? 'Assign pickup riders' : 'Assign delivery riders', style: const TextStyle(fontWeight: FontWeight.w800)),
      ),
      floatingActionButton: _chosen.isEmpty
          ? null
          : FloatingActionButton.extended(
              heroTag: 'assign',
              onPressed: _busy ? null : _assign,
              icon: _busy ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.person_add_alt),
              label: Text('Assign ${_chosen.length}'),
            ),
      body: Loader<List<Map<String, dynamic>>>(
        key: _loader,
        load: _load,
        builder: (context, items, reload) {
          if (items.isEmpty) {
            return RefreshIndicator(
              onRefresh: reload,
              child: ListView(
                children: [EmptyView(icon: Icons.task_alt, text: _pickup ? 'No new orders waiting for a pickup rider.' : 'Nothing waiting for a delivery rider at ${Ops.hubName}.')],
              ),
            );
          }
          final all = items.map((p) => '${p['trackingId']}').toSet();
          return RefreshIndicator(
            onRefresh: reload,
            child: ListView(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 96),
              children: [
                CheckboxListTile(
                  value: _chosen.length == all.length,
                  onChanged: (v) => setState(() => v == true ? _chosen.addAll(all) : _chosen.clear()),
                  title: Text('All ${items.length}', style: const TextStyle(fontWeight: FontWeight.w700)),
                ),
                for (final p in items) _row(p),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _row(Map<String, dynamic> p) {
    final id = '${p['trackingId']}';
    final s = (p['sender'] as Map?) ?? {};
    final pu = (p['pickup'] as Map?) ?? {};
    final r = (p['recipient'] as Map?) ?? {};
    final d = (p['delivery'] as Map?) ?? {};
    final place = _pickup ? [pu['area'], pu['zone']] : [d['area'], d['zone']];
    return Panel(
      padding: EdgeInsets.zero,
      child: CheckboxListTile(
        value: _chosen.contains(id),
        onChanged: (v) => setState(() => v == true ? _chosen.add(id) : _chosen.remove(id)),
        title: Text(id, style: const TextStyle(fontWeight: FontWeight.w800)),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(_pickup ? 'From ${(p['merchant'] as Map?)?['name'] ?? s['name'] ?? ''}' : 'To ${r['name'] ?? ''}'),
            Text(place.where((x) => x != null && '$x'.isNotEmpty).join(', '), style: const TextStyle(color: muted)),
            Row(
              children: [
                if (p['onDemand'] == true)
                  const Padding(
                    padding: EdgeInsets.only(right: 6),
                    child: StatusChip('PENDING', label: 'On-demand'),
                  ),
                Expanded(child: Text(dateTimeText(p['createdAt']), overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: muted))),
                TextButton(
                  onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ParcelPage(trackingId: id))),
                  child: const Text('Details'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
