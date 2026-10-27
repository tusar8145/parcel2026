import 'dart:convert';
import 'dart:io';

import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:ops_app/home.dart';
import 'package:ops_app/main.dart';
import 'package:ops_app/ops.dart';
import 'package:ops_app/scan.dart';

/// The operations app on real API responses (test/fixtures/ops.json, saved from a local API: the demo operations
/// manager at Dhanmondi Hub), at a phone's size.
void main() {
  late Map<String, dynamic> fixtures;
  final sent = <String, Map<String, dynamic>>{};

  setUp(() {
    fixtures = jsonDecode(File('test/fixtures/ops.json').readAsStringSync()) as Map<String, dynamic>;
    configureOpsApp();
    Session.user = fixtures['/auth/me'] as Map<String, dynamic>;
    Session.accessToken = 'test';
    Ops.reset();
    final hubs = (((fixtures['/ops/overview'] as Map)['hubs'] as List).cast<Map<String, dynamic>>());
    Ops.hub.value = hubs.firstWhere((h) => h['code'] == 'DHK-DHN');
    sent.clear();
    Api.client = MockClient((req) async {
      final path = req.url.path.replaceFirst(Uri.parse(apiBase).path, '');
      if (req.method != 'GET') {
        sent['${req.method} $path'] = req.body.isEmpty ? {} : (jsonDecode(req.body) as Map).cast<String, dynamic>();
        final ok = path.startsWith('/hub-desk/') || path == '/ops/hub-receive' ? {'ok': true, 'outcome': 'DONE', 'message': 'Done: ${jsonDecode(req.body)['code']}'} : {'ok': true};
        return http.Response.bytes(utf8.encode(jsonEncode(ok)), 200, headers: {'content-type': 'application/json'});
      }
      final body = fixtures[path] ?? (path.startsWith('/me/notifications') ? {'unread': 0, 'items': []} : null);
      if (body == null) {
        return http.Response(
          jsonEncode({
            'error': {'code': 'NOT_FOUND', 'message': 'Cannot GET $path'},
          }),
          404,
        );
      }
      return http.Response.bytes(utf8.encode(jsonEncode(body)), 200, headers: {'content-type': 'application/json'});
    });
  });

  Future<void> phone(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1080, 2340);
    tester.view.devicePixelRatio = 2.75;
    addTearDown(tester.view.reset);
  }

  Future<void> waitFor(WidgetTester tester, Finder f) async {
    for (var i = 0; i < 50 && f.evaluate().isEmpty; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 40)));
      await tester.pump(const Duration(milliseconds: 200));
    }
  }

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 8; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump(const Duration(milliseconds: 250));
    }
  }

  Future<void> tab(WidgetTester tester, String label) async {
    await tester.tap(find.descendant(of: find.byType(NavigationBar), matching: find.text(label)));
    await settle(tester);
  }

  testWidgets('today, assigning a pickup rider to the new orders, the scan desk, cash and more', (tester) async {
    await phone(tester);
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: navigatorKey,
        theme: dfTheme(),
        home: OpsShell(key: opsShell),
      ),
    );
    await waitFor(tester, find.text('New orders to assign'));
    expect(find.text('Dhanmondi Hub'), findsOneWidget);
    expect(find.text('Riders'), findsOneWidget);

    // New orders → tick all → assign a rider.
    await tester.tap(find.text('New orders to assign'));
    await waitFor(tester, find.textContaining('All '));
    final orders = (fixtures['/parcels'] as Map)['items'] as List;
    await tester.tap(find.text('All ${orders.length}'));
    await settle(tester); // the Assign button animates in
    await tester.tap(find.text('Assign ${orders.length}'));
    await waitFor(tester, find.text('Who picks them up?'));
    await settle(tester); // the sheet slides up
    final rider = ((fixtures['/riders'] as List).first as Map);
    await tester.tap(find.textContaining('${rider['label']}').first);
    await settle(tester);
    expect(sent['POST /parcels/${(orders.first as Map)['trackingId']}/assign-pickup'], {'riderId': rider['id']});
    await tester.pageBack();
    await settle(tester);

    await tab(tester, 'Scan');
    for (final t in ['Receive at hub', 'Out for delivery', 'Pickup entry', 'Transfer out', 'Delivery entry']) {
      expect(find.text(t), findsOneWidget);
    }
    final r = (await tester.runAsync(() => deskScan('/ops/hub-receive', {'code': 'PP-261024-RSDM2', 'hubId': Ops.hubId, 'source': 'CAMERA'})))!;
    expect(r.ok, isTrue);
    expect(sent['POST /ops/hub-receive'], {'code': 'PP-261024-RSDM2', 'hubId': Ops.hubId, 'source': 'CAMERA'});

    await tab(tester, 'Cash');
    final cashRider = (((fixtures['/cash/riders'] as Map)['items'] as List).first as Map);
    await waitFor(tester, find.textContaining('${cashRider['code']}'));
    expect(find.text(taka(cashRider['total'])), findsOneWidget);
    await tester.tap(find.text('Hub cash'));
    await settle(tester);
    expect(find.textContaining('central hub'), findsWidgets);

    await tab(tester, 'More');
    expect(find.text('Assign delivery riders'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('Help & support'), 200, scrollable: find.byType(Scrollable).hitTestable().first);
    expect(find.text('Help & support'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a parcel opens with its tracking history and the assign button', (tester) async {
    await phone(tester);
    final id = (((fixtures['/parcels'] as Map)['items'] as List).first as Map)['trackingId'];
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: navigatorKey,
        theme: dfTheme(),
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(onPressed: () => openOpsNotification(context, {'title': 'New pickup: $id', 'type': 'parcel.x'}), child: const Text('open')),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await waitFor(tester, find.text('Tracking'));
    expect(find.text('Tracking'), findsOneWidget);
    expect(find.text('Assign pickup rider'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
