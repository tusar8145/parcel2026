import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

/// The API's address is set when building:
///   flutter build apk --dart-define=API_BASE=https://your-domain/api/v1
const apiBase = String.fromEnvironment('API_BASE', defaultValue: 'https://deliveryfast.imagine-design.net/api/v1');

/// Lets the API client send the user back to sign in when the session has ended.
final navigatorKey = GlobalKey<NavigatorState>();

/// Called when the session can't be renewed (set by main.dart: opens the sign-in page).
void Function()? onSignedOut;

/// The signed-in session: the refresh token kept in the phone's secure storage (Android Keystore).
class Session {
  static const _storage = FlutterSecureStorage();
  static String? accessToken;
  static Map<String, dynamic>? user;
  static Future<bool>? _refreshing;

  static Future<void> save(Map<String, dynamic> body) async {
    accessToken = body['accessToken'] as String?;
    user = (body['user'] as Map<String, dynamic>?) ?? user;
    final refresh = body['refreshToken'] as String?;
    if (refresh != null) await _storage.write(key: 'refreshToken', value: refresh);
  }

  /// Signs in again with the saved refresh token (app restart, expired access token).
  static Future<bool> restore() => _refreshing ??= _restore().whenComplete(() => _refreshing = null);

  static Future<bool> _restore() async {
    final refresh = await _storage.read(key: 'refreshToken');
    if (refresh == null) return false;
    try {
      final body = await Api.post('/auth/refresh', {'refreshToken': refresh}, retry: false);
      await save(body);
      return isMerchant;
    } on ApiError catch (e) {
      // Only a refused token ends the session; no network keeps it for the next try.
      if (e.status != null) await _storage.delete(key: 'refreshToken');
      return false;
    }
  }

  static Future<void> logout() async {
    final refresh = await _storage.read(key: 'refreshToken');
    if (refresh != null) {
      try {
        await Api.post('/auth/logout', {'refreshToken': refresh}, retry: false);
      } catch (_) {}
    }
    await _storage.delete(key: 'refreshToken');
    accessToken = null;
    user = null;
  }

  static Map<String, dynamic>? get merchant => user?['merchant'] as Map<String, dynamic>?;
  static bool get isMerchant => merchant != null;
  static String get merchantName => merchant?['name'] as String? ?? 'Merchant';

  /// Banking & Financial merchants send documents (no COD, weight or products); E-commerce merchants parcels.
  static bool get isDocument => merchant?['type'] == 'BANKING_FINANCIAL' || (user?['panel'] as String? ?? '').contains('banking');
}

/// The API's error ({ error: { code, message } }); status is null when the server couldn't be reached.
class ApiError implements Exception {
  ApiError(this.message, {this.status, this.code});
  final String message;
  final int? status;
  final String? code;

  /// A feature the server doesn't have yet (an older API version).
  bool get notOnServer => status == 404 && code == 'NOT_FOUND' && message.startsWith('Cannot ');

  @override
  String toString() => message;
}

class Api {
  /// The HTTP client (tests put a fake one here).
  static http.Client client = http.Client();

  static Future<dynamic> get(String path, [Map<String, Object?>? query]) => _send('GET', path, query: query);

  static Future<Map<String, dynamic>> post(String path, Map<String, dynamic> body, {Map<String, String>? headers, bool retry = true}) async {
    final data = await _send('POST', path, body: body, headers: headers, retry: retry);
    return data is Map<String, dynamic> ? data : {};
  }

