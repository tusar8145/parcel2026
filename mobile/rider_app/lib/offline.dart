import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:df_core/df_core.dart';
import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';
import 'package:path_provider/path_provider.dart';

/// Files of the signed-in rider in the app's private folder: saved screens (read offline), the outbox of
/// actions taken offline and GPS points not sent yet. Signing out deletes them.
class Store {
  static Directory? _dir;

  /// Tests use a temporary folder.
  static Directory? overrideDir;

  static Future<Directory> _folder() async {
    if (overrideDir != null) return overrideDir!;
    final base = _dir ??= await getApplicationDocumentsDirectory();
    final rider = '${Session.rider?['id'] ?? 'none'}';
    final d = Directory('${base.path}${Platform.pathSeparator}rider_$rider');
    if (!await d.exists()) await d.create(recursive: true);
    return d;
  }

  static String _safe(String key) => key.replaceAll(RegExp(r'[^A-Za-z0-9]+'), '_');

  static Future<dynamic> read(String key) async {
    try {
      final f = File('${(await _folder()).path}${Platform.pathSeparator}${_safe(key)}.json');
      if (!await f.exists()) return null;
      return jsonDecode(await f.readAsString());
    } catch (_) {
      return null;
    }
  }

  static Future<void> write(String key, Object? data) async {
    try {
      final f = File('${(await _folder()).path}${Platform.pathSeparator}${_safe(key)}.json');
      await f.writeAsString(jsonEncode(data), flush: true);
    } catch (_) {}
  }

  /// Signing out: everything of this rider goes.
  static Future<void> clear() async {
    try {
      final d = await _folder();
      if (await d.exists()) await d.delete(recursive: true);
    } catch (_) {}
  }
}

/// When the last screen came from the saved copy (no connection), its time; null when live.
final savedAt = ValueNotifier<DateTime?>(null);

/// GET with a saved copy: the server's answer when it can be reached (and saved), else the last saved one.
Future<dynamic> cachedGet(String path, [Map<String, Object?>? query]) async {
  final key = 'get$path${query == null ? '' : jsonEncode(query)}';
  try {
    final data = await Api.get(path, query);
    await Store.write(key, {'at': DateTime.now().toIso8601String(), 'data': data});
    savedAt.value = null;
    return data;
  } on ApiError catch (e) {
    if (e.status != null) rethrow;
    final saved = await Store.read(key);
    if (saved is! Map) rethrow;
    savedAt.value = DateTime.tryParse('${saved['at']}');
    return saved['data'];
  }
}

/// One rider action (pickup, start delivery, delivery outcome, handover, return) waiting to be sent.
class Pending {
  Pending({required this.id, required this.path, required this.body, required this.label, required this.trackingId, required this.kind, required this.createdAt, this.error});
  final String id;
  final String path;
  final Map<String, dynamic> body;
  final String label;
  final String trackingId;

  /// pickup, start, delivered, failed, handover, return
  final String kind;
  final DateTime createdAt;

  /// The server refused it: shown to the rider to review (send again or remove).
  String? error;

  Map<String, dynamic> toJson() => {'id': id, 'path': path, 'body': body, 'label': label, 'trackingId': trackingId, 'kind': kind, 'createdAt': createdAt.toIso8601String(), 'error': error};
  static Pending fromJson(Map<String, dynamic> j) => Pending(
    id: '${j['id']}',
    path: '${j['path']}',
    body: (j['body'] as Map).cast<String, dynamic>(),
    label: '${j['label']}',
    trackingId: '${j['trackingId']}',
    kind: '${j['kind']}',
    createdAt: DateTime.tryParse('${j['createdAt']}') ?? DateTime.now(),
    error: j['error'] as String?,
  );
}

/// How an action went: sent now, or saved to send later.
enum Sent { now, later }

/// The outbox: actions are sent at once when online; without a connection they are saved and sent later in
/// the order they happened, each with its Idempotency-Key (its id), so a repeat is never applied twice.
/// A refusal (409 parcel changed, 403, 422…) keeps the action with the server's message for review.
class Outbox {
  static final items = ValueNotifier<List<Pending>>([]);

