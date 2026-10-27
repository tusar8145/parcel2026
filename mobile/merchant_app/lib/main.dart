import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'firebase_options.dart';
import 'home.dart';

/// Merchant app: E-commerce and Banking & Financial merchants on one app (it adapts to the
/// signed-in merchant's type): orders, pickups, balance, notifications, support and profile.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  configureMerchantApp();
  // The company's name, logo and contact details (kept copy at once, the server's when it answers).
  Branding.load();
  await Push.init(firebaseOptions);
  runApp(const MerchantApp());
}

void configureMerchantApp() {
  AppConfig.role = 'Merchant';
  AppConfig.appName = 'Merchant';
  AppConfig.version = '1.4.0';
  AppConfig.allows = (user) => user['merchant'] != null;
  AppConfig.notAllowed = 'This app is for merchants. Your account is not a merchant account.';
  AppConfig.home = () => const HomeShell();
  onSignedOut = openSignIn;
}

class MerchantApp extends StatelessWidget {
  const MerchantApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(title: AppConfig.appName, navigatorKey: navigatorKey, debugShowCheckedModeBanner: false, theme: dfTheme(), home: const StartPage());
  }
}
