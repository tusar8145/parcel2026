import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:geolocator/geolocator.dart';

import 'api.dart';

/// Where the person is while the app is open (super admin › Live map): one position now, then every [every], sent to
/// [path] (rider app off shift: POST /rider/location every 15 minutes; Operations app: POST /staff/location every
/// 2 minutes). Nothing while the app is closed or in the background, nothing while [skip] says so (a rider on shift
/// has the shift tracker). Location access is asked once per app start; refused, nothing is sent.
class Presence with WidgetsBindingObserver {
  Presence._(this.path, this.every, this.skip);

  static Presence? _active;
  final String path;
  final Duration every;
  final bool Function()? skip;
  Timer? _timer;
  bool _asked = false;
  bool _denied = false;

  static void start({required String path, required Duration every, bool Function()? skip}) {
    stop();
    final p = Presence._(path, every, skip);
    _active = p;
    WidgetsBinding.instance.addObserver(p);
    p._resume();
  }

  static void stop() {
    final p = _active;
    if (p == null) return;
    WidgetsBinding.instance.removeObserver(p);
    p._timer?.cancel();
    _active = null;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _resume();
    } else if (state == AppLifecycleState.paused || state == AppLifecycleState.detached || state == AppLifecycleState.hidden) {
      _timer?.cancel();
      _timer = null;
    }
  }

  void _resume() {
    _timer?.cancel();
    unawaited(_send());
    _timer = Timer.periodic(every, (_) => unawaited(_send()));
  }

  Future<void> _send() async {
    if (_denied || Session.accessToken == null || (skip?.call() ?? false)) return;
    try {
      if (!await Geolocator.isLocationServiceEnabled()) return;
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied && !_asked) {
        _asked = true;
        perm = await Geolocator.requestPermission();
      }
      if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
        _denied = perm == LocationPermission.deniedForever;
        return;
      }
      Position? p;
      try {
        p = await Geolocator.getCurrentPosition(locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 15)));
      } catch (_) {
        p = await Geolocator.getLastKnownPosition();
      }
      if (p == null) return;
      await Api.post(path, {
        'lat': p.latitude,
        'lng': p.longitude,
        'accuracy': p.accuracy.clamp(0, 10000),
        if (p.heading >= 0 && p.heading <= 360) 'heading': p.heading,
        if (p.speed >= 0 && p.speed <= 100) 'speed': p.speed,
        'at': p.timestamp.toUtc().toIso8601String(),
      }, retry: true);
    } catch (_) {
      // Best effort: the next tick tries again.
    }
  }
}
