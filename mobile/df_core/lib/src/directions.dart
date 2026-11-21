import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'widgets.dart';

/// Directions in Google Maps (the app when installed, else the browser) from where the phone is now, to the map
/// position, or to the address when there is no position.
Future<void> openDirections(BuildContext context, {double? lat, double? lng, String? address}) async {
  final to = lat != null && lng != null ? '$lat,$lng' : (address ?? '').trim();
  if (to.isEmpty) return snack(context, 'No location for this place yet.');
  final uri = Uri.https('www.google.com', '/maps/dir/', {'api': '1', 'destination': to, 'travelmode': 'driving'});
  for (final mode in [LaunchMode.externalNonBrowserApplication, LaunchMode.externalApplication, LaunchMode.platformDefault]) {
    try {
      if (await launchUrl(uri, mode: mode)) return;
    } catch (_) {}
  }
  if (context.mounted) snack(context, 'Could not open Google Maps.');
}
