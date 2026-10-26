import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

/// Calls a number with the phone's dialer (+880… numbers are dialled as 01…).
Future<void> callPhone(BuildContext context, String phone) async {
  final number = phone.replaceFirst(RegExp(r'^\+?880'), '0');
  if (!await launchUrl(Uri(scheme: 'tel', path: number)) && context.mounted) snack(context, 'Could not open the dialer. Call $number.');
}

/// Opens an address in Google Maps (or the phone's map app) for directions.
Future<void> openMap(BuildContext context, String address) async {
  final uri = Uri.https('www.google.com', '/maps/search/', {'api': '1', 'query': address});
  if (!await launchUrl(uri, mode: LaunchMode.externalApplication) && context.mounted) snack(context, 'Could not open the map.');
}