  /// Bumped after actions reached the server (lists reload).
  static final synced = ValueNotifier<int>(0);
  static bool _loaded = false;
  static Future<void>? _flushing;
  static Timer? _timer;

  static Future<void> load() async {
    if (_loaded) return;
    _loaded = true;
    final saved = await Store.read('outbox');
    if (saved is List) items.value = [for (final j in saved) Pending.fromJson((j as Map).cast<String, dynamic>())];
    _timer ??= Timer.periodic(const Duration(seconds: 30), (_) => flush());
  }

  static Future<void> _save() => Store.write('outbox', [for (final p in items.value) p.toJson()]);

  static int get waiting => items.value.where((p) => p.error == null).length;
  static List<Pending> get refused => items.value.where((p) => p.error != null).toList();

  /// The latest waiting action of a parcel (its list row shows "Saved, sending when online").
  static Pending? of(String trackingId) {
    for (final p in items.value.reversed) {
      if (p.trackingId == trackingId) return p;
    }
    return null;
  }

  static String newId() {
    final r = Random.secure();
    return 'app-${DateTime.now().millisecondsSinceEpoch}-${List.generate(10, (_) => r.nextInt(36).toRadixString(36)).join()}';
  }

  static bool _retryable(ApiError e) => e.status == null || e.status! >= 500 || e.status == 429;

  /// Sends [p] now, or saves it when there is no connection (or older actions are still waiting: they go first).
  /// A refusal by the server is thrown (the rider sees it at once).
  static Future<Sent> send(Pending p) async {
    await load();
    if (waiting == 0) {
      try {
        await Api.post(p.path, p.body, headers: {'Idempotency-Key': p.id});
        synced.value++;
        return Sent.now;
      } on ApiError catch (e) {
        if (!_retryable(e)) rethrow;
      }
    }
    items.value = [...items.value, p];
    await _save();
    return Sent.later;
  }

  /// Sends the waiting actions in order; stops at the first one that can't get through (no connection).
  static Future<void> flush() => _flushing ??= _flush().whenComplete(() => _flushing = null);

  static Future<void> _flush() async {
    await load();
    var sent = 0;
    for (final p in [...items.value]) {
      if (p.error != null) continue;
      try {
        await Api.post(p.path, p.body, headers: {'Idempotency-Key': p.id});
        items.value = items.value.where((x) => x.id != p.id).toList();
        sent++;
      } on ApiError catch (e) {
        if (_retryable(e) || e.status == 401) break;
        p.error = e.message;
        items.value = [...items.value];
      }
      await _save();
    }
    if (sent > 0) synced.value++;
  }

  /// "Send again" after the rider fixed what was refused (e.g. the parcel was given back).
  static Future<void> retry(Pending p) async {
    p.error = null;
    items.value = [...items.value];
    await _save();
    await flush();
  }

  static Future<void> remove(Pending p) async {
    items.value = items.value.where((x) => x.id != p.id).toList();
    await _save();
  }

  /// Signing out (and tests): forgets the outbox in memory and stops the retry timer.
  static void reset() {
    _timer?.cancel();
    _timer = null;
    items.value = [];
    _loaded = false;
  }
}

/// Live position while on shift: a fix after a move of the configured distance, else every few minutes
/// (GET /settings/location). Runs as a foreground service ("On shift" notification), so it keeps going with
/// the screen off. Points that can't be sent are kept (up to 3,000) and sent together later.
class Tracker {
  static final status = ValueNotifier<String>('Location sharing is off');
  static final on = ValueNotifier<bool>(false);
  static StreamSubscription<Position>? _sub;
  static Position? _lastSent;
  static DateTime _lastSentAt = DateTime(2000);
  static int _intervalMinutes = 5;
  static int _movementMeters = 50;
  static List<Map<String, dynamic>> _points = [];

