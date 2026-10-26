import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'home.dart';
import 'offline.dart';

/// Delivery Fast Rider: the rider's day (shift and live location, pickups with scanning, deliveries with
/// proof and COD, cash handover, returns) that keeps working without a connection, and support.
void main() {
  configureRiderApp();
  runApp(const RiderApp());
}

void configureRiderApp() {
  AppConfig.role = 'Rider';
  AppConfig.appName = 'Delivery Fast Rider';
  AppConfig.version = '1.0.0';
  AppConfig.allows = (user) => user['rider'] != null;
  AppConfig.notAllowed = 'This app is for riders. Your account is not a rider account.';
  AppConfig.home = () => const RiderShell();
  onSignedOut = openSignIn;
}

/// Signing out also deletes the rider's saved screens, outbox and GPS points from the phone.
Future<void> riderSignOut() async {
  await Tracker.stop();
  await Store.clear();
  Outbox.reset();
  await Session.logout();
}

class RiderApp extends StatelessWidget {
  const RiderApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(title: AppConfig.appName, navigatorKey: navigatorKey, debugShowCheckedModeBanner: false, theme: dfTheme(), home: const StartPage());
  }
}
