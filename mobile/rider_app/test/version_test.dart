import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The version the app sends to the API (X-App-Version, checked against super admin › Mobile apps) must be the
/// pubspec version: otherwise a new APK reports its old version and is told to update forever.
void main() {
  test('AppConfig.version in lib/main.dart matches pubspec.yaml', () {
    final pubspec = RegExp(r'^version:\s*([\d.]+)', multiLine: true).firstMatch(File('pubspec.yaml').readAsStringSync())!.group(1);
    final code = RegExp(r"AppConfig\.version = '([\d.]+)'").firstMatch(File('lib/main.dart').readAsStringSync())?.group(1);
    expect(code, pubspec);
  });
}
