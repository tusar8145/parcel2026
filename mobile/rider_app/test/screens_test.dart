import 'dart:convert';
import 'dart:io';

import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:rider_app/actions.dart';
import 'package:rider_app/home.dart';
import 'package:rider_app/main.dart';
import 'package:rider_app/offline.dart';

/// The rider app on real API responses (test/fixtures/rider.json, saved from a local API: the demo rider with
/// two pickups and one delivery), at a phone's size, with the server online or unreachable.
void main() {
  late Map<String, dynamic> fixtures;
  final sent = <String, Map<String, dynamic>>{};
  final keys = <String, String>{};
  var online = true;

  setUp(() async {
    fixtures = jsonDecode(File('test/fixtures/rider.json').readAsStringSync()) as Map<String, dynamic>;
    configureRiderApp();
    final me = fixtures['/auth/me'] as Map<String, dynamic>;
    Session.user = me;
    Session.accessToken = 'test';
    Store.overrideDir = await Directory.systemTemp.createTemp('rider_test');
    Outbox.reset();
    Tasks.data.value = null;
    savedAt.value = null;
    sent.clear();
    keys.clear();
    online = true;
    Api.client = MockClient((req) async {
      if (!online) throw http.ClientException('offline');
      final path = req.url.path.replaceFirst(Uri.parse(apiBase).path, '');
      final key = req.method == 'GET' ? path : '${req.method} $path';
      if (req.method != 'GET') {
        sent[key] = req.body.isEmpty ? {} : (jsonDecode(req.body) as Map).cast<String, dynamic>();
        if (req.headers['Idempotency-Key'] != null) keys[key] = req.headers['Idempotency-Key']!;
        return http.Response.bytes(utf8.encode(jsonEncode(fixtures[key] ?? {'ok': true})), 200, headers: {'content-type': 'application/json'});
      }
      final body = fixtures[key];
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

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 10; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump(const Duration(milliseconds: 300));
    }
  }

  /// Pumps (letting real file and network work finish) until [f] is on screen, up to ~10 s.
  Future<void> waitFor(WidgetTester tester, Finder f) async {
    for (var i = 0; i < 50 && f.evaluate().isEmpty; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 40)));
      await tester.pump(const Duration(milliseconds: 200));
    }
  }

  Future<void> scrollTo(WidgetTester tester, Finder f) async {
    await tester.scrollUntilVisible(f, 250, scrollable: find.byType(Scrollable).hitTestable().first);
    await tester.pump();
  }

  Future<void> tab(WidgetTester tester, String label) async {
    await tester.tap(find.descendant(of: find.byType(NavigationBar), matching: find.text(label)));
    await settle(tester);
  }

  Future<void> open(WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(navigatorKey: navigatorKey, theme: dfTheme(), home: const RiderShell()));
    await waitFor(tester, find.text('Pickups to do'));
    await settle(tester);
  }

  Map<String, dynamic> firstPickup() => ((fixtures['/rider/tasks']['pickups'] as List).first as Map).cast<String, dynamic>();
  Map<String, dynamic> delivery() => ((fixtures['/rider/tasks']['deliveries'] as List).first as Map).cast<String, dynamic>();

  testWidgets('today, pickups (collect one), deliveries, cash with a slip, account and support', (tester) async {
    await phone(tester);
    fixtures['/rider/my-cash'] = {
      ...(fixtures['/rider/my-cash'] as Map).cast<String, dynamic>(),
      'cod': 950,
      'total': 950,
      'parcels': [
        {'trackingId': 'EP-261026-AAAAA', 'recipient': 'Karim Mia', 'amount': 950, 'collectedAt': '2026-10-26T08:00:00Z', 'partial': false, 'onSlip': true},
      ],
      'slip': {
        'id': 's1',
        'number': 'HS-2610-0001',
        'status': 'OPEN',
        'parcels': 1,
        'expected': 950,
        'hub': {'id': 'h', 'name': 'Dhanmondi Hub'},
      },
    };
    await open(tester);
    expect(find.text('Pickups to do'), findsOneWidget);
    expect(find.text('Start shift').evaluate().isNotEmpty || find.text('End shift').evaluate().isNotEmpty, isTrue);

    await tab(tester, 'Pickups');
    final stop = (firstPickup()['pickupStop'] as Map)['name'];
    expect(find.text('$stop'), findsOneWidget);
    expect(find.text('2 parcel(s) to collect'), findsOneWidget);
    await tester.tap(find.text('Collect'));
    await settle(tester);
    expect(find.text('Expected'), findsOneWidget);
    // Collected without a scan (the popup menu), sent at once with the stop and an Idempotency-Key.
    await tester.tap(find.byType(PopupMenuButton<String>).first);
    await settle(tester);
    await tester.tap(find.text('Collected (no scan)'));
    await settle(tester);
    final id = firstPickup()['trackingId'];
    expect(sent['POST /rider/parcels/$id/pickup'], {'outcome': 'COLLECTED', 'expectedStop': (firstPickup()['pickupStop'] as Map)['key']});
    expect(keys['POST /rider/parcels/$id/pickup'], startsWith('app-'));
    await tester.pageBack();
    await settle(tester);

    await tab(tester, 'Deliveries');
    await waitFor(tester, find.text('${delivery()['trackingId']}'));
    expect(find.text('${delivery()['trackingId']}'), findsOneWidget);
    await tester.tap(find.text('${delivery()['trackingId']}'));
    await settle(tester);
    expect(find.text('Start delivery'), findsOneWidget);
    await tester.tap(find.text('Start delivery'));
    await settle(tester);
    expect(sent.containsKey('POST /rider/parcels/${delivery()['trackingId']}/start-delivery'), isTrue);
    await tester.pageBack();
    await settle(tester);

    await tab(tester, 'Account');
    await tester.tap(find.text('My cash'));
    await waitFor(tester, find.text('HS-2610-0001'));
    expect(find.text('HS-2610-0001'), findsOneWidget);
    expect(find.byType(Code128Barcode), findsOneWidget);
    await tester.pageBack();
    await settle(tester);

    await tab(tester, 'Account');
    await scrollTo(tester, find.text('Help & support'));
    expect(find.text('Help & support'), findsOneWidget);
    await tester.tap(find.text('Help & support'));
    await waitFor(tester, find.text('New request'));
    await settle(tester);
    final ticket = (fixtures['/support/tickets']['items'] as List).first as Map;
    expect(find.text('${ticket['subject']}'), findsOneWidget);
    await tester.tap(find.text('${ticket['subject']}'));
    await settle(tester);
    expect(find.text('Write a reply'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    Outbox.reset();
  });

  testWidgets('a failed delivery made offline is saved, shown as saved, and sent when back online', (tester) async {
    await phone(tester);
    await open(tester); // online first: the screens are saved on the phone
    online = false;
    await tab(tester, 'Deliveries');
    final id = '${delivery()['trackingId']}';
    await waitFor(tester, find.text(id));
    await tester.tap(find.text(id));
    await settle(tester);
    await scrollTo(tester, find.text('Could not deliver'));
    await tester.tap(find.text('Could not deliver'));
    await settle(tester);
    await tester.tap(find.text('Recipient unavailable'));
    await tester.pump();
    await tester.tap(find.text('Save'));
    await settle(tester);
    expect(Outbox.items.value.length, 1);
    expect(Outbox.items.value.first.body, {'outcome': 'FAILED', 'reason': 'Recipient unavailable', 'nextAction': 'RETRY'});
    expect(find.text('Saved · sends when online'), findsOneWidget);

    online = true;
    await tester.runAsync(Outbox.flush);
    await settle(tester);
    expect(Outbox.items.value, isEmpty);
    expect(sent['POST /rider/parcels/$id/delivery']?['reason'], 'Recipient unavailable');
    await tester.pumpWidget(const SizedBox());
    Outbox.reset();
  });

  testWidgets('opened without a connection, the app shows what was saved', (tester) async {
    await phone(tester);
    await open(tester);
    await tester.pumpWidget(const SizedBox());
    Outbox.reset();
    online = false;
    Tasks.data.value = null;
    await open(tester);
    expect(savedAt.value, isNotNull);
    expect(find.textContaining('Offline · showing what was saved'), findsOneWidget);
    expect(find.text('Pickups to do'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    Outbox.reset();
  });

  testWidgets('scan tab: the tasks are listed; a scan starts a delivery once and refuses parcels not on the list', (tester) async {
    await phone(tester);
    await open(tester);
    await tab(tester, 'Scan');
    for (final t in ['Pickup from merchant', 'Hand over at hub', 'Start deliveries', 'Deliver', 'Could not deliver', 'Return to merchant']) {
      await scrollTo(tester, find.text(t));
      expect(find.text(t), findsOneWidget);
    }
    final id = '${delivery()['trackingId']}';
    final ok = (await tester.runAsync(() => startDelivery(id)))!;
    expect(ok.ok, isTrue);
    expect(sent.containsKey('POST /rider/parcels/$id/start-delivery'), isTrue);
    final unknown = (await tester.runAsync(() => startDelivery('EP-000000-NOPE1')))!;
    expect(unknown.ok, isFalse);
    expect(unknown.message, contains('not one of your deliveries'));
    final stop = ((firstPickup()['pickupStop'] as Map)).cast<String, dynamic>();
    final collected = (await tester.runAsync(() => collectParcel(stop, '${firstPickup()['trackingId']}')))!;
    expect(collected.ok, isTrue);
    expect(sent['POST /rider/parcels/${firstPickup()['trackingId']}/pickup']?['expectedStop'], stop['key']);
    await tester.pumpWidget(const SizedBox());
    Outbox.reset();
  });
}
