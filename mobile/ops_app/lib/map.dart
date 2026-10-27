import 'dart:async';

import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

import 'ops.dart';
import 'parcels.dart';

/// Live map: riders on shift (GET /ops/rider-locations) and vehicles on the road (GET /vehicle-locations),
/// refreshed every 30 s while the tab is open. This hub's riders, or every hub's. Tap a rider for their load
/// and to call them, a vehicle for its trip.
class MapPage extends StatefulWidget {
  const MapPage({super.key, required this.visible});
  final bool visible;
  @override
  State<MapPage> createState() => _MapPageState();
}

class _MapPageState extends State<MapPage> {
  final _map = MapController();
  List<Map<String, dynamic>> _riders = [];
  List<Map<String, dynamic>> _vehicles = [];
  Map<String, Map<String, dynamic>> _load = {};
  bool _allHubs = false;

  /// The map (and its tiles) is built only once the tab was opened.
  bool _opened = false;
  bool _fitted = false;
  String? _error;
  DateTime? _at;
  Timer? _timer;

  static const _dhaka = LatLng(23.7808, 90.4000);

  @override
  void initState() {
    super.initState();
    if (widget.visible) {
      _opened = true;
      _start();
    }
  }

  @override
  void didUpdateWidget(MapPage old) {
    super.didUpdateWidget(old);
    if (widget.visible && !old.visible) {
      _opened = true;
      _start();
    }
    if (!widget.visible) _timer?.cancel();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _start() {
    _refresh();
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 30), (_) => _refresh());
  }

  Future<void> _refresh() async {
    try {
      final r = await Future.wait([
        Api.get('/ops/rider-locations'),
        Api.get('/vehicle-locations').catchError((_) => <String, dynamic>{'items': []}),
        Api.get('/ops/dispatch').catchError((_) => <String, dynamic>{'roster': []}),
      ]);
      if (!mounted) return;
      setState(() {
        _riders = (((r[0] as Map)['items'] as List?) ?? []).cast<Map<String, dynamic>>();
        _vehicles = (((r[1] as Map)['items'] as List?) ?? []).cast<Map<String, dynamic>>();
        _load = {for (final x in (((r[2] as Map)['roster'] as List?) ?? []).cast<Map<String, dynamic>>()) '${(x['rider'] as Map?)?['id']}': x};
        _at = DateTime.now();
        _error = null;
      });
      if (!_fitted) _fit();
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  List<Map<String, dynamic>> get _shownRiders => _riders.where((r) => _allHubs || Ops.hubId == null || (r['hub'] as Map?)?['id'] == Ops.hubId).toList();

  void _fit() {
    final points = [..._shownRiders, ..._vehicles].where((x) => x['lat'] != null).map((x) => LatLng(toNum(x['lat']).toDouble(), toNum(x['lng']).toDouble())).toList();
    if (points.isEmpty) return;
    _fitted = true;
    try {
      if (points.length == 1) {
        _map.move(points.first, 14);
      } else {
        _map.fitCamera(CameraFit.coordinates(coordinates: points, padding: const EdgeInsets.all(48), maxZoom: 15));
      }
    } catch (_) {
      _fitted = false;
    }
  }

  Color _color(Map<String, dynamic> r) {
    if (r['stale'] == true) return const Color(0xFF98A2B3);
    return r['status'] == 'ON_BREAK' ? warn : good;
  }

  void _riderSheet(Map<String, dynamic> r) {
    final load = _load['${r['riderId']}'];
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('${r['label']}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
              Text('${(r['hub'] as Map?)?['name'] ?? ''} · ${humanize('${r['vehicle']}')} · ${humanize('${r['status']}')}', style: const TextStyle(color: muted)),
              const SizedBox(height: 8),
              KeyValue('Last position', '${dateTimeText(r['at'])}${r['stale'] == true ? ' (old)' : ''}'),
              if (load != null) ...[
                KeyValue('Today', '${count(load['completed'])} done of ${count(load['assignedToday'])}'),
                KeyValue('Still to do', '${count(load['openPickups'])} pickups · ${count(load['openDeliveries'])} deliveries'),
                if (toNum(load['overdue']) > 0) KeyValue('Overdue', count(load['overdue']), color: bad),
                KeyValue('Health', '${load['health'] ?? ''}'),
              ],
              const SizedBox(height: 10),
              if (r['phone'] != null)
                FilledButton.icon(
                  onPressed: () => callPhone(context, '${r['phone']}'),
                  style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(46)),
                  icon: const Icon(Icons.call),
                  label: const Text('Call the rider'),
                ),
            ],
          ),
        ),
      ),
    );
  }

  void _vehicleSheet(Map<String, dynamic> v) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('${v['number']} · ${v['vehicleRegNo'] ?? ''}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
              Text('${v['route'] ?? ''}', style: const TextStyle(color: muted)),
              const SizedBox(height: 8),
              KeyValue('Status', humanize('${v['status']}')),
              if (v['driverName'] != null) KeyValue('Driver', '${v['driverName']}'),
              if (v['departedAt'] != null) KeyValue('Departed', dateTimeText(v['departedAt'])),
              KeyValue('Last position', '${dateTimeText(v['at'])}${v['stale'] == true ? ' (old)' : ''}'),
              if (v['sharedBy'] != null) KeyValue('Shared by', '${v['sharedBy']}'),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (!_opened) return const SizedBox.shrink();
    final riders = _shownRiders.where((r) => r['lat'] != null).toList();
    return Stack(
      children: [
        FlutterMap(
          mapController: _map,
          options: const MapOptions(initialCenter: _dhaka, initialZoom: 11.5),
          children: [
            TileLayer(urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', userAgentPackageName: 'bd.com.pairaexpress.operations'),
            MarkerLayer(
              markers: [
                for (final v in _vehicles.where((v) => v['lat'] != null))
                  Marker(
                    point: LatLng(toNum(v['lat']).toDouble(), toNum(v['lng']).toDouble()),
                    width: 40,
                    height: 40,
                    child: GestureDetector(
                      onTap: () => _vehicleSheet(v),
                      child: CircleAvatar(
                        backgroundColor: v['stale'] == true ? const Color(0xFF98A2B3) : brand,
                        child: const Icon(Icons.local_shipping, color: Colors.white, size: 20),
                      ),
                    ),
                  ),
                for (final r in riders)
                  Marker(
                    point: LatLng(toNum(r['lat']).toDouble(), toNum(r['lng']).toDouble()),
                    width: 40,
                    height: 40,
                    child: GestureDetector(
                      onTap: () => _riderSheet(r),
                      child: CircleAvatar(
                        backgroundColor: _color(r),
                        child: const Icon(Icons.two_wheeler, color: Colors.white, size: 20),
                      ),
                    ),
                  ),
              ],
            ),
            const RichAttributionWidget(attributions: [TextSourceAttribution('OpenStreetMap contributors')]),
          ],
        ),
        Positioned(
          left: 12,
          right: 12,
          top: 12,
          child: Material(
            elevation: 2,
            borderRadius: BorderRadius.circular(12),
            color: Colors.white,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text('${riders.length} rider(s) · ${_vehicles.length} vehicle(s)', style: const TextStyle(fontWeight: FontWeight.w800)),
                        Text(_error ?? (_at == null ? 'Loading…' : 'Updated ${dateTimeText(_at)} · every 30 s'), style: TextStyle(fontSize: 12, color: _error == null ? muted : bad)),
                      ],
                    ),
                  ),
                  FilterChip(
                    label: Text(_allHubs ? 'All hubs' : 'This hub'),
                    selected: _allHubs,
                    onSelected: (v) => setState(() {
                      _allHubs = v;
                      _fitted = false;
                      _fit();
                    }),
                  ),
                  IconButton(tooltip: 'Refresh', onPressed: _refresh, icon: const Icon(Icons.refresh)),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}
