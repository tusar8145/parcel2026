import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:url_launcher/url_launcher.dart';

import 'offline.dart';

/// Best route: the rider's open stops in the best order (GET / POST /rider/route, the same planner as Courier
/// Operations › Route planner). The delivery list follows today's plan; "Best route" plans again from where the rider
/// is now; "Open in Google Maps" navigates through the next stops in that order.
class RoutePlan {
  static final data = ValueNotifier<Map<String, dynamic>?>(null);

  static List<Map<String, dynamic>> get stops => ((data.value?['stops'] as List?) ?? []).cast<Map<String, dynamic>>();

  /// The stop number of each parcel in today's plan.
  static Map<String, int> get seq => {for (final s in stops) '${s['trackingId']}': toNum(s['seq']).toInt()};

  static Future<void> load() async {
    try {
      final r = (await cachedGet('/rider/route')) as Map;
      data.value = (r['plan'] as Map?)?.cast<String, dynamic>();
    } catch (_) {}
  }

  /// [parcels] in plan order: planned stops by stop number, the others after them as they were.
  static List<Map<String, dynamic>> sorted(List<Map<String, dynamic>> parcels) {
    final order = seq;
    final planned = parcels.where((p) => order.containsKey('${p['trackingId']}')).toList()
      ..sort((a, b) => order['${a['trackingId']}']!.compareTo(order['${b['trackingId']}']!));
    return [...planned, ...parcels.where((p) => !order.containsKey('${p['trackingId']}'))];
  }
}

/// The phone's position, or null (no permission, location off, too slow).
Future<Position?> _here() async {
  try {
    if (!await Geolocator.isLocationServiceEnabled()) return null;
    var p = await Geolocator.checkPermission();
    if (p == LocationPermission.denied) p = await Geolocator.requestPermission();
    if (p == LocationPermission.denied || p == LocationPermission.deniedForever) return null;
    return await Geolocator.getCurrentPosition(locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 12)));
  } catch (_) {
    return await Geolocator.getLastKnownPosition().catchError((_) => null);
  }
}

/// Plans the best order from where the rider is now; true when a plan came back.
Future<bool> planBestRoute(BuildContext context) async {
  showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (_) => const AlertDialog(
      content: Row(
        children: [
          CircularProgressIndicator(),
          SizedBox(width: 16),
          Expanded(child: Text('Finding the best route… Addresses not on the map yet are looked up first; this can take a minute.')),
        ],
      ),
    ),
  );
  try {
    final pos = await _here();
    final r = await Api.post('/rider/route', {if (pos != null) 'lat': pos.latitude, if (pos != null) 'lng': pos.longitude});
    if (context.mounted) Navigator.of(context).pop();
    final plan = (r['plan'] as Map?)?.cast<String, dynamic>();
    if (plan == null) {
      if (context.mounted) snack(context, '${r['message'] ?? 'No route could be planned.'}');
      return false;
    }
    RoutePlan.data.value = plan;
    final unlocated = ((r['unlocated'] as List?) ?? []).length;
    final km = (toNum(plan['distanceMeters']) / 1000).toStringAsFixed(1);
    final min = (toNum(plan['durationSeconds']) / 60).round();
    if (context.mounted) {
      snack(
        context,
        '${RoutePlan.stops.length} stops in order · about $km km, $min min${pos == null ? ' (from your last known place: turn on location for a better start)' : ''}'
        '${unlocated > 0 ? ' · $unlocated not on the map, at the end of the list' : ''}',
      );
    }
    return true;
  } catch (e) {
    if (context.mounted) {
      Navigator.of(context).pop();
      snack(context, errorText(e));
    }
    return false;
  }
}

/// Google Maps directions through the next stops (in plan order) of [openTrackingIds]; Maps takes up to 9 stops on the way.
Future<void> openRouteInMaps(BuildContext context, List<String> openTrackingIds) async {
  final open = openTrackingIds.toSet();
  final stops = RoutePlan.stops.where((s) => open.contains('${s['trackingId']}') && s['lat'] is num && s['lng'] is num).take(10).toList();
  if (stops.isEmpty) return snack(context, 'Tap "Best route" first.');
  String at(Map<String, dynamic> s) => '${s['lat']},${s['lng']}';
  final uri = Uri.https('www.google.com', '/maps/dir/', {
    'api': '1',
    'destination': at(stops.last),
    if (stops.length > 1) 'waypoints': stops.sublist(0, stops.length - 1).map(at).join('|'),
    'travelmode': 'driving',
  });
  if (!await launchUrl(uri, mode: LaunchMode.externalApplication) && context.mounted) snack(context, 'Could not open Google Maps.');
}

/// Directions to one stop.
Future<void> navigateTo(BuildContext context, num lat, num lng) async {
  final uri = Uri.https('www.google.com', '/maps/dir/', {'api': '1', 'destination': '$lat,$lng', 'travelmode': 'driving'});
  if (!await launchUrl(uri, mode: LaunchMode.externalApplication) && context.mounted) snack(context, 'Could not open Google Maps.');
}