  /// Asks for location access; false (with the reason in [status]) when it isn't given.
  static Future<bool> permission() async {
    try {
      return await _permission();
    } catch (_) {
      status.value = 'Location is not available on this phone';
      return false;
    }
  }

  static Future<bool> _permission() async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      status.value = 'Turn on the phone\'s location (GPS)';
      return false;
    }
    var p = await Geolocator.checkPermission();
    if (p == LocationPermission.denied) p = await Geolocator.requestPermission();
    if (p == LocationPermission.denied || p == LocationPermission.deniedForever) {
      status.value = 'Allow location access for Delivery Fast Rider in the phone settings';
      return false;
    }
    return true;
  }

  /// The phone's position now (for check-in / proof of delivery); null when not available quickly.
  static Future<Position?> current() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) return null;
      final p = await Geolocator.checkPermission();
      if (p == LocationPermission.denied || p == LocationPermission.deniedForever) return null;
      return await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 12)),
      );
    } catch (_) {
      try {
        return await Geolocator.getLastKnownPosition();
      } catch (_) {
        return null;
      }
    }
  }

  static Future<void> start() async {
    if (_sub != null) return;
    if (!await permission()) return;
    try {
      final s = await cachedGet('/settings/location') as Map;
      _intervalMinutes = toNum(s['intervalMinutes']).toInt().clamp(1, 60);
      _movementMeters = toNum(s['movementMeters']).toInt().clamp(10, 5000);
    } catch (_) {}
    final saved = await Store.read('points');
    if (saved is List) _points = saved.cast<Map>().map((m) => m.cast<String, dynamic>()).toList();
    final settings = defaultTargetPlatform == TargetPlatform.android
        ? AndroidSettings(
            accuracy: LocationAccuracy.high,
            intervalDuration: const Duration(seconds: 30),
            foregroundNotificationConfig: const ForegroundNotificationConfig(
              notificationTitle: 'Delivery Fast: on shift',
              notificationText: 'Sharing your location with operations while you are on shift.',
              enableWakeLock: true,
              setOngoing: true,
            ),
          )
        : const LocationSettings(accuracy: LocationAccuracy.high);
    _sub = Geolocator.getPositionStream(locationSettings: settings).listen(_onFix, onError: (_) => status.value = 'Location not available');
    on.value = true;
    status.value = 'Location sharing is on';
  }

  static Future<void> stop() async {
    await _sub?.cancel();
    _sub = null;
    on.value = false;
    status.value = 'Location sharing is off (shift ended)';
  }

  static Future<void> _onFix(Position p) async {
    final moved = _lastSent == null ? double.infinity : Geolocator.distanceBetween(_lastSent!.latitude, _lastSent!.longitude, p.latitude, p.longitude);
    final due = DateTime.now().difference(_lastSentAt) >= Duration(minutes: _intervalMinutes);
    if (moved < _movementMeters && !due) return;
    _lastSent = p;
    _lastSentAt = DateTime.now();
    final point = {
      'lat': p.latitude,
      'lng': p.longitude,
      'accuracy': p.accuracy.clamp(0, 10000),
      if (p.heading >= 0 && p.heading <= 360) 'heading': p.heading,
      if (p.speed >= 0 && p.speed <= 100) 'speed': p.speed,
      'at': (p.timestamp).toUtc().toIso8601String(),
    };
    try {
      await Api.post('/rider/location', point);
      status.value = 'Location sharing is on · sent ${_clock(DateTime.now())}';
      await _sendSaved();
    } on ApiError {
      _points = [..._points, point];
      if (_points.length > 3000) _points = _points.sublist(_points.length - 3000);
      await Store.write('points', _points);
      status.value = 'Location saved on the phone (${_points.length}) · will send when online';
    }
  }

  /// Points kept while offline, 500 at a time.
  static Future<void> _sendSaved() async {
    while (_points.isNotEmpty) {
      final batch = _points.take(500).toList();
      await Api.post('/rider/location/batch', {'points': batch});
      _points = _points.skip(batch.length).toList();
      await Store.write('points', _points);
    }
  }

  static String _clock(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}
