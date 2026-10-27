import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'firebase_options.dart';
import 'home.dart';

/// Delivery Fast Operations: hub operators and operations managers - the day at a glance, the scan desk (camera
/// or handheld scanner), assigning riders, the live map, riders' cash and cash to the central hub, problems.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  configureOpsApp();
  await Push.init(firebaseOptions);
  runApp(const OpsApp());
}

void configureOpsApp() {
  AppConfig.role = 'Operations';
  AppConfig.appName = 'Delivery Fast Operations';
  AppConfig.version = '1.0.0';
  // Courier Operations staff: operations managers and hub operators (and custom roles built on them).
  AppConfig.allows = (user) => user['panel'] == '/courier-operation';
  AppConfig.notAllowed = 'This app is for operations staff (operations managers and hub operators).';
  AppConfig.home = () => OpsShell(key: opsShell);
  onSignedOut = openSignIn;
}

class OpsApp extends StatelessWidget {
  const OpsApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(title: AppConfig.appName, navigatorKey: navigatorKey, debugShowCheckedModeBanner: false, theme: dfTheme(), home: const StartPage());
  }
}