  static Future<dynamic> _send(String method, String path, {Map<String, Object?>? query, Object? body, Map<String, String>? headers, bool retry = true}) async {
    final q = {
      for (final e in (query ?? {}).entries)
        if (e.value != null && '${e.value}'.isNotEmpty) e.key: '${e.value}',
    };
    final uri = Uri.parse('$apiBase$path').replace(queryParameters: q.isEmpty ? null : q);
    http.Response res;
    try {
      final h = {'content-type': 'application/json', 'accept': 'application/json', if (Session.accessToken != null) 'authorization': 'Bearer ${Session.accessToken}', ...?headers};
      final req = method == 'GET' ? client.get(uri, headers: h) : client.post(uri, headers: h, body: jsonEncode(body));
      res = await req.timeout(const Duration(seconds: 25));
    } catch (_) {
      throw ApiError('Could not reach the server. Check the internet connection and try again.');
    }
    // An expired access token: renew it once and repeat the request.
    if (res.statusCode == 401 && retry && Session.accessToken != null) {
      if (await Session.restore()) return _send(method, path, query: query, body: body, headers: headers, retry: false);
      Session.accessToken = null;
      onSignedOut?.call();
      throw ApiError('Your session has ended. Please sign in again.', status: 401);
    }
    if (res.statusCode == 204 || res.bodyBytes.isEmpty) return <String, dynamic>{};
    dynamic data;
    try {
      data = jsonDecode(utf8.decode(res.bodyBytes));
    } catch (_) {
      throw ApiError('The server sent an unexpected reply (${res.statusCode}).', status: res.statusCode);
    }
    if (res.statusCode >= 400) {
      final err = data is Map ? data['error'] : null;
      final message = err is Map ? err['message'] as String? : null;
      throw ApiError(message ?? 'Something went wrong (${res.statusCode}).', status: res.statusCode, code: err is Map ? err['code'] as String? : null);
    }
    return data;
  }

  /// A key for one booking: a retry of the same order reuses it, so it is never booked twice.
  static String newKey() {
    final r = Random.secure();
    return 'app-${DateTime.now().millisecondsSinceEpoch}-${List.generate(12, (_) => r.nextInt(36).toRadixString(36)).join()}';
  }
}

// ── formatting ──

num toNum(Object? v) => v is num ? v : num.tryParse('${v ?? ''}') ?? 0;

/// ৳1,250 (৳1,250.50 with paisa).
String taka(Object? v) {
  final n = toNum(v);
  final neg = n < 0;
  final abs = n.abs();
  final whole = abs.truncate();
  final frac = ((abs - whole) * 100).round();
  final s = whole.toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
  return '${neg ? '-' : ''}৳$s${frac > 0 ? '.${frac.toString().padLeft(2, '0')}' : ''}';
}

String count(Object? v) => toNum(v).round().toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

DateTime? parseDate(Object? v) => v is String && v.isNotEmpty ? DateTime.tryParse(v)?.toLocal() : null;

/// 25 Oct 2026
String dateText(Object? v) {
  final d = v is DateTime ? v : parseDate(v);
  return d == null ? '—' : '${d.day} ${_months[d.month - 1]} ${d.year}';
}

/// 25 Oct, 1:30 PM
String dateTimeText(Object? v) {
  final d = v is DateTime ? v : parseDate(v);
  if (d == null) return '—';
  final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
  final year = d.year == DateTime.now().year ? '' : ' ${d.year}';
  return '${d.day} ${_months[d.month - 1]}$year, $h:${d.minute.toString().padLeft(2, '0')} ${d.hour < 12 ? 'AM' : 'PM'}';
}

/// 2026-10-26 (API dates).
String isoDate(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

/// +8801711000000 → 01711-000000
String phoneText(Object? v) {
  final s = '${v ?? ''}'.replaceFirst(RegExp(r'^\+?880'), '0');
  return s.length == 11 ? '${s.substring(0, 5)}-${s.substring(5)}' : s;
}

/// Phone numbers as the API takes them: 1XXXXXXXXX → 01XXXXXXXXX; spaces and dashes dropped.
String normalizePhone(String v) {
  final digits = v.trim().replaceAll(RegExp(r'[\s\-]'), '');
  if (RegExp(r'^1[3-9]\d{8}$').hasMatch(digits)) return '0$digits';
  return digits;
}

/// A Bangladeshi mobile number (01XXXXXXXXX, 1XXXXXXXXX or +8801…).
bool isBdMobile(String v) => RegExp(r'^(\+?880|0)?1[3-9]\d{8}$').hasMatch(v.trim().replaceAll(RegExp(r'[\s\-]'), ''));

String? phoneError(String? v, {bool required = true}) {
  final t = v?.trim() ?? '';
  if (t.isEmpty) return required ? 'Enter the mobile number' : null;
  return isBdMobile(t) ? null : 'Enter a Bangladeshi mobile number (01XXXXXXXXX)';
}
