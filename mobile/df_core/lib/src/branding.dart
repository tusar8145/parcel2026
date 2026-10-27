import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import 'api.dart';

/// The company the apps run for (Super admin › Branding & company, GET /branding): its name, logo and contact
/// details inside the apps. The apps' own names and icon are neutral ("Merchant", "Rider", "Operations"), so one
/// build serves any company on its server. The last answer is kept on the phone: the app shows it at once and
/// offline, then brings it up to date.
class Branding {
  static const _storage = FlutterSecureStorage();
  static const _key = 'branding';

  /// The GET /branding answer (null until known).
  static final ValueNotifier<Map<String, dynamic>?> current = ValueNotifier(null);

  /// "Swift Parcel"; empty until known (screens then leave the name out).
  static String get name => '${current.value?['companyName'] ?? ''}'.trim();

  /// "Swift Parcel support" style labels: the name, or [fallback] while it isn't known.
  static String nameOr(String fallback) => name.isEmpty ? fallback : name;

  static Map<String, dynamic> get contact => (current.value?['contact'] as Map?)?.cast<String, dynamic>() ?? const {};

  /// The uploaded logo's full address, or null (the app's own mark is shown).
  static String? get logoUrl {
    final path = current.value?['logoUrl'];
    if (path is! String || path.isEmpty) return null;
    final api = Uri.parse(apiBase);
    return path.startsWith('http') ? path : '${api.scheme}://${api.authority}$path';
  }

  /// Called once at start (main.dart): the kept copy first, then the server's.
  static Future<void> load() async {
    try {
      final kept = await _storage.read(key: _key);
      if (kept != null) current.value = (jsonDecode(kept) as Map).cast<String, dynamic>();
    } catch (_) {}
    try {
      final res = await http.get(Uri.parse('$apiBase/branding')).timeout(const Duration(seconds: 10));
      if (res.statusCode != 200) return;
      final body = (jsonDecode(res.body) as Map).cast<String, dynamic>()..remove('defaults');
      current.value = body;
      await _storage.write(key: _key, value: jsonEncode(body));
    } catch (_) {
      // Offline: the kept copy stays.
    }
  }
}

/// Rebuilds [builder] when the branding changes.
class BrandingBuilder extends StatelessWidget {
  const BrandingBuilder({super.key, required this.builder});
  final Widget Function(BuildContext context) builder;
  @override
  Widget build(BuildContext context) => ValueListenableBuilder<Map<String, dynamic>?>(valueListenable: Branding.current, builder: (context, _, _) => builder(context));
}
