import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:df_core/df_core.dart';
import 'package:merchant_app/create_order.dart';
import 'package:merchant_app/home.dart';

/// Every screen on real API responses (test/fixtures, saved from a local API with the demo merchants), at a
/// phone's size: layouts must not overflow and the data must show; the order form's AI paste fills the form.
void main() {
  late Map<String, dynamic> fixtures;
  final sent = <String, Map<String, dynamic>>{};

  void useMerchant(String who, String type) {
    fixtures = jsonDecode(File('test/fixtures/$who.json').readAsStringSync()) as Map<String, dynamic>;
    // A pickup request to show (the demo merchants have none).
    fixtures['/merchants/me/pickup-requests'] = {
      'items': [
        {
          'id': '01a17300-0000-7000-8000-000000000001',
          'number': 'PR-2610-0001',
          'date': '2026-10-27',
          'windowStart': '10:00',
          'windowEnd': '13:00',
          'street': 'House 12, Road 104, Gulshan 2, Dhaka',
          'contactName': 'Mehedi Hasan',
          'contactPhone': '+8801911000301',
          'expectedParcels': 5,
          'status': 'REQUESTED',
        },
      ],
      'nextCursor': null,
    };
    fixtures['POST /parcels'] = {'trackingId': 'EC-261026-TEST1'};
    fixtures['/support/tickets'] = {
      'items': [
        {'number': 'DF-SUP-261026-0001', 'subject': 'COD not received', 'category': 'COD / payment', 'status': 'OPEN', 'statusLabel': 'Open', 'lastMessage': {'preview': 'Where is my COD?'}, 'updatedAt': '2026-10-26T08:00:00Z'},
      ],
      'nextCursor': null,
    };
    final m = fixtures['/merchants/me'] as Map<String, dynamic>;
    Session.accessToken = 'test';
    Session.user = {
      'name': 'Owner',
      'merchant': {'id': m['id'], 'name': m['name'], 'type': type},
    };
    sent.clear();
    Api.client = MockClient((req) async {
      var path = req.url.path.replaceFirst(Uri.parse(apiBase).path, '');
      if (path.startsWith('/catalog/place')) path = 'GET /catalog/place';
      final key = req.method == 'POST' ? 'POST $path' : path;
      if (req.method == 'POST') sent[key] = (jsonDecode(req.body) as Map).cast<String, dynamic>();
      final body = fixtures[key] ?? (path.startsWith('/me/notifications/') || path.endsWith('/cancel') ? <String, dynamic>{} : null);
      if (body == null) {
        return http.Response(
          jsonEncode({
            'error': {'code': 'NOT_FOUND', 'message': 'Cannot ${req.method} $path'},
          }),
          404,
        );
      }
      return http.Response.bytes(utf8.encode(jsonEncode(body)), 200, headers: {'content-type': 'application/json'});
    });
  }

  Future<void> phone(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1080, 2340);
    tester.view.devicePixelRatio = 2.75;
    addTearDown(tester.view.reset);
  }

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 12; i++) {
      await tester.pump(const Duration(milliseconds: 400));
    }
  }

  /// Scrolls the page's list until [f] is built and on screen.
  Future<void> scrollTo(WidgetTester tester, Finder f) async {
    await tester.scrollUntilVisible(f, 250, scrollable: find.byType(Scrollable).hitTestable().first);
    await tester.pump();
  }

  Future<void> tab(WidgetTester tester, String label) async {
    await tester.tap(find.descendant(of: find.byType(NavigationBar), matching: find.text(label)));
    await settle(tester);
  }

  testWidgets('e-commerce merchant: dashboard, orders and detail, pickups, balance, account', (tester) async {
    await phone(tester);
    useMerchant('ecom', 'ECOMMERCE');
    await tester.pumpWidget(MaterialApp(navigatorKey: navigatorKey, home: const HomeShell()));
    await settle(tester);
    expect(find.text('Waiting for pickup'), findsOneWidget);
    await scrollTo(tester, find.text('Your money'));
    expect(find.text('Your money'), findsOneWidget);

    await tab(tester, 'Orders');
    expect(find.byTooltip('Scan a parcel'), findsOneWidget);
    final parcel = (fixtures['/parcels']['items'] as List).first as Map;
    expect(find.text('${parcel['trackingId']}'), findsWidgets);
    await tester.tap(find.text('${parcel['trackingId']}').first);
    await settle(tester);
    expect(find.text('Recipient'), findsOneWidget);
    await scrollTo(tester, find.text('Charges'));
    await scrollTo(tester, find.text('Tracking'));
    expect(find.text('Tracking'), findsOneWidget);
    await scrollTo(tester, find.text('Get help with this order'));
    expect(find.text('Get help with this order'), findsOneWidget);
    await tester.pageBack();
    await settle(tester);

    await tab(tester, 'Pickups');
    expect(find.text('PR-2610-0001'), findsOneWidget);

    await tab(tester, 'Balance');
    expect(find.text('Ready to be paid'), findsOneWidget);
    await tester.tap(find.text('Settlements'));
    await settle(tester);
    expect(find.textContaining('ST-'), findsWidgets);
    await tester.tap(find.text('Statement'));
    await settle(tester);
    expect(find.text('Closing balance'), findsOneWidget);

    await tab(tester, 'Account');
    expect(find.textContaining('${fixtures['/merchants/me']['code']}'), findsOneWidget);
    await tester.tap(find.text('Help & support'));
    await settle(tester);
    expect(find.text('COD not received'), findsOneWidget);
    expect(find.text('New request'), findsOneWidget);
    await tester.pageBack();
    await settle(tester);

    await tester.tap(find.byTooltip('Notifications'));
    await settle(tester);
    expect(find.text('Mark all read'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets("e-commerce order: the pasted message fills the form, the price shows, the order is booked", (tester) async {
    await phone(tester);
    useMerchant('ecom', 'ECOMMERCE');
    String? booked;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () async => booked = await Navigator.of(context).push<String>(MaterialPageRoute(builder: (_) => const CreateOrderPage())),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await settle(tester);

    await tester.enterText(find.byType(TextField).first, 'Abdul alim Bashundhara residential area, F block, House 12, Road 15 01785412369 cod 1200');
    await tester.tap(find.text('Fill the form'));
    await settle(tester);
    expect(find.textContaining('Filled: name, phone, full address, COD'), findsOneWidget);
    String fieldText(String label) => (tester.widget<TextField>(find.descendant(of: find.widgetWithText(TextFormField, label), matching: find.byType(TextField))).controller!.text);
    expect(fieldText('Customer name'), 'Abdul alim');
    expect(fieldText('Mobile number'), '01785412369');
    await scrollTo(tester, find.text('Dhaka North'));
    expect(find.text('Dhaka North'), findsOneWidget);
    await scrollTo(tester, find.text('Cash to collect'));
    expect(fieldText('Cash to collect'), '1200');
    expect(sent['POST /packages/quote']?['deliveryDistrict'], 'Dhaka North');

    await tester.tap(find.text('Create order'));
    await settle(tester);
    final body = sent['POST /parcels']!;
    if (Platform.environment['SAVE_ORDER_BODY'] case final path?) File(path).writeAsStringSync(jsonEncode(body));
    expect(body['recipient'], {'name': 'Abdul alim', 'phone': '01785412369'});
    expect(body['codAmount'], 1200);
    expect(body['type'], 'ECOMMERCE');
    expect((body['delivery'] as Map)['district'], 'Dhaka North');
    expect(booked, 'EC-261026-TEST1');
  });

  testWidgets('banking & financial merchant: dashboard, bills and payments; a consignment has no COD', (tester) async {
    await phone(tester);
    useMerchant('doc', 'BANKING_FINANCIAL');
    await tester.pumpWidget(MaterialApp(navigatorKey: navigatorKey, home: const HomeShell()));
    await settle(tester);
    await scrollTo(tester, find.text('Your bills'));
    expect(find.text('Your bills'), findsOneWidget);
    expect(find.text('New consignment'), findsOneWidget);

    await tab(tester, 'Balance');
    expect(find.text('Not billed yet'), findsOneWidget);
    await tester.tap(find.text('Bills'));
    await settle(tester);
    expect(find.textContaining('INV-'), findsWidgets);
    await tester.tap(find.text('Payments'));
    await settle(tester);
    expect(find.textContaining('PAY-'), findsWidgets);

    await tab(tester, 'Home');
    await tester.tap(find.text('New consignment'));
    await settle(tester);
    expect(find.text('Book consignment'), findsOneWidget);
    expect(find.text('Collect cash on delivery (COD)'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}
